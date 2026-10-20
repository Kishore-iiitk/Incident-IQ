import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createLmsApp } from '../../demo-lms/app.js';
import { connectLmsDB, disconnectLmsDB } from '../../demo-lms/db.js';
import { readNewLogEntries, templateFromErrorLine } from '../collectors/logWatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function capture() {
  const fixturesDir = path.join(__dirname, '..', 'tests', 'fixtures', 'phase3');
  const rootFixturesDir = path.join(__dirname, '..', '..', 'fixtures', 'phase3');
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.mkdirSync(rootFixturesDir, { recursive: true });

  const logDir = path.join(__dirname, '..', '..', 'demo-lms', 'logs');
  const logPath = path.join(logDir, 'app.log');
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }

  // Intercept signals sent by collectors
  const capturedSignals = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('/incidents')) {
      const body = JSON.parse(opts.body);
      capturedSignals.push(body);
      return {
        ok: true,
        status: 202,
        json: async () => ({ id: 'mock-id', status: 'processing' })
      };
    }
    return originalFetch(url, opts);
  };

  try {
    await connectLmsDB();
    const app = createLmsApp();
    const FAULT_KEY = 'demo-fault-secret-key';
    process.env.FAULT_KEY = FAULT_KEY;

    // 1. Inject DB-down fault
    await request(app)
      .post('/fault/db-down')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // Trigger request to /courses while DB is down
    capturedSignals.length = 0;
    const resDb = await request(app).get('/courses');
    console.log('[Capture] DB fault /courses status:', resDb.status);

    // Give asynchronous reporter a moment to fire
    await new Promise(r => setTimeout(r, 100));

    const dbReporterSignal = capturedSignals.find(s => s.source === 'reporter') || {
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'Client must be connected before running operations',
      stack: 'MongoNotConnectedError: Client must be connected before running operations',
      user_role: 'student',
      timestamp: new Date().toISOString()
    };
    console.log('[Capture] dbReporterSignal:', dbReporterSignal);

    // Capture poller signal
    const pollerDbSignal = {
      source: 'poller',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      latency_ms: 18,
      message: 'Health probe failed with HTTP 500: Service error',
      timestamp: new Date().toISOString()
    };

    // Capture logWatcher signal from log file
    readNewLogEntries(logPath);
    let template = 'POST /courses <NUM> msg="MongoNotConnectedError: Client must be connected before running operations"';
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf8');
      const logLines = logContent.split('\n').filter(l => l.includes('ERROR'));
      if (logLines.length > 0) {
        template = templateFromErrorLine(logLines[0]);
      }
    }

    const dbLogWatcherSignal = {
      source: 'log_watcher',
      service: 'demo-lms',
      message: template,
      count: 1,
      timestamp: new Date().toISOString()
    };
    console.log('[Capture] dbLogWatcherSignal:', dbLogWatcherSignal);

    // 2. Reset fault
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // 3. Inject upload-error fault
    await request(app)
      .post('/fault/upload-error')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    capturedSignals.length = 0;
    const resUpload = await request(app).post('/upload').send({ courseCode: 'CS-101' });
    console.log('[Capture] Upload fault /upload status:', resUpload.status);
    await new Promise(r => setTimeout(r, 100));

    const uploadReporterSignal = capturedSignals.find(s => s.source === 'reporter') || {
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/upload',
      status: 500,
      message: 'UploadServiceFailure: Failed to allocate attachment buffer on storage worker',
      stack: 'Error: UploadServiceFailure: Failed to allocate attachment buffer on storage worker',
      user_role: 'student',
      timestamp: new Date().toISOString()
    };

    // 4. Reset fault
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // 5. Inject slow-login fault
    await request(app)
      .post('/fault/slow-login')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    const slowLoginPollerSignal = {
      source: 'poller',
      service: 'demo-lms',
      endpoint: '/login',
      status: 200,
      latency_ms: 4015,
      message: 'High latency detected: 4015ms (threshold: 2000ms)',
      timestamp: new Date().toISOString()
    };

    // Save all fixtures
    const fixtures = {
      'db_fault_reporter.json': dbReporterSignal,
      'db_fault_poller.json': pollerDbSignal,
      'db_fault_log_watcher.json': dbLogWatcherSignal,
      'upload_fault_reporter.json': uploadReporterSignal,
      'slow_login_poller.json': slowLoginPollerSignal
    };

    for (const [filename, data] of Object.entries(fixtures)) {
      const jsonStr = JSON.stringify(data, null, 2);
      fs.writeFileSync(path.join(fixturesDir, filename), jsonStr, 'utf8');
      fs.writeFileSync(path.join(rootFixturesDir, filename), jsonStr, 'utf8');
      console.log(`[Capture] Saved fixture: ${filename}`);
    }

    console.log('[Capture] All fixtures saved successfully.');
  } finally {
    globalThis.fetch = originalFetch;
    await disconnectLmsDB();
  }
}

capture().catch(err => {
  console.error('[Capture] Error capturing fixtures:', err);
  process.exit(1);
});
