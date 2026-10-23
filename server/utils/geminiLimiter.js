/**
 * Shared Rate Limiter & Bounded 429 Retry Handler for Gemini API.
 * 
 * Complies with free-tier 5 requests per minute (RPM) quota, distinguishes
 * confirmed daily quota exhaustion from temporary rate limits and unknown quota errors,
 * preserves sanitized Google quota details, handles SDK errors with JSON inside error.message,
 * labels fallback cooldowns as local estimates, and prevents futile retries without exposing secrets.
 */

import { redactSensitiveData } from './redactor.js';

// Default configuration
const DEFAULT_RPM = 5;
const WINDOW_MS = 60000;
const MIN_GAP_MS = 1500; // 1.5s spacing between request starts to avoid burst trip
const MAX_RETRIES = 4;
const DEFAULT_MAX_BUDGET_MS = 60000; // 60s execution budget for retries
const DEFAULT_DAILY_COOLDOWN_MS = 86400000; // 24h fallback estimate when Google omits RetryInfo

export const QUOTA_TYPE = Object.freeze({
  CONFIRMED_DAILY: 'confirmed_daily',
  TEMPORARY_RATE_LIMIT: 'temporary_rate_limit',
  UNKNOWN_QUOTA: 'unknown_quota'
});

export class GeminiQuotaExceededError extends Error {
  constructor(message, {
    isDaily = false,
    retryDelayMs = null,
    quotaType = QUOTA_TYPE.UNKNOWN_QUOTA,
    isLocalEstimate = false,
    sanitizedDetails = null,
    originalError = null
  } = {}) {
    super(message);
    this.name = 'GeminiQuotaExceededError';
    this.isDaily = isDaily;
    this.retryDelayMs = retryDelayMs;
    this.quotaType = quotaType;
    this.isLocalEstimate = isLocalEstimate;
    this.sanitizedDetails = sanitizedDetails;
    this.originalError = originalError;
    this.status = 429;
  }
}

/**
 * Sanitize error message or string to redact API keys and sensitive tokens.
 */
export function sanitizeErrorMessage(input) {
  if (typeof input !== 'string') {
    if (input === null || input === undefined) return '';
    if (typeof input === 'object') {
      try {
        return JSON.stringify(sanitizeErrorDetails(input));
      } catch {
        return String(input);
      }
    }
    return String(input);
  }

  let text = input;

  // 1. Google API keys: AIzaSy... or general AIza[0-9A-Za-z-_]{35}
  text = text.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED_API_KEY]');

  // 2. Query parameter keys: ?key=... or &key=... or ?apiKey=...
  text = text.replace(/([?&](?:api_?key|key)=)[^&\s"']+/gi, '$1[REDACTED_API_KEY]');

  // 3. Header keys: x-goog-api-key: ...
  text = text.replace(/(x-goog-api-key[\s:=]+)['"]?[A-Za-z0-9\-_]+['"]?/gi, '$1[REDACTED_API_KEY]');

  // 4. Redactor utilities for secrets, tokens, emails, phones
  text = redactSensitiveData(text);

  return text;
}

/**
 * Deeply sanitize an error details object or array to remove API keys and credentials.
 */
export function sanitizeErrorDetails(details) {
  if (!details) return null;
  if (typeof details === 'string') {
    return sanitizeErrorMessage(details);
  }
  if (Array.isArray(details)) {
    return details.map(item => sanitizeErrorDetails(item));
  }
  if (typeof details === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(details)) {
      if (/key|secret|token|auth|password/i.test(key) && typeof value === 'string') {
        sanitized[key] = '[REDACTED_API_KEY]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeErrorDetails(value);
      } else if (typeof value === 'string') {
        sanitized[key] = sanitizeErrorMessage(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  return details;
}

/**
 * Safely parse JSON embedded in text (e.g. SDK error message).
 */
function extractBalancedJson(str, openChar = '{', closeChar = '}') {
  if (!str || typeof str !== 'string') return null;
  const start = str.indexOf(openChar);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (char === '\\') escaped = !escaped;
      else if (char === '"' && !escaped) inString = false;
      else escaped = false;
    } else {
      if (char === '"') inString = true;
      else if (char === openChar) depth++;
      else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          const candidate = str.substring(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {}
        }
      }
    }
  }
  return null;
}

export function parseJsonFromText(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
    } catch {}
  }

  const balancedObj = extractBalancedJson(trimmed, '{', '}');
  if (balancedObj !== null) return balancedObj;

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.substring(firstBracket, lastBracket + 1));
    } catch {}
  }

  const balancedArr = extractBalancedJson(trimmed, '[', ']');
  if (balancedArr !== null) return balancedArr;

  return null;
}

function parseDelayValue(delayVal) {
  if (delayVal === null || delayVal === undefined) return null;
  if (typeof delayVal === 'string') {
    const match = delayVal.trim().match(/^(\d+(?:\.\d+)?)\s*s?$/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  } else if (typeof delayVal === 'object' && delayVal !== null) {
    const secs = Number(delayVal.seconds) || 0;
    const nanos = Number(delayVal.nanos) || 0;
    return (secs * 1000) + Math.ceil(nanos / 1e6);
  } else if (typeof delayVal === 'number' && !isNaN(delayVal) && delayVal > 0) {
    return Math.ceil(delayVal * 1000);
  }
  return null;
}

/**
 * Extract sanitized quota details, violations, metrics, and retry delays
 * from Google Cloud / Gemini SDK error structures, including embedded JSON in error.message.
 */
export function extractQuotaDetails(error) {
  if (!error) {
    return {
      rawMessage: '',
      sanitizedMessage: '',
      status: null,
      statusCode: null,
      code: null,
      statusText: null,
      details: [],
      violations: [],
      metricNames: [],
      retryDelayMs: null,
      hasGoogleRetryDelay: false,
      sanitizedDetails: null,
      originalSummary: ''
    };
  }

  const rawMessage = typeof error === 'string' ? error : (error.message || '');
  const sanitizedMessage = sanitizeErrorMessage(rawMessage);

  const status = error.status || error.statusCode || error.error?.code || null;
  const statusText = error.error?.status || null;
  const code = error.code || error.error?.code || null;

  // Collect detail objects from all possible sources
  const rawDetailsList = [];
  const addDetails = (src) => {
    if (!src) return;
    if (Array.isArray(src)) {
      src.forEach(item => addDetails(item));
    } else if (typeof src === 'object') {
      rawDetailsList.push(src);
    }
  };

  addDetails(error.errorDetails);
  addDetails(error.details);
  addDetails(error.error?.details);
  addDetails(error.response?.data?.details);
  addDetails(error.response?.data?.error?.details);

  // Parse JSON embedded in error.message (very common in @google/genai SDK)
  const parsedFromMessage = parseJsonFromText(rawMessage);
  let parsedErrorObject = null;
  if (parsedFromMessage) {
    if (Array.isArray(parsedFromMessage)) {
      addDetails(parsedFromMessage);
    } else if (typeof parsedFromMessage === 'object') {
      parsedErrorObject = parsedFromMessage.error || parsedFromMessage;
      addDetails(parsedFromMessage.errorDetails);
      addDetails(parsedFromMessage.details);
      addDetails(parsedFromMessage.error?.details);
    }
  }

  const effectiveStatus = status || parsedErrorObject?.code || null;
  const effectiveStatusText = statusText || parsedErrorObject?.status || null;

  // Extract QuotaFailure violations, RetryInfo, ErrorInfo
  const violations = [];
  const metricNames = [];
  let retryDelayMs = null;
  let hasGoogleRetryDelay = false;

  for (const d of rawDetailsList) {
    if (!d || typeof d !== 'object') continue;

    const typeStr = String(d['@type'] || '');

    // 1. QuotaFailure
    if (typeStr.includes('QuotaFailure') && Array.isArray(d.violations)) {
      for (const v of d.violations) {
        if (!v || typeof v !== 'object') continue;
        violations.push({
          quotaMetric: v.quotaMetric || null,
          description: v.description || null,
          subject: v.subject || null
        });
        if (v.quotaMetric) {
          metricNames.push(v.quotaMetric);
        }
      }
    }

    // 2. RetryInfo
    if (typeStr.includes('RetryInfo') && d.retryDelay !== undefined) {
      const parsedDelay = parseDelayValue(d.retryDelay);
      if (parsedDelay !== null) {
        retryDelayMs = parsedDelay;
        hasGoogleRetryDelay = true;
      }
    }

    // 3. ErrorInfo
    if (typeStr.includes('ErrorInfo')) {
      if (d.metadata && typeof d.metadata === 'object') {
        if (d.metadata.quota_limit) metricNames.push(d.metadata.quota_limit);
        if (d.metadata.quota_metric) metricNames.push(d.metadata.quota_metric);
      }
    }
  }

  // Also check HTTP response headers (retry-after)
  if (!hasGoogleRetryDelay && error.response && error.response.headers) {
    const headers = error.response.headers;
    const retryAfter = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
    if (retryAfter) {
      const parsed = parseFloat(retryAfter);
      if (!isNaN(parsed) && parsed > 0) {
        retryDelayMs = Math.ceil(parsed * 1000);
        hasGoogleRetryDelay = true;
      }
    }
  }

  // Also check direct property error.retryAfter
  if (!hasGoogleRetryDelay && error.retryAfter !== undefined) {
    const parsed = parseFloat(error.retryAfter);
    if (!isNaN(parsed) && parsed > 0) {
      retryDelayMs = Math.ceil(parsed * 1000);
      hasGoogleRetryDelay = true;
    }
  }

  // Also check regex in error message (e.g. "retryDelay: 67033s", "retry after 15s", "retryDelay: '15s'")
  if (!hasGoogleRetryDelay && rawMessage) {
    const msgMatch = rawMessage.match(/(?:retry(?:ing)?\s+after|retrydelay|wait)[\s:=]+["']?(\d+(?:\.\d+)?)\s*(?:s|seconds?)?["']?/i);
    if (msgMatch) {
      const parsed = parseFloat(msgMatch[1]);
      if (!isNaN(parsed) && parsed > 0) {
        retryDelayMs = Math.ceil(parsed * 1000);
        hasGoogleRetryDelay = true;
      }
    }
  }

  // Build sanitized original error summary
  const summaryParts = [];
  if (effectiveStatusText || effectiveStatus) {
    summaryParts.push(`[${[effectiveStatusText, effectiveStatus].filter(Boolean).join(' / ')}]`);
  }
  const cleanSnippet = (sanitizedMessage || '').split('\n')[0].trim();
  if (cleanSnippet) {
    summaryParts.push(cleanSnippet);
  }
  if (metricNames.length > 0) {
    summaryParts.push(`(Metric: ${Array.from(new Set(metricNames)).join(', ')})`);
  }
  if (hasGoogleRetryDelay && retryDelayMs !== null) {
    summaryParts.push(`(Google retryDelay: ${Math.round(retryDelayMs / 1000)}s)`);
  }

  const originalSummary = summaryParts.join(' ').trim() || sanitizedMessage;

  const sanitizedDetails = {
    status: effectiveStatus,
    statusText: effectiveStatusText,
    code,
    message: sanitizedMessage,
    metricNames: Array.from(new Set(metricNames)),
    violations: sanitizeErrorDetails(violations),
    hasGoogleRetryDelay,
    googleRetryDelayMs: hasGoogleRetryDelay ? retryDelayMs : null,
    rawDetails: sanitizeErrorDetails(rawDetailsList)
  };

  return {
    rawMessage,
    sanitizedMessage,
    status: effectiveStatus,
    statusCode: effectiveStatus,
    code,
    statusText: effectiveStatusText,
    details: rawDetailsList,
    violations,
    metricNames: Array.from(new Set(metricNames)),
    retryDelayMs,
    hasGoogleRetryDelay,
    sanitizedDetails,
    originalSummary
  };
}

/**
 * Distinguish confirmed daily exhaustion, temporary rate limits, and unknown quota errors.
 * Preserves sanitized details and ensures a delay exceeding execution budget does not
 * automatically mean daily quota exhaustion.
 */
export function classifyQuotaError(error) {
  if (!error) {
    return {
      type: QUOTA_TYPE.UNKNOWN_QUOTA,
      isDaily: false,
      isTemporary: false,
      isUnknown: true,
      retryDelayMs: null,
      hasGoogleRetryDelay: false,
      sanitizedDetails: null,
      sanitizedMessage: '',
      violations: [],
      metricNames: [],
      originalSummary: ''
    };
  }

  const details = extractQuotaDetails(error);
  const { rawMessage, violations, metricNames, retryDelayMs, hasGoogleRetryDelay } = details;

  // Combine text tokens to check for explicit daily patterns
  const textToInspect = [
    rawMessage,
    ...metricNames,
    ...violations.map(v => `${v.quotaMetric || ''} ${v.description || ''}`)
  ].join(' ').toLowerCase();

  // 1. Confirmed Daily Quota Exhaustion
  // ONLY if explicit daily metrics or keywords exist.
  // CRITICAL: A delay exceeding the execution budget MUST NOT automatically mean daily exhaustion!
  const isConfirmedDaily = (
    textToInspect.includes('generaterequestsperday') ||
    textToInspect.includes('requestsperday') ||
    textToInspect.includes('perday') ||
    textToInspect.includes('per_day') ||
    textToInspect.includes('free_tier_requests_per_day') ||
    textToInspect.includes('requests per day') ||
    textToInspect.includes('daily quota') ||
    textToInspect.includes('daily limit') ||
    /\bdaily\b/i.test(textToInspect)
  );

  if (isConfirmedDaily) {
    return {
      type: QUOTA_TYPE.CONFIRMED_DAILY,
      isDaily: true,
      isTemporary: false,
      isUnknown: false,
      retryDelayMs,
      hasGoogleRetryDelay,
      sanitizedDetails: details.sanitizedDetails,
      sanitizedMessage: details.sanitizedMessage,
      violations,
      metricNames,
      originalSummary: details.originalSummary
    };
  }

  // 2. Temporary Rate Limit
  // Explicit per-minute / RPM / TPM metrics, or Google RetryInfo / retry-after present,
  // or short rate limit keywords.
  const isTemporaryRateLimit = (
    textToInspect.includes('generaterequestsperminute') ||
    textToInspect.includes('requestsperminute') ||
    textToInspect.includes('perminute') ||
    textToInspect.includes('per_minute') ||
    textToInspect.includes('tokensperminute') ||
    textToInspect.includes('rpm') ||
    textToInspect.includes('tpm') ||
    textToInspect.includes('rate_limit_exceeded') ||
    textToInspect.includes('rate limit') ||
    textToInspect.includes('too many requests') ||
    hasGoogleRetryDelay
  );

  if (isTemporaryRateLimit) {
    return {
      type: QUOTA_TYPE.TEMPORARY_RATE_LIMIT,
      isDaily: false,
      isTemporary: true,
      isUnknown: false,
      retryDelayMs,
      hasGoogleRetryDelay,
      sanitizedDetails: details.sanitizedDetails,
      sanitizedMessage: details.sanitizedMessage,
      violations,
      metricNames,
      originalSummary: details.originalSummary
    };
  }

  // 3. Unknown Quota Error
  return {
    type: QUOTA_TYPE.UNKNOWN_QUOTA,
    isDaily: false,
    isTemporary: false,
    isUnknown: true,
    retryDelayMs,
    hasGoogleRetryDelay,
    sanitizedDetails: details.sanitizedDetails,
    sanitizedMessage: details.sanitizedMessage,
    violations,
    metricNames,
    originalSummary: details.originalSummary
  };
}

export class GeminiRateLimiter {
  constructor({ rpm = null, minGapMs = MIN_GAP_MS } = {}) {
    this.configuredRpm = rpm;
    this.minGapMs = minGapMs;
    this.timestamps = [];
    this.blockedUntil = 0;
    this.quotaExhausted = false;
    this.isBlockedByLocalEstimate = false;
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
    this.isBlockedByLocalEstimate = false;
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
            const estimateLabel = this.isBlockedByLocalEstimate ? ' (local fallback estimate)' : '';
            item.reject(new GeminiQuotaExceededError(
              `Gemini daily quota exhausted. Refusing to send request (${remainingSec}s cooldown remaining${estimateLabel}).`,
              {
                isDaily: true,
                retryDelayMs: this.blockedUntil - now,
                quotaType: QUOTA_TYPE.CONFIRMED_DAILY,
                isLocalEstimate: this.isBlockedByLocalEstimate
              }
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
  if (error instanceof GeminiQuotaExceededError) return true;
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
 * Determine if an error represents confirmed daily quota exhaustion (e.g. GenerateRequestsPerDay)
 * rather than a temporary rate limit or unknown quota error.
 */
export function isDailyQuotaExhausted(error) {
  if (!error) return false;
  if (error.isDaily === true) return true;
  return classifyQuotaError(error).isDaily;
}

/**
 * Parse RetryInfo or retryDelay from Google GenAI / Gemini error response.
 * Returns delay in milliseconds, or null if not found.
 */
export function parseRetryDelay(error) {
  if (!error) return null;
  return extractQuotaDetails(error).retryDelayMs;
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
      // 1. Fast-fail if limiter is blocked
      if (limiter.blockedUntil > Date.now()) {
        const remainingMs = limiter.blockedUntil - Date.now();
        const remainingSec = Math.round(remainingMs / 1000);
        const hours = (remainingSec / 3600).toFixed(1);

        if (limiter.isQuotaExhausted()) {
          const estimateLabel = limiter.isBlockedByLocalEstimate ? ' (local fallback estimate)' : '';
          throw new GeminiQuotaExceededError(
            `Gemini daily quota exhausted (cooldown: ${remainingSec}s / ~${hours}h remaining${estimateLabel}). Failing promptly without futile calls.`,
            {
              isDaily: true,
              retryDelayMs: remainingMs,
              quotaType: QUOTA_TYPE.CONFIRMED_DAILY,
              isLocalEstimate: limiter.isBlockedByLocalEstimate || false
            }
          );
        }

        // If blocked by temporary rate limit but remaining wait exceeds caller's budget
        if (remainingMs > maxBudgetMs) {
          throw new GeminiQuotaExceededError(
            `Gemini rate limiter blocked (${remainingSec}s remaining cooldown) exceeding execution budget (${Math.round(maxBudgetMs / 1000)}s). Aborting without futile calls.`,
            {
              isDaily: false,
              retryDelayMs: remainingMs,
              quotaType: QUOTA_TYPE.TEMPORARY_RATE_LIMIT,
              isLocalEstimate: limiter.isBlockedByLocalEstimate || false
            }
          );
        }
      }

      // Execute through the shared rate limiter
      return await limiter.schedule(fn);
    } catch (err) {
      if (!isRateLimitError(err)) {
        throw err;
      }

      // If already a GeminiQuotaExceededError, rethrow directly
      if (err instanceof GeminiQuotaExceededError) {
        throw err;
      }

      const classification = classifyQuotaError(err);
      const { type, isDaily, retryDelayMs, hasGoogleRetryDelay, originalSummary, sanitizedDetails } = classification;

      // Handle Confirmed Daily Exhaustion
      if (isDaily) {
        const delayMs = hasGoogleRetryDelay && retryDelayMs !== null ? retryDelayMs : DEFAULT_DAILY_COOLDOWN_MS;
        const delaySec = Math.round(delayMs / 1000);
        const hours = (delaySec / 3600).toFixed(1);
        const isLocalEstimate = !hasGoogleRetryDelay;

        limiter.setBlockedUntil(Date.now() + delayMs);
        limiter.setQuotaExhausted(true);
        limiter.isBlockedByLocalEstimate = isLocalEstimate;

        const delayDescription = hasGoogleRetryDelay
          ? `Google retryDelay: ${delaySec}s / ~${hours}h`
          : `local fallback cooldown estimate: ${delaySec}s / ~${hours}h`;

        const reason = `Gemini daily quota exhausted (GenerateRequestsPerDay limit reached; ${delayDescription}). Exceeds execution budget of ${Math.round(maxBudgetMs / 1000)}s. Failing promptly. Original error: ${originalSummary}`;

        console.error(`[GeminiLimiter] ${reason}`);
        throw new GeminiQuotaExceededError(reason, {
          isDaily: true,
          retryDelayMs: delayMs,
          quotaType: QUOTA_TYPE.CONFIRMED_DAILY,
          isLocalEstimate,
          sanitizedDetails,
          originalError: err
        });
      }

      // Handle Delay Exceeding Execution Budget (Temporary Rate Limit or Unknown Quota)
      // Note: A delay exceeding the execution budget must NOT automatically mean daily quota exhaustion!
      if (hasGoogleRetryDelay && retryDelayMs !== null && retryDelayMs > maxBudgetMs) {
        const delaySec = Math.round(retryDelayMs / 1000);
        limiter.setBlockedUntil(Date.now() + retryDelayMs);
        limiter.isBlockedByLocalEstimate = false;

        const quotaLabel = type === QUOTA_TYPE.TEMPORARY_RATE_LIMIT
          ? 'Gemini temporary rate limit'
          : 'Gemini rate limit';

        const reason = `${quotaLabel} Google retryDelay (${delaySec}s) exceeds maximum execution budget of ${Math.round(maxBudgetMs / 1000)}s. Failing promptly. Original error: ${originalSummary}`;

        console.error(`[GeminiLimiter] ${reason}`);
        throw new GeminiQuotaExceededError(reason, {
          isDaily: false,
          retryDelayMs,
          quotaType: type,
          isLocalEstimate: false,
          sanitizedDetails,
          originalError: err
        });
      }

      // Check retries attempt limit
      if (attempt >= maxRetries) {
        console.error(`[GeminiLimiter] Max retries (${maxRetries}) reached for rate limit error. Original error: ${originalSummary}`);
        throw err;
      }

      attempt++;

      // Compute delay for temporary rate limit / unknown quota
      let delayMs;
      let isLocalEstimate = false;

      if (hasGoogleRetryDelay && retryDelayMs !== null) {
        delayMs = retryDelayMs + bufferMs;
      } else {
        // Fallback exponential backoff is a local estimate
        delayMs = baseBackoffMs * Math.pow(2, attempt - 1);
        isLocalEstimate = true;
      }

      if (totalWaitMs + delayMs > maxBudgetMs) {
        totalWaitMs += delayMs;
        const reason = `Cumulative retry delay (${(totalWaitMs / 1000).toFixed(1)}s) exceeds execution budget (${Math.round(maxBudgetMs / 1000)}s). Aborting retries. Original error: ${originalSummary}`;
        console.error(`[GeminiLimiter] ${reason}`);
        throw new GeminiQuotaExceededError(reason, {
          isDaily: false,
          retryDelayMs: delayMs,
          quotaType: type,
          isLocalEstimate,
          sanitizedDetails,
          originalError: err
        });
      }

      totalWaitMs += delayMs;

      const delayLabel = hasGoogleRetryDelay
        ? `Respecting Google retryDelay: waiting ${(delayMs / 1000).toFixed(1)}s`
        : `Using local estimate backoff: waiting ${(delayMs / 1000).toFixed(1)}s`;

      console.warn(
        `[GeminiLimiter] ${type === QUOTA_TYPE.TEMPORARY_RATE_LIMIT ? 'Temporary rate limit (429)' : 'Rate limit error'} hit. ${delayLabel} before retry ${attempt}/${maxRetries}... Original error: ${originalSummary}`
      );

      limiter.setBlockedUntil(Date.now() + delayMs);
      limiter.isBlockedByLocalEstimate = isLocalEstimate;

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

