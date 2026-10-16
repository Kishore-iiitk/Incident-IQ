import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDB, disconnectDB } from '../db/connection.js';
import { Incident } from '../models/index.js';

describe('Incidents API Endpoint', () => {
  let app;

  before(async () => {
    await connectDB();
    app = createApp();
  });

  after(async () => {
    await disconnectDB();
  });

  test('POST /incidents returns immediately with status 202 and incident ID', async () => {
    const startTime = Date.now();
    const payload = {
      text: 'Students cannot open assignment pages since 2pm, 500 error.'
    };

    const response = await request(app)
      .post('/incidents')
      .send(payload)
      .expect(202);

    const elapsedMs = Date.now() - startTime;

    assert.ok(response.body.id, 'Response should contain the generated incident ID');
    assert.equal(response.body.status, 'processing');
    assert.ok(elapsedMs < 1000, `API must return immediately (<1000ms), took ${elapsedMs}ms`);

    // Verify incident was saved in database
    const saved = await Incident.findById(response.body.id);
    assert.ok(saved);
    assert.equal(saved.description, payload.text);
  });
});
