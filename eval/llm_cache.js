import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const CACHE_FILE = path.join(CACHE_DIR, 'llm_cache.json');

let inMemoryCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    inMemoryCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (err) {
    inMemoryCache = {};
  }
}

function computeKey(prompt, systemPrompt = '') {
  return crypto.createHash('sha256').update(`${systemPrompt}:::${prompt}`).digest('hex');
}

/**
 * Get cached response or execute call with backoff.
 */
export async function withLlmCache(prompt, systemPrompt, executeFn, bypassCache = false) {
  const key = computeKey(prompt, systemPrompt);

  if (!bypassCache && inMemoryCache[key]) {
    return inMemoryCache[key];
  }

  // Call with backoff
  let attempts = 0;
  const maxAttempts = 3;
  let delay = 2000;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      const result = await executeFn();
      if (!bypassCache) {
        inMemoryCache[key] = result;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(inMemoryCache, null, 2), 'utf8');
      }
      return result;
    } catch (err) {
      if (attempts >= maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
