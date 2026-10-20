import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../utils/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let watcherInstance = null;
let pollTimer = null;
let currentOffset = 0;
let partialBuffer = '';
const pendingTemplateCounts = new Map();

function getLogPath(customPath) {
  if (customPath) return path.resolve(customPath);
  if (process.env.DEMO_LMS_LOG_PATH) return path.resolve(process.env.DEMO_LMS_LOG_PATH);
  return path.resolve(path.join(__dirname, '..', '..', 'demo-lms', 'logs', 'app.log'));
}

/**
 * Creates normalized template from an ERROR log line.
 * Input: 2026-10-20T10:42:11.123Z ERROR POST /upload 500 12ms msg="MongoNotConnectedError: ..."
 * Output: POST /upload <NUM> msg="MongoNotConnectedError: ..."
 */
export function templateFromErrorLine(line) {
  if (!line || typeof line !== 'string') return '';

  // Extract content after "ERROR "
  const errorIdx = line.indexOf('ERROR');
  let relevantPart = errorIdx !== -1 ? line.substring(errorIdx + 5).trim() : line.trim();

  // Strip method duration e.g. " 12ms"
  relevantPart = relevantPart.replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, '');

  // Run general normalizer (strips timestamps, IDs, hostnames, numbers)
  return normalizeText(relevantPart);
}

export function readNewLogEntries(logFilePath) {
  if (!fs.existsSync(logFilePath)) return;

  try {
    const stat = fs.statSync(logFilePath);

    // Handle truncation / rotation
    if (stat.size < currentOffset) {
      currentOffset = 0;
      partialBuffer = '';
    }

    if (stat.size > currentOffset) {
      const bytesToRead = stat.size - currentOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(logFilePath, 'r');

      try {
        fs.readSync(fd, buffer, 0, bytesToRead, currentOffset);
        currentOffset = stat.size;
      } finally {
        fs.closeSync(fd);
      }

      const chunk = partialBuffer + buffer.toString('utf8');
      const lines = chunk.split(/\r?\n/);

      // The last element is an incomplete line if chunk did not end with \n
      partialBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.includes('ERROR')) {
          const template = templateFromErrorLine(line);
          if (template) {
            const current = pendingTemplateCounts.get(template) || 0;
            pendingTemplateCounts.set(template, current + 1);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[LogWatcher] Error reading log file:', err.message);
  }
}

async function sendSignal(signal, incidentIqUrl) {
  try {
    const targetUrl = incidentIqUrl || process.env.INCIDENTIQ_URL || 'http://localhost:5000/incidents';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signal),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[LogWatcher] IncidentIQ responded with status ${res.status}`);
    }
  } catch (err) {
    console.warn(`[LogWatcher] Failed to send signal to IncidentIQ: ${err.message}`);
  }
}

/**
 * Flush accumulated error templates and send signals to IncidentIQ.
 */
export async function flushErrorTemplates(incidentIqUrl, service = 'demo-lms') {
  if (pendingTemplateCounts.size === 0) return [];

  const sentSignals = [];
  const entries = Array.from(pendingTemplateCounts.entries());
  pendingTemplateCounts.clear();

  for (const [template, count] of entries) {
    const signal = {
      source: 'log_watcher',
      service,
      message: template,
      count,
      timestamp: new Date().toISOString()
    };

    sentSignals.push(signal);
    await sendSignal(signal, incidentIqUrl);
  }

  return sentSignals;
}

export function startLogWatcher(options = {}) {
  if (pollTimer) return;

  const logFilePath = getLogPath(options.logFilePath);
  const flushIntervalMs = Number(options.intervalMs) || 5000;

  // Initialize offset at the end of the file
  if (fs.existsSync(logFilePath)) {
    try {
      currentOffset = fs.statSync(logFilePath).size;
    } catch {
      currentOffset = 0;
    }
  } else {
    currentOffset = 0;
  }
  partialBuffer = '';
  pendingTemplateCounts.clear();

  console.log(`[LogWatcher] Started watching log file: ${logFilePath} (offset: ${currentOffset})`);

  // Watch file changes
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    watcherInstance = fs.watch(dir, (eventType, filename) => {
      if (!filename || filename === path.basename(logFilePath)) {
        readNewLogEntries(logFilePath);
      }
    });
  } catch (err) {
    console.warn('[LogWatcher] fs.watch not active, falling back to periodic read:', err.message);
  }

  // Periodic flush every 5 seconds
  pollTimer = setInterval(async () => {
    readNewLogEntries(logFilePath);
    await flushErrorTemplates(options.incidentIqUrl, options.service);
  }, flushIntervalMs);

  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
}

export function stopLogWatcher() {
  if (watcherInstance) {
    try {
      watcherInstance.close();
    } catch {}
    watcherInstance = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[LogWatcher] Stopped log watcher daemon.');
  }
}

export function resetLogWatcherState() {
  currentOffset = 0;
  partialBuffer = '';
  pendingTemplateCounts.clear();
}
