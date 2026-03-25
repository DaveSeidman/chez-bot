import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { getOpenAIClient } from './openai.js';
import {
  classifyMessageIntent,
  findAmbiguousStoreMatches,
  getDocsByIds,
  getManualDataPath,
  hasConfidentMatch,
  loadDocs,
  resolveStoreFromReply,
  retrieveRelevantDocs,
} from './retrieve.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../');
const webDistPath = path.join(repoRoot, 'apps/web/dist');
const webIndexPath = path.join(webDistPath, 'index.html');
const adminCookieName = 'chez_ops_admin_session';
const adminSessionDurationMs = 1000 * 60 * 60 * 12;

const rootEnvPath = path.join(repoRoot, '.env');
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  dotenv.config();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function formatStoreLabel(doc) {
  return doc.location ? `${doc.storeName} (${doc.location})` : doc.storeName;
}

function buildClarificationMeta(candidateStores, originalQuestion) {
  return {
    type: 'store-clarification',
    originalQuestion,
    candidateStoreIds: candidateStores.map((doc) => doc.id),
  };
}

function buildClarificationResponse(candidateStores, originalQuestion, intro) {
  return {
    answer: `${intro} ${candidateStores.map(formatStoreLabel).join(' or ')}?`,
    sources: [],
    meta: buildClarificationMeta(candidateStores, originalQuestion),
    matchedDocs: candidateStores.map((doc) => ({
      id: doc.id,
      storeName: doc.storeName,
      snippet: doc.content.slice(0, 220) + (doc.content.length > 220 ? '…' : ''),
    })),
  };
}

function getAdminConfig() {
  const username = process.env.ADMIN_USERNAME || '';
  const password = process.env.ADMIN_PASSWORD || '';
  const sessionSecret = process.env.ADMIN_SESSION_SECRET || '';

  return {
    username,
    password,
    sessionSecret,
    isConfigured: Boolean(username && password && sessionSecret),
  };
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex < 0) {
        return cookies;
      }

      const key = decodeURIComponent(part.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signAdminPayload(encodedPayload, sessionSecret) {
  return crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url');
}

function createAdminSessionToken(username, sessionSecret) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      expiresAt: Date.now() + adminSessionDurationMs,
    }),
    'utf8',
  ).toString('base64url');

  return `${payload}.${signAdminPayload(payload, sessionSecret)}`;
}

function verifyAdminSessionToken(token, config) {
  if (!token || !config.isConfigured) {
    return null;
  }

  const [encodedPayload, signature] = String(token).split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signAdminPayload(encodedPayload, config.sessionSecret);
  if (!safeCompare(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (payload.expiresAt <= Date.now()) {
      return null;
    }

    if (!safeCompare(payload.username, config.username)) {
      return null;
    }

    return {
      username: payload.username,
      expiresAt: payload.expiresAt,
    };
  } catch (_error) {
    return null;
  }
}

function setAdminSessionCookie(res, token) {
  const cookieParts = [
    `${adminCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(adminSessionDurationMs / 1000)}`,
  ];

  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAdminSessionCookie(res) {
  const cookieParts = [`${adminCookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];

  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function getAdminSession(req) {
  const config = getAdminConfig();
  const cookies = parseCookies(req.headers.cookie);
  return verifyAdminSessionToken(cookies[adminCookieName], config);
}

function requireAdminAuth(req, res, next) {
  const config = getAdminConfig();
  if (!config.isConfigured) {
    return res.status(503).json({ error: 'Admin access is not configured.' });
  }

  const session = getAdminSession(req);
  if (!session) {
    clearAdminSessionCookie(res);
    return res.status(401).json({ error: 'Authentication required.' });
  }

  req.adminUser = session.username;
  return next();
}

function getPendingClarification(history) {
  const lastAssistantMessage = history[history.length - 1];
  if (!lastAssistantMessage || lastAssistantMessage.role !== 'assistant') {
    return null;
  }

  const meta = lastAssistantMessage.meta;
  if (!meta || meta.type !== 'store-clarification' || !Array.isArray(meta.candidateStoreIds) || !meta.originalQuestion) {
    return null;
  }

  const candidateStores = getDocsByIds(meta.candidateStoreIds);
  if (!candidateStores.length) {
    return null;
  }

  return {
    originalQuestion: meta.originalQuestion,
    candidateStores,
  };
}

function buildEffectiveQuestion(message, history) {
  const pendingClarification = getPendingClarification(history);
  if (!pendingClarification) {
    return {
      effectiveQuestion: message,
      selectedStore: null,
      pendingClarification: null,
    };
  }

  const selectedStore = resolveStoreFromReply(message, pendingClarification.candidateStores);
  if (!selectedStore) {
    return {
      effectiveQuestion: message,
      selectedStore: null,
      pendingClarification,
    };
  }

  return {
    effectiveQuestion: `${pendingClarification.originalQuestion}\nThe user clarified they meant ${formatStoreLabel(selectedStore)}.`,
    selectedStore,
    pendingClarification,
  };
}

function prioritizeSelectedStore(docs, selectedStore) {
  if (!selectedStore) {
    return docs;
  }

  const withoutSelectedStore = docs.filter((doc) => doc.id !== selectedStore.id);
  return [selectedStore, ...withoutSelectedStore].slice(0, 4);
}

function buildCasualRedirectResponse() {
  return {
    answer:
      'Hi. I can help with Chez Chrystelle business questions like deliveries, store instructions, invoices, timing, returns, and route details.',
    sources: [],
    matchedDocs: [],
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stores', (_req, res) => {
  const stores = loadDocs()
    .filter((doc) => doc.type === 'store')
    .map((doc) => ({
      id: doc.id,
      storeName: doc.storeName,
      location: doc.location,
      summary: doc.content.slice(0, 180) + (doc.content.length > 180 ? '…' : ''),
    }));

  res.json({ stores });
});

app.get('/api/admin/session', (req, res) => {
  const config = getAdminConfig();
  if (!config.isConfigured) {
    return res.json({
      configured: false,
      authenticated: false,
    });
  }

  const session = getAdminSession(req);
  return res.json({
    configured: true,
    authenticated: Boolean(session),
    username: session?.username || null,
  });
});

app.post('/api/admin/login', (req, res) => {
  const config = getAdminConfig();
  if (!config.isConfigured) {
    return res.status(503).json({ error: 'Admin access is not configured.' });
  }

  const { username = '', password = '' } = req.body || {};
  if (!safeCompare(username, config.username) || !safeCompare(password, config.password)) {
    clearAdminSessionCookie(res);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = createAdminSessionToken(config.username, config.sessionSecret);
  setAdminSessionCookie(res, token);
  return res.json({
    ok: true,
    username: config.username,
  });
});

app.post('/api/admin/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/manual', requireAdminAuth, (_req, res) => {
  const manualDataPath = getManualDataPath();
  const rawText = fs.readFileSync(manualDataPath, 'utf8');
  const parsedDocs = JSON.parse(rawText);
  const stats = fs.statSync(manualDataPath);

  res.json({
    rawText,
    docsCount: parsedDocs.length,
    updatedAt: stats.mtime.toISOString(),
  });
});

app.put('/api/admin/manual', requireAdminAuth, (req, res) => {
  const manualDataPath = getManualDataPath();
  const { rawText } = req.body || {};
  if (typeof rawText !== 'string') {
    return res.status(400).json({ error: 'A rawText string is required.' });
  }

  let parsedDocs;
  try {
    parsedDocs = JSON.parse(rawText);
  } catch (error) {
    return res.status(400).json({
      error: `Invalid JSON: ${error.message}`,
    });
  }

  if (!Array.isArray(parsedDocs)) {
    return res.status(400).json({ error: 'The manual must be a JSON array.' });
  }

  const normalizedRawText = `${JSON.stringify(parsedDocs, null, 2)}\n`;
  fs.writeFileSync(manualDataPath, normalizedRawText);
  const stats = fs.statSync(manualDataPath);

  return res.json({
    ok: true,
    rawText: normalizedRawText,
    docsCount: parsedDocs.length,
    updatedAt: stats.mtime.toISOString(),
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'A message string is required.' });
    }

    const normalizedHistory = Array.isArray(history) ? history : [];
    const { effectiveQuestion, selectedStore, pendingClarification } = buildEffectiveQuestion(message, normalizedHistory);

    if (pendingClarification && !selectedStore) {
      return res.json(
        buildClarificationResponse(
          pendingClarification.candidateStores,
          pendingClarification.originalQuestion,
          'I still need to know which store you mean:',
        ),
      );
    }

    if (!selectedStore) {
      const ambiguousStores = findAmbiguousStoreMatches(message);
      if (ambiguousStores.length > 1) {
        return res.json(
          buildClarificationResponse(
            ambiguousStores,
            message,
            'I found multiple stores that could match that question. Which one did you mean:',
          ),
        );
      }
    }

    const retrievedDocs = retrieveRelevantDocs(effectiveQuestion, 4);
    const docs = prioritizeSelectedStore(retrievedDocs, selectedStore);

    if (!hasConfidentMatch(docs)) {
      if (classifyMessageIntent(message, docs) === 'casual') {
        return res.json(buildCasualRedirectResponse());
      }

      return res.json({
        answer: "I’m not sure from the current manual. Please ask Dave or Chrystelle.",
        sources: [],
        matchedDocs: [],
      });
    }

    const context = docs
      .map((doc, index) => {
        const facts = Object.entries(doc.facts || {})
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n');

        return [
          `[Source ${index + 1}] ${doc.storeName}`,
          doc.location ? `Location: ${doc.location}` : null,
          facts ? `Facts:\n${facts}` : null,
          `Manual text:\n${doc.content}`,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n---\n\n');

    const transcript = normalizedHistory
      .slice(-6)
      .map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${String(item.content || '')}`)
      .join('\n');

    const input = [
      transcript ? `Recent conversation:\n${transcript}` : null,
      `Current question:\n${effectiveQuestion}`,
      `Operational context:\n${context}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await getOpenAIClient().responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.4',
      instructions: [
        'You are the Chez Chrystelle operations assistant.',
        'Answer only from the provided operational context.',
        'If the question could refer to more than one store in the provided operational context, ask one short clarifying question that names the candidate stores and do not answer the operational question yet.',
        'If the user just answered a clarification question, use that clarification to answer the original operational question.',
        'Do not invent store policies, route details, timing, invoice rules, returns rules, payment rules, names, or contact information.',
        'If the answer is incomplete or unclear from the manual, say exactly: I’m not sure from the current manual. Please ask Dave or Chrystelle.',
        'Keep answers short, practical, and operational.',
        'If useful, name the store the answer came from.',
      ].join(' '),
      input,
    });

    res.json({
      answer: response.output_text,
      sources: docs.map((doc) => ({
        id: doc.id,
        storeName: doc.storeName,
        score: doc.score,
      })),
      matchedDocs: docs.map((doc) => ({
        id: doc.id,
        storeName: doc.storeName,
        snippet: doc.content.slice(0, 220) + (doc.content.length > 220 ? '…' : ''),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'Something went wrong while generating the response.',
    });
  }
});

if (fs.existsSync(webIndexPath)) {
  app.use(express.static(webDistPath));

  app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      return next();
    }

    return res.sendFile(webIndexPath);
  });
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Chez ops server listening on http://localhost:${port}`);
});
