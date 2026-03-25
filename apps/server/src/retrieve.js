import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.resolve(__dirname, '../data/ops-manual.json');

const docs = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const STORE_PREFIX_TOKEN_COUNT = 2;

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

function getUniquePhrases(doc) {
  return [...new Set([doc.storeName, ...(doc.aliases || [])].map(normalizeForMatch).filter(Boolean))];
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

function scoreStoreReference(doc, query) {
  const normalizedQuery = normalizeForMatch(query);

  if (!normalizedQuery) return 0;

  const queryTokens = new Set(tokenizeForMatch(query));
  const phrases = getUniquePhrases(doc);
  const prefixes = getUniquePrefixes(doc);

  let score = 0;

  for (const phrase of phrases) {
    if (normalizedQuery.includes(phrase)) {
      score += 100;
    }
  }

  for (const prefix of prefixes) {
    if (normalizedQuery.includes(prefix)) {
      score += 40;
    }
  }

  if (score === 0) return 0;

  const identifyingTokens = new Set([
    ...tokenizeForMatch(doc.storeName),
    ...tokenizeForMatch(doc.location),
    ...(doc.aliases || []).flatMap((alias) => tokenizeForMatch(alias)),
  ]);

  for (const token of queryTokens) {
    if (identifyingTokens.has(token)) {
      score += 4;
    }
  }

  return score;
}

function scoreDoc(doc, query) {
  const normalizedQuery = normalize(query);
  const queryTokens = tokenize(query);
  let score = 0;

  const haystacks = [
    doc.storeName,
    doc.location,
    ...(doc.aliases || []),
    ...(doc.topics || []),
    doc.content,
    JSON.stringify(doc.facts || {}),
  ].map(normalize);

  for (const alias of doc.aliases || []) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias) continue;

    if (normalizedQuery.includes(normalizedAlias)) score += 25;
    if (normalizedAlias.includes(normalizedQuery) && normalizedQuery.length > 3) score += 10;
  }

  const normalizedStoreName = normalize(doc.storeName);
  if (normalizedStoreName && normalizedQuery.includes(normalizedStoreName)) score += 40;

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

export function retrieveRelevantDocs(query, maxResults = 4) {
  const results = docs
    .map((doc) => ({ ...doc, score: scoreDoc(doc, query) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return results;
}

export function findAmbiguousStoreMatches(query) {
  const storeScores = docs
    .filter((doc) => doc.type === 'store')
    .map((doc) => ({ doc, referenceScore: scoreStoreReference(doc, query) }))
    .filter((entry) => entry.referenceScore > 0)
    .sort((a, b) => b.referenceScore - a.referenceScore);

  if (storeScores.length < 2) {
    return [];
  }

  const topScore = storeScores[0].referenceScore;
  const ambiguousMatches = storeScores.filter((entry) => entry.referenceScore === topScore);

  if (topScore < 48 || ambiguousMatches.length < 2) {
    return [];
  }

  return ambiguousMatches.map((entry) => entry.doc);
}

export function hasConfidentMatch(results) {
  if (!results.length) return false;
  return results[0].score >= 18;
}
