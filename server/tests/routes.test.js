import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../app.js';
import { Incident, Analysis } from '../models/index.js';
import { pipelineQueue } from '../pipeline.js';

let mongod;
let app;
let originalEnqueue;
let queuedJobs = [];

test('Client-Server Routes Suite', async (t) => {
  t.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    app = createApp();

    // Mock pipelineQueue.enqueue
    originalEnqueue = pipelineQueue.enqueue;
    pipelineQueue.enqueue = (job) => {
      queuedJobs.push(job);
    };
  });

  t.after(async () => {
    pipelineQueue.enqueue = originalEnqueue;
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  t.beforeEach(async () => {
    await Incident.deleteMany({});
    await Analysis.deleteMany({});
    queuedJobs = [];
  });

  await t.test('GET /health exists and returns status (not 404)', async () => {
    const res = await request(app).get('/health');
    assert.notEqual(res.status, 404, 'GET /health must not return 404');
    assert.equal(res.status, 200);
    assert.equal(res.body.database, 'connected');
    assert.equal(res.body.status, 'healthy');
  });

  await t.test('GET /incidents exists and returns incident list (not 404)', async () => {
    const res = await request(app).get('/incidents');
    assert.notEqual(res.status, 404, 'GET /incidents must not return 404');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.incidents || res.body));
  });

  await t.test('POST /incidents with multipart body and mocked pipeline exists (not 404)', async () => {
    const res = await request(app)
      .post('/incidents')
      .field('text', '500 internal server error on /login')
      .field('title', 'LMS Login Failure')
      .attach('files', Buffer.from('Error: connection refused at db:5432'), 'error.log');

    assert.notEqual(res.status, 404, 'POST /incidents must not return 404');
    assert.equal(res.status, 202);
    assert.ok(res.body.id);
    assert.equal(queuedJobs.length, 1, 'Pipeline should be queued with mocked enqueue');
    assert.equal(queuedJobs[0].text, '500 internal server error on /login');
  });

  await t.test('GET /incidents/:id exists and returns incident detail (not 404)', async () => {
    const inc = await Incident.create({
      title: 'Test Incident',
      description: 'Test incident description',
      status: 'review'
    });

    const res = await request(app).get(`/incidents/${inc._id}`);
    assert.notEqual(res.status, 404, 'GET /incidents/:id must not return 404 for existing incident');
    assert.equal(res.status, 200);
    assert.equal(res.body.incident._id, inc._id.toString());
  });

  await t.test('POST /incidents/:id/review exists and records human review (not 404)', async () => {
    const inc = await Incident.create({
      title: 'Reviewable Incident',
      description: 'Needs review',
      severity: 'P3',
      needs_review: true
    });

    const res = await request(app)
      .post(`/incidents/${inc._id}/review`)
      .send({
        field: 'severity',
        action: 'edit',
        new_value: 'P1',
        reviewer: 'oncall-lead'
      });

    assert.notEqual(res.status, 404, 'POST /incidents/:id/review must not return 404');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  await t.test('POST /incidents/:id/resolve exists and marks incident resolved (not 404)', async () => {
    const inc = await Incident.create({
      title: 'Resolvable Incident',
      description: 'Service restored',
      status: 'review'
    });

    const res = await request(app)
      .post(`/incidents/${inc._id}/resolve`)
      .send({
        root_cause: 'PostgreSQL max_connections reached',
        resolution: 'Increased max_connections to 200 and restarted pool'
      });

    assert.notEqual(res.status, 404, 'POST /incidents/:id/resolve must not return 404');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  await t.test('POST /incidents/:id/retry exists, returns 202 on failed and 409 on non-failed (not 404)', async () => {
    // 1. Non-failed incident returns 409 Conflict, not 404
    const activeInc = await Incident.create({
      title: 'Active Incident',
      description: 'Processing...',
      status: 'processing'
    });

    const nonFailedRes = await request(app).post(`/incidents/${activeInc._id}/retry`);
    assert.notEqual(nonFailedRes.status, 404, 'POST /incidents/:id/retry must not return 404');
    assert.equal(nonFailedRes.status, 409);

    // 2. Failed incident returns 202 Accepted, not 404
    const failedInc = await Incident.create({
      title: 'Failed Incident',
      description: 'Stage failed',
      status: 'failed',
      failed_stage: 'router'
    });

    const failedRes = await request(app).post(`/incidents/${failedInc._id}/retry`);
    assert.notEqual(failedRes.status, 404, 'POST /incidents/:id/retry must not return 404');
    assert.equal(failedRes.status, 202);
    assert.equal(failedRes.body.status, 'processing');
    assert.equal(queuedJobs.length, 1, 'Job should be enqueued for retry');
  });
});
