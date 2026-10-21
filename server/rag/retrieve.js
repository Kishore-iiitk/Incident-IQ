import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveData } from '../utils/redactor.js';
import { ConfirmedIncident } from '../models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_INDEX_PATH = path.join(__dirname, 'kb_index.json');
export const DEFAULT_RAG_MIN_SCORE = 0.41;

/**
 * Compute cosine similarity between two numerical vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = vecA.length;
  for (let i = 0; i < len; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let confirmedIncidentsCache = null;
let lastCacheRefresh = 0;

/**
 * Invalidate the in-memory confirmed incidents cache.
 */
export function invalidateConfirmedIncidentsCache() {
  confirmedIncidentsCache = null;
  lastCacheRefresh = 0;
}

/**
 * Fetch and cache confirmed incidents from MongoDB.
 */
async function getCachedConfirmedIncidents() {
  // If cache is valid, return it
  if (confirmedIncidentsCache !== null) {
    return confirmedIncidentsCache;
  }

  try {
    if (!ConfirmedIncident || typeof ConfirmedIncident.find !== 'function') {
      return [];
    }
    // Only retrieve entries with valid non-null embeddings (pending_embedding: false / embedding length > 0)
    const docs = await ConfirmedIncident.find({
      confirmed: true,
      pending_embedding: { $ne: true },
      embedding: { $exists: true, $ne: null }
    }).lean();

    confirmedIncidentsCache = docs
      .filter(d => Array.isArray(d.embedding) && d.embedding.length > 0)
      .map(d => ({
        id: d.id,
        family: d.family || 'confirmed_past_incident',
        service: d.service || 'confirmed',
        title: d.title,
        symptoms: d.symptoms || '',
        root_cause: d.root_cause,
        resolution: d.resolution,
        embedding: d.embedding,
        isConfirmed: true,
        source: 'resolved'
      }));
    lastCacheRefresh = Date.now();
    return confirmedIncidentsCache;
  } catch (err) {
    // If DB is not connected or error occurs in standalone scripts, return empty
    return [];
  }
}

/**
 * Retrieve top k matching incidents from the knowledge base index and confirmed incidents.
 *
 * @param {string} queryText - Incident query text to match.
 * @param {object} options
 * @param {number} [options.k=3] - Number of top results to return.
 * @param {Function} [options.embedFn] - Optional injected embedding function: (text) => Promise<number[]>.
 * @param {string} [options.backend] - 'local' (default) or 'atlas'.
 * @param {string} [options.indexPath] - Custom path to kb_index.json.
 * @param {number} [options.minScore] - Minimum similarity score threshold (default: env RAG_MIN_SCORE or 0.41).
 * @param {number} [options.confirmedBoost] - Ranking boost for confirmed incidents (default: env RAG_CONFIRMED_BOOST or 0.10).
 * @returns {Promise<Array<{id: string, family: string, service: string, title: string, symptoms: string, root_cause: string, resolution: string, score: number, isConfirmed?: boolean}>>}
 */
export async function retrieve(queryText, { k = 3, embedFn, backend, indexPath, minScore, confirmedBoost } = {}) {
  const activeBackend = backend || process.env.RAG_BACKEND || 'local';

  if (activeBackend === 'atlas') {
    if (!process.env.MONGODB_ATLAS_URI) {
      throw new Error('atlas backend not configured');
    }
    throw new Error('atlas backend not configured');
  }

  if (activeBackend !== 'local') {
    throw new Error(`Unsupported RAG backend: ${activeBackend}`);
  }

  if (!queryText || typeof queryText !== 'string' || !queryText.trim()) {
    throw new Error('Query text must be a non-empty string');
  }

  // 1. Check and load the index file
  const resolvedIndexPath = indexPath || DEFAULT_INDEX_PATH;
  if (!fs.existsSync(resolvedIndexPath)) {
    throw new Error(`KB index unavailable: file not found at ${resolvedIndexPath}`);
  }

  let indexData;
  try {
    const rawContent = fs.readFileSync(resolvedIndexPath, 'utf-8');
    indexData = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`KB index unavailable: failed to parse JSON at ${resolvedIndexPath}: ${err.message}`);
  }

  const staticIncidents = indexData.incidents || (Array.isArray(indexData) ? indexData : null);
  if (!staticIncidents || !Array.isArray(staticIncidents) || staticIncidents.length === 0) {
    throw new Error(`KB index unavailable: no incidents found in index at ${resolvedIndexPath}`);
  }

  // Fetch confirmed incidents
  const confirmedList = await getCachedConfirmedIncidents();

  // Combine both sets
  const allCandidates = [
    ...staticIncidents.map(i => ({ ...i, isConfirmed: false })),
    ...confirmedList
  ];

  // 2. Redact sensitive data before embedding
  const cleanQuery = redactSensitiveData(queryText);

  // 3. Obtain query embedding
  let queryEmbedding;
  if (typeof embedFn === 'function') {
    try {
      queryEmbedding = await embedFn(cleanQuery);
    } catch (err) {
      throw new Error(`Injected embedFn failed: ${err.message}`);
    }
  } else {
    const mlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001';
    let response;
    try {
      response = await fetch(`${mlUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanQuery })
      });
    } catch (err) {
      throw new Error(`ML service unavailable at ${mlUrl}: ${err.message}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`ML service returned error ${response.status}: ${errText || response.statusText}`);
    }

    const payload = await response.json();
    queryEmbedding = payload.embedding || (payload.embeddings && payload.embeddings[0]);
  }

  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    throw new Error('Failed to retrieve valid embedding vector for query');
  }

  // 4. Compute cosine similarity against each incident
  const boostVal = confirmedBoost !== undefined
    ? Number(confirmedBoost)
    : (process.env.RAG_CONFIRMED_BOOST !== undefined && process.env.RAG_CONFIRMED_BOOST !== ''
        ? parseFloat(process.env.RAG_CONFIRMED_BOOST)
        : 0.10);

  const envMin = process.env.RAG_MIN_SCORE !== undefined && process.env.RAG_MIN_SCORE !== ''
    ? parseFloat(process.env.RAG_MIN_SCORE)
    : DEFAULT_RAG_MIN_SCORE;
  const effectiveMinScore = minScore !== undefined ? Number(minScore) : envMin;

  // Step 4a: Calculate raw score, filter by RAG_MIN_SCORE first
  const scored = allCandidates.map(item => {
    const rawScore = cosineSimilarity(queryEmbedding, item.embedding);
    return {
      id: item.id,
      family: item.family,
      service: item.service,
      title: item.title,
      symptoms: item.symptoms,
      root_cause: item.root_cause,
      resolution: item.resolution,
      score: Number(rawScore.toFixed(4)),
      isConfirmed: Boolean(item.isConfirmed)
    };
  });

  // Filter out results strictly below the minimum score threshold on RAW score first
  const qualifying = isNaN(effectiveMinScore) ? scored : scored.filter(item => item.score >= effectiveMinScore);

  // Step 4b: Apply boost to confirmed entries before taking top k
  const boosted = qualifying.map(item => {
    if (item.isConfirmed) {
      const boostedScore = Number((item.score + boostVal).toFixed(4));
      return {
        ...item,
        score: boostedScore,
        raw_score: item.score
      };
    }
    return item;
  });

  // Sort descending by similarity score
  boosted.sort((a, b) => b.score - a.score);

  return boosted.slice(0, k);
}
