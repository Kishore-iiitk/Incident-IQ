/**
 * Log Processor (Phase 4)
 * Parses log files: demo LMS format, generic ISO timestamp lines, Apache-style logs.
 * Extracts stack traces, clusters repeated lines into templates with counts,
 * normalizes timestamps to ISO UTC, and optionally summarizes via Gemini.
 * 
 * NEVER throws. Returns Evidence record with status "ok", "failed", or "skipped".
 */

import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveData } from '../utils/redactor.js';

// ---------- Log format regexes ----------

// Demo LMS format: 2026-10-20T10:42:11.123Z ERROR POST /upload 500 12ms msg="MongoNotConnectedError: ..."
const DEMO_LMS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(ERROR|WARN|INFO|DEBUG)\s+(\w+)\s+(\/\S*)\s+(\d{3})\s+(\d+)ms\s+msg="(.*)"\s*$/;

// Generic ISO timestamp line: 2026-10-20T10:42:11.123Z  anything
const GENERIC_ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.+)$/;

// Apache combined log: 127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /path HTTP/1.0" 200 2326
const APACHE_ACCESS_RE = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\w+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})\s+(\d+|-)/;

// Apache error log: [Wed Oct 11 14:32:52.00000 2000] [error] [pid 29] message
const APACHE_ERROR_RE = /^\[([^\]]+)\]\s+\[(\w+)\]\s+(?:\[pid\s+\d+\])?\s*(.+)$/;

// Stack trace line detection
const STACK_TRACE_RE = /^\s+at\s+|^\s*Error:|^\s*Caused\s+by:/i;

// Size limit: 5 MB
const MAX_LOG_SIZE = 5 * 1024 * 1024;

// ---------- Timestamp normalization ----------

function normalizeTimestamp(raw) {
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch { /* fall through */ }

  try {
    const apacheMatch = raw.match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s*([+-]\d{4})?/);
    if (apacheMatch) {
      const [, day, mon, year, time, tz] = apacheMatch;
      const dateStr = `${day} ${mon} ${year} ${time} ${tz || '+0000'}`;
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
  } catch { /* fall through */ }

  return raw;
}

// ---------- Template clustering ----------

function templatizeLine(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIMESTAMP>')
    .replace(/\b\d{1,5}ms\b/g, '<DURATION>')
    .replace(/\b\d{10,13}\b/g, '<EPOCH>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<OBJECT_ID>')
    .replace(/\b\d+\.\d+\.\d+\.\d+\b/g, '<IP>')
    .trim();
}

function clusterLines(parsedLines) {
  const templateMap = new Map();

  for (const line of parsedLines) {
    const template = templatizeLine(line.raw || line.message || '');
    if (!template) continue;

    if (templateMap.has(template)) {
      const entry = templateMap.get(template);
      entry.count++;
      if (line.timestamp && !entry.timestamps.includes(line.timestamp)) {
        entry.timestamps.push(line.timestamp);
      }
    } else {
      templateMap.set(template, {
        template,
        count: 1,
        level: line.level || 'INFO',
        timestamps: line.timestamp ? [line.timestamp] : [],
        sample: line.raw || line.message || ''
      });
    }
  }

  // Sort by count descending, return top 30
  return Array.from(templateMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
}

// ---------- Line parsing ----------

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Try demo LMS format
  let match = trimmed.match(DEMO_LMS_RE);
  if (match) {
    const [, ts, level, method, route, status, duration, msg] = match;
    return {
      timestamp: normalizeTimestamp(ts),
      level,
      method,
      route,
      status: parseInt(status),
      duration: parseInt(duration),
      message: msg,
      raw: trimmed,
      format: 'demo_lms'
    };
  }

  // Try Apache access log
  match = trimmed.match(APACHE_ACCESS_RE);
  if (match) {
    const [, ip, dateStr, method, path, status] = match;
    return {
      timestamp: normalizeTimestamp(dateStr),
      level: parseInt(status) >= 500 ? 'ERROR' : parseInt(status) >= 400 ? 'WARN' : 'INFO',
      method,
      route: path,
      status: parseInt(status),
      message: trimmed,
      raw: trimmed,
      format: 'apache_access'
    };
  }

  // Try Apache error log
  match = trimmed.match(APACHE_ERROR_RE);
  if (match) {
    const [, dateStr, level, msg] = match;
    return {
      timestamp: normalizeTimestamp(dateStr),
      level: level.toUpperCase(),
      message: msg,
      raw: trimmed,
      format: 'apache_error'
    };
  }

  // Try generic ISO timestamp line
  match = trimmed.match(GENERIC_ISO_RE);
  if (match) {
    const [, ts, rest] = match;
    const levelMatch = rest.match(/^\s*(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i);
    return {
      timestamp: normalizeTimestamp(ts),
      level: levelMatch ? levelMatch[1].toUpperCase() : 'INFO',
      message: rest,
      raw: trimmed,
      format: 'generic_iso'
    };
  }

  // Unstructured line
  return {
    timestamp: null,
    level: 'INFO',
    message: trimmed,
    raw: trimmed,
    format: 'unstructured'
  };
}

// ---------- Stack trace extraction ----------

function extractStackTraces(lines) {
  const stacks = [];
  let current = null;

  for (const line of lines) {
    if (STACK_TRACE_RE.test(line)) {
      if (!current) {
        current = [];
      }
      current.push(line.trim());
    } else if (current) {
      stacks.push(current.join('\n'));
      current = null;
    }
  }

  if (current) {
    stacks.push(current.join('\n'));
  }

  return stacks;
}

// ---------- Entity and error extraction ----------

function extractEntities(parsedLines) {
  const entities = new Set();
  const errors = new Set();
  const timestamps = new Set();

  for (const line of parsedLines) {
    if (!line) continue;

    if (line.timestamp) timestamps.add(line.timestamp);
    if (line.route) entities.add(line.route);

    const msg = line.message || line.raw || '';

    // Error codes
    const statusCodes = msg.match(/\b[45]\d{2}\b/g);
    if (statusCodes) statusCodes.forEach(c => errors.add(`HTTP ${c}`));

    // Error messages
    const errorPatterns = [
      /\b(MongoNotConnectedError|MongoServerError|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/gi,
      /\b(NullPointerException|OutOfMemoryError|StackOverflowError)\b/gi,
      /\b(connection\s+refused|timeout|deadlock|segfault)\b/gi,
    ];
    for (const pat of errorPatterns) {
      const matches = msg.match(pat);
      if (matches) matches.forEach(m => errors.add(m));
    }

    // Service entities
    const servicePatterns = /\b([a-zA-Z0-9_-]+(?:service|gateway|api|db|auth|worker))\b/gi;
    const svcMatches = msg.match(servicePatterns);
    if (svcMatches) svcMatches.forEach(s => entities.add(s.toLowerCase()));
  }

  return {
    entities: [...entities],
    errors: [...errors],
    timestamps: [...timestamps].slice(0, 50)
  };
}

// ---------- Main processor ----------

/**
 * Process a log file and return an Evidence record.
 * @param {object} params
 * @param {string} [params.content] - Raw log content
 * @param {string} [params.filePath] - Path to log file
 * @param {string} [params.id="EV-01"] - Evidence ID
 * @param {object} [params.geminiClient] - Optional Gemini client for summarization
 * @returns {object} Evidence record
 */
export async function processLog({ content, filePath, id = 'EV-01', geminiClient } = {}) {
  try {
    if (content === undefined && !filePath) {
      return {
        id,
        source: 'log_file',
        type: 'log',
        summary: 'No log file or content provided',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'skipped',
        reason: 'No log input provided'
      };
    }

    if (content !== undefined && (!content || typeof content !== 'string' || content.trim().length === 0)) {
      return {
        id,
        source: 'log_file',
        type: 'log',
        summary: 'Empty or invalid log content',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Empty or invalid log content'
      };
    }

    if (!content && filePath) {
      if (!fs.existsSync(filePath)) {
        return {
          id,
          source: 'log_file',
          type: 'log',
          summary: 'Log file not found',
          entities: [],
          errors: [],
          timestamps: [],
          confidence: 0,
          status: 'skipped',
          reason: `File not found: ${filePath}`
        };
      }

      const stats = fs.statSync(filePath);
      if (stats.size > MAX_LOG_SIZE) {
        return {
          id,
          source: 'log_file',
          type: 'log',
          summary: `Log file too large (${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds 5 MB limit)`,
          entities: [],
          errors: [],
          timestamps: [],
          confidence: 0,
          status: 'failed',
          reason: `File size exceeds 5 MB limit: ${stats.size} bytes`
        };
      }

      if (stats.size === 0) {
        return {
          id,
          source: 'log_file',
          type: 'log',
          summary: 'Log file is empty (0 bytes)',
          entities: [],
          errors: [],
          timestamps: [],
          confidence: 0,
          status: 'failed',
          reason: 'Log file is empty (0 bytes)'
        };
      }

      content = fs.readFileSync(filePath, 'utf8');
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return {
        id,
        source: 'log_file',
        type: 'log',
        summary: 'Empty or invalid log content',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Empty or invalid log content'
      };
    }

    const rawLines = content.split('\n');
    const parsedLines = rawLines.map(parseLine).filter(Boolean);

    if (parsedLines.length === 0) {
      return {
        id,
        source: 'log_file',
        type: 'log',
        summary: 'No parseable lines found in log',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0.1,
        status: 'failed',
        reason: 'No parseable log lines'
      };
    }

    const stacks = extractStackTraces(rawLines);
    const templates = clusterLines(parsedLines);
    const { entities, errors, timestamps } = extractEntities(parsedLines);

    // Determine error/warn counts
    const errorCount = parsedLines.filter(l => l.level === 'ERROR' || l.level === 'FATAL').length;
    const warnCount = parsedLines.filter(l => l.level === 'WARN').length;

    // Send only top templates (maximum 30 lines) to Gemini
    const topTemplates = templates.slice(0, 30);
    const templateSummary = topTemplates
      .map(t => `[${t.level}] (x${t.count}) ${t.template}`)
      .join('\n');

    let summary = '';
    let confidence = 0.7;

    // Try Gemini summarization
    if (geminiClient) {
      try {
        const redactedTemplates = redactSensitiveData(templateSummary);
        const prompt = `Summarize these server log templates concisely (2-3 sentences). Focus on errors, patterns, and likely root cause:
${redactedTemplates}

${stacks.length > 0 ? `Stack traces found:\n${redactSensitiveData(stacks.slice(0, 3).join('\n---\n'))}` : ''}

Return a JSON object: {"summary": "your summary here"}`;

        const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        const response = await geminiClient.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });

        const text = response.text || (typeof response === 'string' ? response : JSON.stringify(response));
        let parsed;
        try {
          const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          const firstBrace = cleaned.indexOf('{');
          const lastBrace = cleaned.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            parsed = JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
          }
        } catch { /* fallback below */ }

        if (parsed && parsed.summary) {
          summary = parsed.summary;
          confidence = 0.85;
        }
      } catch (geminiErr) {
        console.warn(`[LogProcessor] Gemini summarization failed: ${geminiErr.message}. Using template summary with lower confidence.`);
      }
    }

    // Fallback summary from templates with lower confidence
    if (!summary) {
      const topErrors = templates.filter(t => t.level === 'ERROR' || t.level === 'FATAL');
      if (topErrors.length > 0) {
        summary = `Log analysis: ${parsedLines.length} lines parsed, ${errorCount} errors, ${warnCount} warnings. Top error patterns: ${topErrors.slice(0, 3).map(t => `"${t.sample.substring(0, 80)}" (x${t.count})`).join('; ')}`;
      } else {
        summary = `Log analysis: ${parsedLines.length} lines parsed, ${errorCount} errors, ${warnCount} warnings.`;
      }
      confidence = 0.5;
    }

    return {
      id,
      source: 'log_file',
      type: 'log',
      summary,
      entities,
      errors,
      timestamps,
      confidence,
      status: 'ok',
      templates,
      stackTraces: stacks,
      lineCount: parsedLines.length,
      errorCount,
      warnCount
    };
  } catch (err) {
    return {
      id,
      source: 'log_file',
      type: 'log',
      summary: `Log processing failed: ${err.message}`,
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
  parseLine,
  clusterLines,
  extractStackTraces,
  extractEntities,
  normalizeTimestamp,
  templatizeLine,
  DEMO_LMS_RE,
  GENERIC_ISO_RE,
  APACHE_ACCESS_RE,
  APACHE_ERROR_RE
};
