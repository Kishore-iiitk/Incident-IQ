import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLmsApp } from '../../demo-lms/app.js';
import { connectLmsDB, disconnectLmsDB } from '../../demo-lms/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Demo LMS Service & Fault Injection', () => {
  let app;
  const FAULT_KEY = 'test-fault-key-999';

  before(async () => {
    process.env.FAULT_KEY = FAULT_KEY;
    process.env.FAULT_SLOW_MS = '300'; // short delay for fast test
    await connectLmsDB();
    app = createLmsApp();
  });

  after(async () => {
    await disconnectLmsDB();
  });

  test('GET /courses returns HTTP 200 with course directory HTML', async () => {
    const res = await request(app).get('/courses').expect(200);
    assert.ok(res.text.includes('Course Catalog'));
    assert.ok(res.text.includes('CS-101'));
  });

  test('POST /login verifies credentials against DB', async () => {
    // Valid credentials
    const resValid = await request(app)
      .post('/login')
      .send({ username: 'student1', password: 'password123' })
      .expect(200);
    assert.ok(resValid.text.includes('Welcome, Alex Rivera'));

    // Invalid credentials
    const resInvalid = await request(app)
      .post('/login')
      .send({ username: 'student1', password: 'wrongpassword' })
      .expect(401);
    assert.ok(resInvalid.text.includes('Login Failed'));
  });

  test('POST /upload saves assignment submission to DB', async () => {
    const res = await request(app)
      .post('/upload')
      .send({ courseCode: 'CS-101', studentName: 'Alex Rivera', content: 'Assignment test content' })
      .expect(200);
    assert.ok(res.text.includes('Submission Received'));
  });

  test('Fault endpoints require valid X-Fault-Key header', async () => {
    await request(app).post('/fault/db-down').expect(401);
    await request(app).post('/fault/db-down').set('X-Fault-Key', 'wrong-key').expect(401);
  });

  test('Fault: db-down closes DB connection and causes /courses to fail with 500', async () => {
    // 1. Inject db-down
    await request(app)
      .post('/fault/db-down')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // 2. Querying courses fails with 500
    const res = await request(app).get('/courses').expect(500);
    assert.ok(res.text.includes('500 Internal Server Error') || res.text.includes('Client must be connected'));

    // 3. Reset fault
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // 4. Querying courses succeeds again
    const resRecovered = await request(app).get('/courses').expect(200);
    assert.ok(resRecovered.text.includes('Course Catalog'));
  });

  test('Fault: upload-error causes POST /upload to throw 500', async () => {
    await request(app)
      .post('/fault/upload-error')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    const res = await request(app)
      .post('/upload')
      .send({ courseCode: 'CS-101' })
      .expect(500);
    assert.ok(res.text.includes('UploadServiceFailure'));

    // Reset
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    await request(app)
      .post('/upload')
      .send({ courseCode: 'CS-101', content: 'Clean upload' })
      .expect(200);
  });

  test('Fault: slow-login introduces artificial delay to /login', async () => {
    await request(app)
      .post('/fault/slow-login')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    const start = Date.now();
    await request(app).get('/login').expect(200);
    const duration = Date.now() - start;

    assert.ok(duration >= 250, `Expected delay >= 250ms, took ${duration}ms`);

    // Reset
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);
  });

  test('app.log records structured single-line logs with timestamp, level, method, route, status, and duration', () => {
    const logPath = path.join(__dirname, '..', '..', 'demo-lms', 'logs', 'app.log');
    assert.ok(fs.existsSync(logPath), 'app.log must exist');

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'app.log should contain log lines');

    const sample = lines[lines.length - 1];
    // Check format: ISO timestamp, level, METHOD route status duration_ms, message
    assert.match(sample, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Log line must start with ISO timestamp');
    assert.match(sample, /\b(INFO|WARN|ERROR)\b/, 'Log line must have log level');
    assert.match(sample, /\b(GET|POST)\b/, 'Log line must have HTTP method');
    assert.match(sample, /\b\d{3}\b/, 'Log line must have HTTP status code');
    assert.match(sample, /\b\d+ms\b/, 'Log line must have duration in ms');
    assert.match(sample, /msg=".*"/, 'Log line must have msg attribute');
  });
});
