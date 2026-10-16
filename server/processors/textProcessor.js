import { Evidence } from '../models/index.js';

/**
 * Text Processor
 * Deterministically parses free-text error reports, extracts entities,
 * errors, timestamps, and returns a unified Evidence record.
 */
export async function processTextReport({ incidentId, artifactId, text }) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text content for text processor');
  }

  // 1. Extract error codes & error keywords (e.g. "500 error", "HTTP 500", "Timeout", "Exception")
  const errorPatterns = [
    /\b(?:5\d{2}|4\d{2})\s*(?:error|status|code)?\b/gi,
    /\b(?:internal server error|bad gateway|service unavailable|timeout|crash|unhandled rejection|null pointer)\b/gi,
    /\b(?:spins forever|hanging|deadlock|failed to upload|connection refused)\b/gi
  ];

  const errors = [];
  for (const pattern of errorPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const clean = m.trim();
        if (!errors.includes(clean)) errors.push(clean);
      }
    }
  }

  // 2. Extract technical entities (e.g. course-service, assignment pages, upload button, LMS)
  const entityPatterns = [
    /\b(?:assignment pages?|course pages?|upload button|student portal|courses?|assignments?)\b/gi,
    /\b[a-zA-Z0-9_-]+(?:service|gateway|api|db|auth|upload|worker)\b/gi,
    /\b(?:LMS|AWS|S3|Postgres|MongoDB|Redis)\b/gi
  ];

  const entities = [];
  for (const pattern of entityPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const clean = m.trim().toLowerCase();
        if (!entities.includes(clean)) entities.push(clean);
      }
    }
  }

  // 3. Extract timestamps / relative times (e.g. "since 2pm", "at 14:00", "2:00 PM")
  const timePatterns = [
    /\b(?:since\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?\b/gi,
    /\b(?:today|yesterday|morning|afternoon|evening)\b/gi
  ];

  const timestamps = [];
  for (const pattern of timePatterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const clean = m.trim();
        if (!timestamps.includes(clean)) timestamps.push(clean);
      }
    }
  }

  // Generate deterministic summary
  const summary = text.length > 200 ? `${text.substring(0, 197)}...` : text;

  // Create unified Evidence record
  const evidenceRecord = await Evidence.create({
    incident_id: incidentId,
    artifact_id: artifactId,
    source: 'user_report',
    type: 'text',
    summary,
    entities,
    errors,
    timestamps,
    confidence: 1.0,
    status: 'success'
  });

  return evidenceRecord;
}
