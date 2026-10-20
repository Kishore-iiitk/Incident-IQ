import crypto from 'node:crypto';

/**
 * Normalizes text by removing timestamps, numbers, IDs, hostnames, and durations.
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    // Timestamps (ISO 8601)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gi, '<TIMESTAMP>')
    // UUIDs
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>')
    // MongoDB 24-character hex ObjectIDs
    .replace(/\b[0-9a-fA-F]{24}\b/g, '<OBJECTID>')
    // Hostnames / IPs with optional ports
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<HOST>')
    .replace(/\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b/gi, '<HOST>')
    // Millisecond / second durations e.g. 12ms, 4012ms, 1.5s
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, '<DURATION>')
    // Standalone numbers
    .replace(/\b\d+\b/g, '<NUM>')
    // Collapsed whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive high-level error_class from signal properties.
 *
 * Mappings:
 * - db_connection: MongoDB/Mongoose connection failures, closed connections, or 5xx on DB-backed endpoints with DB failure
 * - upload_error: file upload route failures / upload storage errors
 * - slow_response: latency exceeding threshold (default 2000ms)
 * - generic_5xx: other 5xx errors
 */
export function deriveErrorClass(signal, slowThresholdMs = 2000) {
  if (!signal) return 'generic_5xx';

  const endpoint = (signal.endpoint || '').toLowerCase();
  const rawMsg = (signal.message || '').toLowerCase();
  const rawStack = (signal.stack || '').toLowerCase();
  const textCombined = `${rawMsg} ${rawStack} ${endpoint}`;

  const status = Number(signal.status);
  const latency = Number(signal.latency_ms);
  const threshold = Number(process.env.SLOW_THRESHOLD_MS) || slowThresholdMs;

  // 1. Check for slow response first if latency is present and exceeds threshold without fatal 5xx crash
  if (latency && latency >= threshold) {
    // If it's a slow login or slow request probe that didn't fail with a fatal 5xx DB error
    if (!status || status < 500) {
      return 'slow_response';
    }
  }

  // 2. Check for database connection errors
  // Covers MongoNotConnectedError, MongoNetworkError, MongoServerSelectionError, MongooseError, ECONNREFUSED to Mongo, etc.
  const isDbText =
    /mongo(?:notconnected|network|serverselection|error|client)/i.test(textCombined) ||
    /failed to connect to (?:mongodb|mongo|database)/i.test(textCombined) ||
    /client must be connected/i.test(textCombined) ||
    /connection closed|topology was destroyed|server instance was destroyed/i.test(textCombined) ||
    /econnrefused.*27017/i.test(textCombined);

  // If DB error keywords match, it's db_connection
  if (isDbText) {
    return 'db_connection';
  }

  // If poller gets 500 on db-backed routes (/courses, /login) during a DB fault
  if ((endpoint.includes('/courses') || endpoint === '/courses') && status >= 500) {
    return 'db_connection';
  }

  // 3. Check for upload-specific errors
  // Note: Two different upload bugs within 10 minutes would merge, which is acceptable for the demo.
  const isUpload =
    endpoint.includes('/upload') ||
    /uploadservicefailure|upload-error|attachment buffer|storage worker/i.test(textCombined);

  if (isUpload) {
    return 'upload_error';
  }

  // 4. Latency threshold check for slow responses (even if 200 OK or 408 timeout)
  if (latency && latency >= threshold) {
    return 'slow_response';
  }
  if (/timeout|slow[-_ ]login|delayed response/i.test(textCombined)) {
    return 'slow_response';
  }

  // 5. Default 5xx or unclassified
  return 'generic_5xx';
}

/**
 * Computes deterministic fingerprint: hash(service + ":" + error_class)
 */
export function computeFingerprint(signal) {
  const service = (signal?.service || 'unknown-service').trim().toLowerCase();
  const errorClass = deriveErrorClass(signal);

  return crypto
    .createHash('sha256')
    .update(`${service}:${errorClass}`)
    .digest('hex')
    .slice(0, 16);
}
