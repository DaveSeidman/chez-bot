import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PREFIX_TOKEN_COUNT = 2;

const BOROUGH_HINT_RULES = [
  {
    matcher: /\beast village\b|\blower east side\b|\bles\b|\bdelancey\b|\bessex\b|\bmanhattan\b/,
    keywords: ['manhattan', 'city', 'the city', 'east village', 'downtown'],
  },
  {
    matcher:
      /\bbrooklyn\b|\bpark slope\b|\bsouth slope\b|\bprospect\b|\bprospect avenue\b|\b5th avenue\b|\b5th ave\b|\b7th avenue\b|\b9th street\b|\bunion street\b|\bwindsor terrace\b/,
    keywords: ['brooklyn'],
  },
];

const CASUAL_PATTERNS = [
  /\bhi\b|\bhello\b|\bhey\b|\byo\b|\bhowdy\b/,
  /\bgood morning\b|\bgood afternoon\b|\bgood evening\b/,
  /\bhow are you\b|\bwhat'?s up\b|\bsup\b/,
  /\btest\b|\btesting\b|\bping\b/,
  /\bthank you\b|\bthanks\b/,
];

const BUSINESS_KEYWORD_PATTERN =
  /\bdeliver(?:y|ies)?\b|\broute\b|\binvoice\b|\bpayment\b|\bpaid\b|\bcash\b|\bcheck\b|\breturn(?:s|ed)?\b|\bcredit\b|\bbag(?:s)?\b|\bfridge\b|\bshelf\b|\bdeli\b|\bstore\b|\bcoop\b|\bmarket\b|\border(?:ing)?\b|\bmanager\b|\bdoor\b|\bopen(?:ing)?\b|\barriv(?:e|al)\b|\bhours?\b|\bsalad(?:s)?\b|\bkey ?foods?\b|\bmr\.? ?mango\b|\bmr\.? ?kiwi\b|\bmr\.? ?beet\b|\bk-?slope\b|\bprospect\b|\bwindsor\b|\bpark slope\b|\bbad wife\b/;

export function loadDocs() {
  return JSON.parse(fs.readFileSync(getManualDataPath(), 'utf8'));
}

export function getManualDataPath() {
  return process.env.OPS_MANUAL_PATH || path.resolve(__dirname, '../data/ops-manual.json');
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularizeToken(token) {
  if (token.endsWith('ies') && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
}

function normalizeForMatch(text) {
  return normalize(text)
    .split(' ')
    .filter(Boolean)
    .map(singularizeToken)
    .join(' ');
}

function compactForMatch(text) {
  return normalizeForMatch(text).replace(/[^a-z0-9]/g, '');
}

function tokenize(text) {
  return normalize(text)
    .split(' ')
    .filter(Boolean)
    .filter((token) => token.length > 1);
}

function tokenizeForMatch(text) {
  return normalizeForMatch(text)
    .split(' ')
    .filter(Boolean)
    .filter((token) => token.length > 1);
}

function getDocLookupTexts(doc) {
  return [
    doc.storeName,
    doc.location,
    ...(doc.aliases || []),
    ...(doc.topics || []),
    ...(doc.disambiguationTags || []),
    doc.content,
    JSON.stringify(doc.facts || {}),
  ];
}

function getUniquePhrases(doc) {
  return [
    ...new Set(
      [doc.storeName, doc.location, ...(doc.aliases || []), ...(doc.disambiguationTags || [])]
        .map(normalizeForMatch)
        .filter(Boolean),
    ),
  ];
}

function getUniqueBigrams(doc) {
  return [
    ...new Set(
      [doc.storeName, ...(doc.aliases || [])]
        .flatMap((text) => {
          const tokens = tokenizeForMatch(text);
          const bigrams = [];

          for (let index = 0; index < tokens.length - 1; index += 1) {
            bigrams.push(tokens.slice(index, index + 2).join(' '));
          }

          return bigrams;
        })
        .filter(Boolean),
    ),
  ];
}

function getUniquePrefixes(doc) {
  return [
    ...new Set(
      getUniquePhrases(doc)
        .map((phrase) => phrase.split(' ').slice(0, STORE_PREFIX_TOKEN_COUNT).join(' '))
        .filter((prefix) => prefix.split(' ').length === STORE_PREFIX_TOKEN_COUNT),
    ),
  ];
}

function getInferredAreaKeywords(doc) {
  const combinedText = getDocLookupTexts(doc).map(normalizeForMatch).filter(Boolean).join(' ');
  const inferredKeywords = new Set(doc.disambiguationTags || []);

  for (const rule of BOROUGH_HINT_RULES) {
    if (rule.matcher.test(combinedText)) {
      for (const keyword of rule.keywords) {
        inferredKeywords.add(keyword);
      }
    }
  }

  return [...inferredKeywords].map(normalizeForMatch).filter(Boolean);
}

function getReferenceTokens(doc) {
  return new Set([
    ...tokenizeForMatch(doc.storeName),
    ...tokenizeForMatch(doc.location),
    ...(doc.aliases || []).flatMap((alias) => tokenizeForMatch(alias)),
    ...(doc.disambiguationTags || []).flatMap((tag) => tokenizeForMatch(tag)),
    ...getInferredAreaKeywords(doc).flatMap((keyword) => tokenizeForMatch(keyword)),
  ]);
}

function scoreStoreReference(doc, query) {
  const normalizedQuery = normalizeForMatch(query);
  const compactQuery = compactForMatch(query);

  if (!normalizedQuery) return 0;

  const queryTokens = new Set(tokenizeForMatch(query));
  const phrases = getUniquePhrases(doc);
  const prefixes = getUniquePrefixes(doc);
  const bigrams = getUniqueBigrams(doc);
  const areaKeywords = getInferredAreaKeywords(doc);

  let score = 0;

  for (const phrase of phrases) {
    if (normalizedQuery.includes(phrase) || compactQuery.includes(compactForMatch(phrase))) {
      score += 100;
    }
  }

  for (const prefix of prefixes) {
    if (normalizedQuery.includes(prefix) || compactQuery.includes(compactForMatch(prefix))) {
      score += 40;
    }
  }

  for (const bigram of bigrams) {
    if (normalizedQuery.includes(bigram) || compactQuery.includes(compactForMatch(bigram))) {
      score += 24;
    }
  }

  for (const keyword of areaKeywords) {
    if (normalizedQuery.includes(keyword) || compactQuery.includes(compactForMatch(keyword))) {
      score += keyword.includes(' ') ? 30 : 16;
    }
  }

  if (score === 0) return 0;

  const identifyingTokens = getReferenceTokens(doc);

  for (const token of queryTokens) {
    if (identifyingTokens.has(token)) {
      score += 4;
    }
  }

  return score;
}

function scoreClarificationReply(doc, query) {
  const queryTokens = tokenizeForMatch(query);
  const identifyingTokens = [...getReferenceTokens(doc)];
  let score = scoreStoreReference(doc, query);

  for (const token of queryTokens) {
    if (identifyingTokens.includes(token)) {
      score += 8;
      continue;
    }

    if (token.length >= 2 && identifyingTokens.some((identifier) => identifier.startsWith(token) || token.startsWith(identifier))) {
      score += 4;
    }
  }

  return score;
}

function scoreDoc(doc, query) {
  const normalizedQuery = normalize(query);
  const compactQuery = compactForMatch(query);
  const queryTokens = tokenize(query);
  let score = 0;

  const haystacks = getDocLookupTexts(doc).map(normalize);

  for (const alias of doc.aliases || []) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias) continue;

    if (normalizedQuery.includes(normalizedAlias)) score += 25;
    if (normalizedAlias.includes(normalizedQuery) && normalizedQuery.length > 3) score += 10;
    if (compactQuery && compactQuery.includes(compactForMatch(alias))) score += 20;
  }

  const normalizedStoreName = normalize(doc.storeName);
  if (normalizedStoreName && normalizedQuery.includes(normalizedStoreName)) score += 40;
  if (compactQuery && compactQuery.includes(compactForMatch(doc.storeName))) score += 30;

  for (const topic of doc.topics || []) {
    const normalizedTopic = normalize(topic);
    if (normalizedTopic && normalizedQuery.includes(normalizedTopic)) score += 6;
  }

  for (const token of queryTokens) {
    for (const haystack of haystacks) {
      if (haystack.includes(token)) {
        score += 1;
      }
    }
  }

  if (/return|returns|returned|throw out|credit/.test(normalizedQuery) && doc.id.includes('returns')) {
    score += 25;
  }

  if (/cash|check|paid|payment|invoice/.test(normalizedQuery) && /cash|check|paid|payment|invoice/.test(normalize(doc.content))) {
    score += 8;
  }

  if (/when|time|open|opening|arrive|early/.test(normalizedQuery) && /am|pm|open|arrive|early|hour|hours/.test(normalize(doc.content))) {
    score += 5;
  }

  return score;
}

export function getDocById(id) {
  return loadDocs().find((doc) => doc.id === id) || null;
}

export function getDocsByIds(ids) {
  const docs = loadDocs();
  const lookup = new Map(docs.map((doc) => [doc.id, doc]));
  return ids.map((id) => lookup.get(id)).filter(Boolean);
}

export function resolveStoreFromReply(reply, candidateDocs) {
  const scoredDocs = candidateDocs
    .map((doc) => ({ doc, score: scoreClarificationReply(doc, reply) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scoredDocs.length) {
    return null;
  }

  const [topMatch, runnerUp] = scoredDocs;
  if (topMatch.score < 8) {
    return null;
  }

  if (runnerUp && topMatch.score === runnerUp.score) {
    return null;
  }

  return topMatch.doc;
}

export function retrieveRelevantDocs(query, maxResults = 4) {
  const results = loadDocs()
    .map((doc) => ({ ...doc, score: scoreDoc(doc, query) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return results;
}

export function findAmbiguousStoreMatches(query) {
  const storeScores = loadDocs()
    .filter((doc) => doc.type === 'store')
    .map((doc) => ({ doc, referenceScore: scoreStoreReference(doc, query) }))
    .filter((entry) => entry.referenceScore > 0)
    .sort((a, b) => b.referenceScore - a.referenceScore);

  if (storeScores.length < 2) {
    return [];
  }

  const topScore = storeScores[0].referenceScore;
  const ambiguousMatches = storeScores.filter((entry) => topScore - entry.referenceScore <= 8);

  if (topScore < 32 || ambiguousMatches.length < 2) {
    return [];
  }

  return ambiguousMatches.map((entry) => entry.doc);
}

export function classifyMessageIntent(query, retrievedDocs = []) {
  const normalizedQuery = normalize(query);
  const hasBusinessKeyword = BUSINESS_KEYWORD_PATTERN.test(normalizedQuery);
  const hasStoreReference = loadDocs()
    .filter((doc) => doc.type === 'store')
    .some((doc) => scoreStoreReference(doc, query) > 0);
  const hasMeaningfulRetrieval = retrievedDocs.some((doc) => doc.score >= 8);

  if (hasBusinessKeyword || hasStoreReference || hasMeaningfulRetrieval) {
    return 'business';
  }

  if (CASUAL_PATTERNS.some((pattern) => pattern.test(normalizedQuery))) {
    return 'casual';
  }

  return 'casual';
}

export function hasConfidentMatch(results) {
  if (!results.length) return false;
  return results[0].score >= 18;
}
