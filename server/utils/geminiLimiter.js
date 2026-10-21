/**
 * Shared Rate Limiter & Bounded 429 Retry Handler for Gemini API.
 * 
 * Complies with free-tier 5 requests per minute (RPM) quota, distinguishes
 * daily quota exhaustion from temporary rate limits, and respects Google's
 * RetryInfo / retryDelay without shortening it or making futile retries.
 */

// Default configuration
const DEFAULT_RPM = 5;
const WINDOW_MS = 60000;
const MIN_GAP_MS = 1500; // 1.5s spacing between request starts to avoid burst trip
const MAX_RETRIES = 4;
const DEFAULT_MAX_BUDGET_MS = 60000; // 60s execution budget for retries

export class GeminiQuotaExceededError extends Error {
  constructor(message, { isDaily = false, retryDelayMs = null } = {}) {
    super(message);
    this.name = 'GeminiQuotaExceededError';
    this.isDaily = isDaily;
    this.retryDelayMs = retryDelayMs;
    this.status = 429;
  }
}

export class GeminiRateLimiter {
  constructor({ rpm = null, minGapMs = MIN_GAP_MS } = {}) {
    this.configuredRpm = rpm;
    this.minGapMs = minGapMs;
    this.timestamps = [];
    this.blockedUntil = 0;
    this.quotaExhausted = false;
    this.queue = [];
    this.isProcessing = false;
  }

  getRpm() {
    if (this.configuredRpm !== null) return this.configuredRpm;
    const envRpm = process.env.GEMINI_RPM ? parseInt(process.env.GEMINI_RPM, 10) : NaN;
    return !isNaN(envRpm) && envRpm > 0 ? envRpm : DEFAULT_RPM;
  }

  setBlockedUntil(timestampMs) {
    if (timestampMs > this.blockedUntil) {
      this.blockedUntil = timestampMs;
    }
  }

  setQuotaExhausted(exhausted = true) {
    this.quotaExhausted = exhausted;
  }

  isQuotaExhausted() {
    if (!this.quotaExhausted) return false;
    if (Date.now() >= this.blockedUntil) {
      this.quotaExhausted = false;
      return false;
    }
    return true;
  }

  reset() {
    this.timestamps = [];
    this.blockedUntil = 0;
    this.quotaExhausted = false;
    this.queue = [];
    this.isProcessing = false;
  }

  sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async acquire() {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const now = Date.now();

      // Check if globally blocked by a 429 retryDelay or quota exhaustion
      if (now < this.blockedUntil) {
        if (this.quotaExhausted) {
          // Fail fast all queued requests instead of sleeping for hours
          const remainingSec = Math.round((this.blockedUntil - now) / 1000);
          const item = this.queue.shift();
          if (item) {
            item.reject(new GeminiQuotaExceededError(
              `Gemini daily quota exhausted. Refusing to send request (${remainingSec}s cooldown remaining).`,
              { isDaily: true, retryDelayMs: this.blockedUntil - now }
            ));
          }
          continue;
        }

        const waitMs = this.blockedUntil - now;
        await this.sleep(waitMs);
        continue;
      }

      // Clean up timestamps outside the 60-second window
      const cutoff = Date.now() - WINDOW_MS;
      this.timestamps = this.timestamps.filter(ts => ts > cutoff);

      const rpm = this.getRpm();

      // Check RPM sliding window
      if (this.timestamps.length >= rpm) {
        const oldest = this.timestamps[0];
        const waitMs = (oldest + WINDOW_MS) - Date.now() + 500;
        if (waitMs > 0) {
          await this.sleep(waitMs);
          continue;
        }
      }

      // Check minimum gap between consecutive requests
      if (this.timestamps.length > 0) {
        const lastTs = this.timestamps[this.timestamps.length - 1];
        const gap = Date.now() - lastTs;
        if (gap < this.minGapMs) {
          const waitMs = this.minGapMs - gap;
          await this.sleep(waitMs);
          continue;
        }
      }

      // Ready to dispatch next queued request
      this.timestamps.push(Date.now());
      const nextItem = this.queue.shift();
      if (nextItem && nextItem.resolve) {
        nextItem.resolve();
      }
    }

    this.isProcessing = false;
  }

  async schedule(fn) {
    await this.acquire();
    return await fn();
  }
}

// Global shared rate limiter singleton across all processors and agents
export const sharedLimiter = new GeminiRateLimiter();

/**
 * Determine if an error is a 429 / Rate Limit / Quota Exhaustion error.
 */
export function isRateLimitError(error) {
  if (!error) return false;
  if (error.status === 429 || error.statusCode === 429) return true;
  if (error.error && (error.error.code === 429 || error.error.status === 'RESOURCE_EXHAUSTED')) return true;

  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource has been exhausted') ||
    msg.includes('exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

/**
 * Determine if an error represents daily quota exhaustion (e.g. GenerateRequestsPerDay)
 * rather than a short temporary rate limit.
 */
export function isDailyQuotaExhausted(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  if (
    msg.includes('generaterequestsperday') ||
    msg.includes('requestsperday') ||
    msg.includes('perday') ||
    msg.includes('daily')
  ) {
    return true;
  }

  const details = error.errorDetails || error.details || error.error?.details || [];
  if (Array.isArray(details)) {
    for (const d of details) {
      const serialized = JSON.stringify(d).toLowerCase();
      if (
        serialized.includes('generaterequestsperday') ||
        serialized.includes('requestsperday') ||
        serialized.includes('perday') ||
        serialized.includes('daily')
      ) {
        return true;
      }
    }
  }

  // If retryDelay is larger than 60s, it represents daily/long-horizon quota exhaustion
  const delay = parseRetryDelay(error);
  if (delay !== null && delay > DEFAULT_MAX_BUDGET_MS) {
    return true;
  }

  return false;
}

/**
 * Parse RetryInfo or retryDelay from Google GenAI / Gemini error response.
 * Returns delay in milliseconds, or null if not found.
 */
export function parseRetryDelay(error) {
  if (!error) return null;

  // 1. Google RPC RetryInfo in errorDetails or details array
  const details = error.errorDetails || error.details || error.error?.details || [];
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && d['@type'] && d['@type'].includes('RetryInfo') && d.retryDelay !== undefined) {
        if (typeof d.retryDelay === 'string') {
          const match = d.retryDelay.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
          if (match) return Math.ceil(parseFloat(match[1]) * 1000);
        } else if (typeof d.retryDelay === 'object' && d.retryDelay !== null) {
          const secs = Number(d.retryDelay.seconds) || 0;
          const nanos = Number(d.retryDelay.nanos) || 0;
          return (secs * 1000) + Math.ceil(nanos / 1e6);
        } else if (typeof d.retryDelay === 'number') {
          return Math.ceil(d.retryDelay * 1000);
        }
      }
    }
  }

  // 2. HTTP response headers (retry-after)
  if (error.response && error.response.headers) {
    const headers = error.response.headers;
    const retryAfter = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
    if (retryAfter) {
      const parsed = parseFloat(retryAfter);
      if (!isNaN(parsed)) return Math.ceil(parsed * 1000);
    }
  }

  // 3. Regex on error message (e.g. "retryDelay 67033s", "retry after 15s", "wait 10 seconds")
  const msg = error.message || '';
  const msgMatch = msg.match(/(?:retry(?:ing)?\s+after|retrydelay|wait)[\s:=]+(\d+(?:\.\d+)?)\s*(?:s|seconds?)?/i);
  if (msgMatch) {
    return Math.ceil(parseFloat(msgMatch[1]) * 1000);
  }

  return null;
}

/**
 * Execute an async operation through the shared rate limiter with bounded 429 retries.
 * 
 * @param {Function} fn - Async operation returning a promise
 * @param {object} [options]
 * @param {number} [options.maxRetries=MAX_RETRIES]
 * @param {GeminiRateLimiter} [options.limiter=sharedLimiter]
 * @param {number} [options.bufferMs=500]
 * @param {number} [options.baseBackoffMs=4000]
 * @param {number} [options.maxBudgetMs=DEFAULT_MAX_BUDGET_MS]
 * @returns {Promise<any>}
 */
export async function executeWithRetry(fn, {
  maxRetries = MAX_RETRIES,
  limiter = sharedLimiter,
  bufferMs = 500,
  baseBackoffMs = 4000,
  maxBudgetMs = DEFAULT_MAX_BUDGET_MS
} = {}) {
  let attempt = 0;
  let totalWaitMs = 0;

  while (true) {
    try {
      // If limiter has already recorded quota exhaustion, fail fast
      if (limiter.isQuotaExhausted()) {
        const remainingMs = Math.max(0, limiter.blockedUntil - Date.now());
        const remainingSec = Math.round(remainingMs / 1000);
        throw new GeminiQuotaExceededError(
          `Gemini daily quota exhausted (cooldown: ${remainingSec}s / ~${(remainingSec / 3600).toFixed(1)}h). Failing promptly without futile calls.`,
          { isDaily: true, retryDelayMs: remainingMs }
        );
      }

      // Execute through the shared rate limiter
      return await limiter.schedule(fn);
    } catch (err) {
      if (!isRateLimitError(err)) {
        throw err;
      }

      const isDaily = isDailyQuotaExhausted(err);
      const extractedDelay = parseRetryDelay(err);

      // Check if daily exhaustion or if delay exceeds execution budget
      if (isDaily || (extractedDelay !== null && extractedDelay > maxBudgetMs)) {
        const delayMs = extractedDelay !== null ? extractedDelay : 86400000;
        const delaySec = Math.round(delayMs / 1000);
        const hours = (delaySec / 3600).toFixed(1);

        // Mark limiter as globally blocked
        limiter.setBlockedUntil(Date.now() + delayMs);
        limiter.setQuotaExhausted(true);

        const reason = isDaily
          ? `Gemini daily quota exhausted (GenerateRequestsPerDay limit reached; retryDelay: ${delaySec}s / ~${hours}h). Exceeds execution budget of ${Math.round(maxBudgetMs / 1000)}s. Failing promptly.`
          : `Gemini rate limit retryDelay (${delaySec}s) exceeds maximum execution budget of ${Math.round(maxBudgetMs / 1000)}s. Failing promptly.`;

        console.error(`[GeminiLimiter] ${reason}`);
        throw new GeminiQuotaExceededError(reason, { isDaily: true, retryDelayMs: delayMs });
      }

      if (attempt >= maxRetries) {
        throw err;
      }

      attempt++;

      // For short temporary rate limits (<= maxBudgetMs): do NOT shorten Google's retry delay!
      const delayMs = extractedDelay !== null
        ? extractedDelay + bufferMs
        : Math.min(baseBackoffMs * Math.pow(2, attempt - 1), maxBudgetMs);

      totalWaitMs += delayMs;
      if (totalWaitMs > maxBudgetMs) {
        const reason = `Cumulative retry delay (${(totalWaitMs / 1000).toFixed(1)}s) exceeds execution budget (${Math.round(maxBudgetMs / 1000)}s). Aborting retries.`;
        console.error(`[GeminiLimiter] ${reason}`);
        throw new GeminiQuotaExceededError(reason, { isDaily: false, retryDelayMs: delayMs });
      }

      console.warn(
        `[GeminiLimiter] Short rate limit (429) hit. Respecting exact retryDelay: waiting ${(delayMs / 1000).toFixed(1)}s before retry ${attempt}/${maxRetries}...`
      );

      // Block shared rate limiter for all callers during cooldown
      limiter.setBlockedUntil(Date.now() + delayMs);

      // Wait before retrying this call
      await limiter.sleep(delayMs);
    }
  }
}

/**
 * Wrap a GoogleGenAI client so that client.models.generateContent automatically
 * uses the shared rate limiter and 429 bounded retries.
 */
export function wrapGeminiClient(client, { limiter = sharedLimiter, ...retryOptions } = {}) {
  if (!client || !client.models || typeof client.models.generateContent !== 'function') {
    return client;
  }
  if (client._isWrappedWithLimiter) {
    return client;
  }

  const originalGenerateContent = client.models.generateContent.bind(client.models);

  const wrappedGenerateContent = async (params) => {
    return await executeWithRetry(() => originalGenerateContent(params), { limiter, ...retryOptions });
  };

  const wrappedClient = Object.create(client);
  wrappedClient.models = Object.create(client.models);
  wrappedClient.models.generateContent = wrappedGenerateContent;
  wrappedClient._isWrappedWithLimiter = true;

  return wrappedClient;
}
