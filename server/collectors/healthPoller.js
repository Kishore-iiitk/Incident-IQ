import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHtmlText } from '../utils/htmlCleaner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pollTimer = null;
const lastSentMap = new Map(); // endpoint:failureType -> timestamp

function getTargets() {
  const configPath = path.join(__dirname, '..', 'config', 'poller_targets.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[HealthPoller] Failed to parse poller_targets.json:', err.message);
    }
  }

  return [
    { service: 'demo-lms', endpoint: '/login', method: 'GET' },
    { service: 'demo-lms', endpoint: '/courses', method: 'GET' },
    { service: 'demo-lms', endpoint: '/upload', method: 'GET' }
  ];
}

async function sendSignal(signal, incidentIqUrl) {
  const targetUrl = incidentIqUrl || process.env.INCIDENTIQ_URL || 'http://localhost:5000/incidents';
  const MAX_ATTEMPTS = 2; // 1 initial attempt + 1 retry

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`[HealthPoller] IncidentIQ responded with status ${res.status}`);
      }
      return;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[HealthPoller] Send attempt ${attempt} failed: ${err.message}. Retrying...`);
      } else {
        console.warn(`[HealthPoller] Failed to send signal to IncidentIQ after ${MAX_ATTEMPTS} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Execute a single poll cycle across all configured targets.
 */
export async function probeTargets({ baseUrl, incidentIqUrl, slowThresholdMs } = {}) {
  const host = baseUrl || process.env.DEMO_LMS_URL || 'http://localhost:4100';
  const slowThreshold = Number(slowThresholdMs || process.env.SLOW_THRESHOLD_MS) || 2000;
  const targets = getTargets();
  const results = [];

  for (const target of targets) {
    const url = `${host}${target.endpoint}`;
    const startTime = Date.now();
    let status = 0;
    let errMessage = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(url, {
        method: target.method || 'GET',
        headers: {
          'X-IncidentIQ-Probe': '1'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      status = res.status;
      if (status >= 400) {
        try {
          const body = await res.text();
          const match = body.match(/<p>(.*?)<\/p>/i) || body.match(/"error"\s*:\s*"([^"]+)"/i) || body.match(/"message"\s*:\s*"([^"]+)"/i);
          if (match) {
            errMessage = cleanHtmlText(match[1], 200);
          } else if (body) {
            errMessage = cleanHtmlText(body, 200);
          }
        } catch {
          // ignore body read error
        }
      }
    } catch (err) {
      status = 500;
      errMessage = cleanHtmlText(err.message, 200);
    }

    const latency = Date.now() - startTime;
    const isError = status >= 400;
    const isSlow = latency >= slowThreshold;

    if (isError || isSlow) {
      const failureType = isError ? 'error' : 'slow';
      const cooldownKey = `${target.endpoint}:${failureType}`;
      const now = Date.now();
      const lastSentTime = lastSentMap.get(cooldownKey) || 0;

      // Rate limit: at most one signal per endpoint and failure type per 60 seconds
      if (now - lastSentTime >= 60000) {
        lastSentMap.set(cooldownKey, now);

        const cleanErr = cleanHtmlText(errMessage, 200);
        const signal = {
          source: 'poller',
          service: target.service || 'demo-lms',
          endpoint: target.endpoint,
          status,
          latency_ms: latency,
          message: isError
            ? `Health probe failed with HTTP ${status}: ${cleanErr || 'Service error'}`
            : `High latency detected: ${latency}ms (threshold: ${slowThreshold}ms)`,
          timestamp: new Date().toISOString()
        };

        results.push(signal);
        await sendSignal(signal, incidentIqUrl);
      }
    }
  }

  return results;
}

export function startPoller(options = {}) {
  if (pollTimer) return;

  const intervalMs = Number(options.intervalMs || process.env.HEALTH_POLL_INTERVAL_MS) || 30000;
  console.log(`[HealthPoller] Started health poller daemon (interval: ${intervalMs}ms)`);

  // Run initial probe shortly after start
  setTimeout(() => {
    probeTargets(options).catch((err) => console.error('[HealthPoller] Probe error:', err.message));
  }, 1000);

  pollTimer = setInterval(() => {
    probeTargets(options).catch((err) => console.error('[HealthPoller] Probe error:', err.message));
  }, intervalMs);

  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
}

export function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[HealthPoller] Stopped health poller daemon.');
  }
}

export function resetPollerCooldowns() {
  lastSentMap.clear();
}
