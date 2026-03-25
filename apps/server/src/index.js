import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { getOpenAIClient } from './openai.js';
import { findAmbiguousStoreMatches, hasConfidentMatch, retrieveRelevantDocs } from './retrieve.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../');
const webDistPath = path.join(repoRoot, 'apps/web/dist');
const webIndexPath = path.join(webDistPath, 'index.html');

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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/stores', (_req, res) => {
  const dataPath = path.resolve(__dirname, '../data/ops-manual.json');
  const docs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const stores = docs
    .filter((doc) => doc.type === 'store')
    .map((doc) => ({
      id: doc.id,
      storeName: doc.storeName,
      location: doc.location,
      summary: doc.content.slice(0, 180) + (doc.content.length > 180 ? '…' : ''),
    }));

  res.json({ stores });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'A message string is required.' });
    }

    const ambiguousStores = findAmbiguousStoreMatches(message);

    if (ambiguousStores.length > 1) {
      return res.json({
        answer: `I found multiple stores that could match that question. Which one did you mean: ${ambiguousStores
          .map(formatStoreLabel)
          .join(' or ')}?`,
        sources: [],
        matchedDocs: ambiguousStores.map((doc) => ({
          id: doc.id,
          storeName: doc.storeName,
          snippet: doc.content.slice(0, 220) + (doc.content.length > 220 ? '…' : ''),
        })),
      });
    }

    const docs = retrieveRelevantDocs(message, 4);

    if (!hasConfidentMatch(docs)) {
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

    const transcript = history
      .slice(-6)
      .map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${String(item.content || '')}`)
      .join('\n');

    const input = [
      transcript ? `Recent conversation:\n${transcript}` : null,
      `Current question:\n${message}`,
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
