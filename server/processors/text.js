/**
 * Text/Email Processor (Phase 4)
 * Strips signatures, greetings, and quoted replies from emails,
 * then extracts product area, impact, and sentiment.
 * 
 * NEVER throws. Returns Evidence record with status "ok", "failed", or "skipped".
 */

import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveData } from '../utils/redactor.js';

// ---------- Email cleaning patterns ----------

// Greeting patterns (start of email)
const GREETING_PATTERNS = [
  /^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings|to\s+whom\s+it\s+may\s+concern)[,:\s].*$/im,
  /^(?:hi|hello|hey)\s+(?:team|all|everyone|there|support)[,:\s].*$/im,
];

// Signature patterns (end of email)
const SIGNATURE_PATTERNS = [
  /^[-–—]{2,}\s*$/m,
  /^(?:regards|best\s+regards|sincerely|thanks|thank\s+you|thanks\s+(?:and|&)\s+regards|cheers|best|warm\s+regards|kind\s+regards)[,.]?\s*$/im,
  /^(?:sent\s+from\s+my\s+(?:iphone|ipad|android|mobile|phone))\s*$/im,
  /^(?:get\s+outlook\s+for\s+)/im,
  /^\s*(?:--|—)\s*$/m,
];

// RFC email header patterns (start of email)
const EMAIL_HEADER_PATTERNS = [
  /^(?:from|to|cc|bcc|date|subject|reply-to):\s+.*$/im,
];

// Quoted reply patterns
const QUOTED_REPLY_PATTERNS = [
  /^>+\s*.*/m,
  /^on\s+.*wrote:\s*$/im,
  /^-{3,}\s*(?:original\s+message|forwarded\s+message)\s*-{3,}\s*$/im,
];

// ---------- Email stripping ----------

function stripEmailNoise(text) {
  if (!text || typeof text !== 'string') return '';

  let lines = text.split('\n');
  let cleaned = [];
  let inQuotedReply = false;
  let foundBody = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip RFC email headers at the beginning before body content
    if (!foundBody && EMAIL_HEADER_PATTERNS.some(pat => pat.test(line.trim()))) {
      continue;
    }

    // Skip quoted replies
    if (inQuotedReply) continue;

    // Check if this starts a quoted reply block
    if (QUOTED_REPLY_PATTERNS.some(pat => pat.test(line)) || (foundBody && /^from:\s+.*$/im.test(line))) {
      inQuotedReply = true;
      continue;
    }

    // Skip greetings (only at the start before body content)
    if (!foundBody && GREETING_PATTERNS.some(pat => pat.test(line.trim()))) {
      continue;
    }

    // Check if this is a signature line
    if (SIGNATURE_PATTERNS.some(pat => pat.test(line.trim()))) {
      break;
    }

    // Track whether we've found actual body content
    if (line.trim().length > 0) {
      foundBody = true;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n').trim();
}

// ---------- Content extraction ----------

const PRODUCT_AREAS = {
  'login': 'Authentication',
  'sign in': 'Authentication',
  'sign-in': 'Authentication',
  'password': 'Authentication',
  'auth': 'Authentication',
  'sso': 'Authentication',
  'oauth': 'Authentication',
  'upload': 'File Upload',
  'file': 'File Upload',
  'attachment': 'File Upload',
  'storage': 'File Upload',
  'course': 'Course Management',
  'assignment': 'Course Management',
  'grade': 'Course Management',
  'syllabus': 'Course Management',
  'enrollment': 'Course Management',
  'database': 'Database',
  'db': 'Database',
  'mongo': 'Database',
  'postgres': 'Database',
  'sql': 'Database',
  'redis': 'Database',
  'api': 'API Gateway',
  'endpoint': 'API Gateway',
  'server': 'Backend',
  'backend': 'Backend',
  'page': 'Frontend',
  'ui': 'Frontend',
  'button': 'Frontend',
  'display': 'Frontend',
  'render': 'Frontend',
  'payment': 'Billing',
  'billing': 'Billing',
  'invoice': 'Billing',
  'notification': 'Notifications',
  'email': 'Notifications',
  'alert': 'Notifications',
};

const NEGATIVE_WORDS = [
  'broken', 'down', 'error', 'fail', 'crash', 'bug', 'issue', 'problem',
  'unable', 'cannot', 'can\'t', 'won\'t', 'doesn\'t work', 'not working',
  'frustrated', 'angry', 'disappointed', 'unacceptable', 'terrible',
  'horrible', 'worst', 'critical', 'urgent', 'blocking', 'stuck',
  'lost', 'missing', 'wrong', 'slow', 'timeout', 'hang', 'freeze'
];

const POSITIVE_WORDS = [
  'fixed', 'resolved', 'working', 'recovered', 'improved', 'better',
  'great', 'thanks', 'solved'
];

function extractProductArea(text) {
  const lower = text.toLowerCase();
  const found = new Set();

  for (const [keyword, area] of Object.entries(PRODUCT_AREAS)) {
    if (lower.includes(keyword)) {
      found.add(area);
    }
  }

  return [...found];
}

function assessImpact(text) {
  const lower = text.toLowerCase();
  const impacts = [];

  if (/\b(?:all\s+(?:users?|students?|customers?)|everyone|site[- ]?wide|entire)\b/i.test(lower)) {
    impacts.push('Widespread - affects all or most users');
  }
  if (/\b(?:some|several|many|multiple|few|group)\s+(?:users?|students?|customers?)\b/i.test(lower)) {
    impacts.push('Partial - affects a subset of users');
  }
  if (/\b(?:cannot|can\'t|unable|blocked|stuck|impossible)\b/i.test(lower)) {
    impacts.push('Blocking - prevents core workflow completion');
  }
  if (/\b(?:slow|delay|timeout|latency|performance)\b/i.test(lower)) {
    impacts.push('Degraded - feature works but with poor performance');
  }
  if (/\b(?:data\s*loss|corrupt|lost\s+(?:data|work|files?))\b/i.test(lower)) {
    impacts.push('Data integrity - potential data loss or corruption');
  }

  return impacts.length > 0 ? impacts.join('; ') : 'Impact not clearly stated';
}

function assessSentiment(text) {
  const lower = text.toLowerCase();
  let negativeScore = 0;
  let positiveScore = 0;

  for (const word of NEGATIVE_WORDS) {
    if (lower.includes(word)) negativeScore++;
  }
  for (const word of POSITIVE_WORDS) {
    if (lower.includes(word)) positiveScore++;
  }

  if (negativeScore > positiveScore + 2) return 'very_negative';
  if (negativeScore > positiveScore) return 'negative';
  if (positiveScore > negativeScore) return 'positive';
  return 'neutral';
}

// ---------- Main processor ----------

/**
 * Process an email/text complaint and return an Evidence record.
 * @param {object} params
 * @param {string} [params.content] - Raw email/text content
 * @param {string} [params.filePath] - Path to email/text file
 * @param {string} [params.id="EV-04"] - Evidence ID
 * @returns {object} Evidence record
 */
export async function processText({ content, filePath, id = 'EV-04' } = {}) {
  try {
    if (content === undefined && !filePath) {
      return {
        id,
        source: 'email',
        type: 'text',
        summary: 'No email file or content provided',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'skipped',
        reason: 'No input provided'
      };
    }

    if (content !== undefined && (!content || typeof content !== 'string' || content.trim().length === 0)) {
      return {
        id,
        source: 'email',
        type: 'text',
        summary: 'Empty or missing email content',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Empty or invalid text content'
      };
    }

    if (!content && filePath) {
      if (!fs.existsSync(filePath)) {
        return {
          id,
          source: 'email',
          type: 'text',
          summary: 'Email file not found',
          entities: [],
          errors: [],
          timestamps: [],
          confidence: 0,
          status: 'skipped',
          reason: `File not found: ${filePath}`
        };
      }
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        return {
          id,
          source: 'email',
          type: 'text',
          summary: 'Email file is empty (0 bytes)',
          entities: [],
          errors: [],
          timestamps: [],
          confidence: 0,
          status: 'failed',
          reason: 'Email file is empty (0 bytes)'
        };
      }
      content = fs.readFileSync(filePath, 'utf8');
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return {
        id,
        source: 'email',
        type: 'text',
        summary: 'Empty or missing email content',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Empty or invalid text content'
      };
    }

    // Strip email noise
    const stripped = stripEmailNoise(content);
    if (!stripped || stripped.length === 0) {
      return {
        id,
        source: 'email',
        type: 'text',
        summary: 'Email contained only noise (signatures, greetings, quoted replies)',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0.1,
        status: 'ok',
        reason: 'No substantive content after stripping noise'
      };
    }

    // Redact PII
    const redacted = redactSensitiveData(stripped);

    // Extract insights
    const productAreas = extractProductArea(redacted);
    const impact = assessImpact(redacted);
    const sentiment = assessSentiment(redacted);

    // Extract error mentions
    const errorPatterns = [
      /\b(?:5\d{2}|4\d{2})\s*(?:error|status)?\b/gi,
      /\b(?:error|exception|failure|crash|timeout|bug)\b/gi,
    ];
    const errors = [];
    for (const pat of errorPatterns) {
      const matches = redacted.match(pat);
      if (matches) {
        for (const m of matches) {
          const clean = m.trim();
          if (!errors.includes(clean)) errors.push(clean);
        }
      }
    }

    // Extract and normalize timestamps to ISO UTC
    const timestamps = [];

    // 1. Check for RFC Date header in original content
    let baseDate = null;
    const dateHeaderMatch = content.match(/^Date:\s*(.+)$/im);
    if (dateHeaderMatch) {
      const parsedHeader = new Date(dateHeaderMatch[1].trim());
      if (!isNaN(parsedHeader.getTime())) {
        baseDate = parsedHeader;
        timestamps.push(parsedHeader.toISOString());
      }
    }

    // 2. Check for explicit ISO timestamps in text
    const isoMatches = redacted.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g);
    if (isoMatches) {
      for (const iso of isoMatches) {
        const d = new Date(iso);
        if (!isNaN(d.getTime())) {
          const isoStr = d.toISOString();
          if (!timestamps.includes(isoStr)) timestamps.push(isoStr);
          if (!baseDate) baseDate = d;
        }
      }
    }

    // 3. Fall back to file modification time if available
    if (!baseDate && filePath && fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        baseDate = stat.mtime;
        timestamps.push(stat.mtime.toISOString());
      } catch {
        // Ignore file stat errors
      }
    }

    // 4. Resolve relative time mentions (e.g., "since 2pm", "at 14:00") against base date
    if (baseDate) {
      const timeMatches = [...redacted.matchAll(/\b(?:since\s+|at\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/gi)];
      for (const m of timeMatches) {
        let hour = parseInt(m[1], 10);
        const minute = m[2] ? parseInt(m[2], 10) : 0;
        const ampm = m[3] ? m[3].toLowerCase() : null;

        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;

        if (ampm || m[0].toLowerCase().includes('since') || m[0].toLowerCase().includes('at')) {
          const resolved = new Date(baseDate);
          resolved.setUTCHours(hour, minute, 0, 0);
          const iso = resolved.toISOString();
          if (!timestamps.includes(iso)) timestamps.push(iso);
        }
      }
    }

    // Build summary
    const summary = redacted.length > 200 ? `${redacted.substring(0, 197)}...` : redacted;

    return {
      id,
      source: 'email',
      type: 'text',
      summary,
      entities: productAreas,
      errors,
      timestamps,
      confidence: 0.6,
      status: 'ok',
      productAreas,
      impact,
      sentiment,
      strippedContent: redacted
    };
  } catch (err) {
    return {
      id,
      source: 'email',
      type: 'text',
      summary: `Email processing failed: ${err.message}`,
      entities: [],
      errors: [],
      timestamps: [],
      confidence: 0,
      status: 'failed',
      reason: err.message
    };
  }
}

export {
  stripEmailNoise,
  extractProductArea,
  assessImpact,
  assessSentiment
};
