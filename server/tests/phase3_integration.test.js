import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../app.js';
import { connectDB, disconnectDB } from '../db/connection.js';
import { Incident, Artifact } from '../models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 3 Integration: Collectors, Fingerprinting & Deduplication', () => {
  let app;
  const fixturesDir = path.join(__dirname, 'fixtures', 'phase3');

  const dbReporter = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_reporter.json'), 'utf8'));
  const dbPoller = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_poller.json'), 'utf8'));
  const dbLogWatcher = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_log_watcher.json'), 'utf8'));
  const uploadReporter = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'upload_fault_reporter.json'), 'utf8'));

  before(async () => {
    process.env.DEMO_MODE = 'true';
    await connectDB();
    app = createApp();
  });

  after(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Incident.deleteMany({});
    await Artifact.deleteMany({});
  });

  test('Integration 1: DB-fault signals from reporter, poller, and log watcher posted concurrently create exactly ONE incident with all 3 sources and artifacts attached', async () => {
    // Post all three signals at the exact same moment using Promise.all
    const responses = await Promise.all([
      request(app).post('/incidents').send(dbReporter),
      request(app).post('/incidents').send(dbPoller),
      request(app).post('/incidents').send(dbLogWatcher)
    ]);

    // All should succeed (200 or 202)
    for (const res of responses) {
      assert.ok([200, 202].includes(res.status), `Expected 200 or 202, got ${res.status}`);
    }

    // Exactly one incident must exist in database
    const allIncidents = await Incident.find({});
    assert.equal(allIncidents.length, 1, `Expected exactly 1 incident, found ${allIncidents.length}`);

    const incident = allIncidents[0];

    // Incident sources must contain all three distinct sources
    assert.ok(incident.sources.includes('reporter'), 'Incident sources must include reporter');
    assert.ok(incident.sources.includes('poller'), 'Incident sources must include poller');
    assert.ok(incident.sources.includes('log_watcher'), 'Incident sources must include log_watcher');
    assert.equal(incident.sources.length, 3, 'Incident must have exactly 3 sources');

    // Only "reporter" increments affected_users (poller and log_watcher are synthetic)
    assert.equal(incident.affected_users, 1, `Expected affected_users to be 1, got ${incident.affected_users}`);

    // All 3 artifacts must be attached to this incident
    const artifacts = await Artifact.find({ incident_id: incident._id });
    assert.equal(artifacts.length, 3, `Expected 3 artifacts attached to incident, got ${artifacts.length}`);

    const artifactSources = artifacts.map(a => a.source);
    assert.ok(artifactSources.includes('reporter'));
    assert.ok(artifactSources.includes('poller'));
    assert.ok(artifactSources.includes('log_watcher'));

    // Check endpoint metadata preserved on artifacts
    const pollerArtifact = artifacts.find(a => a.source === 'poller');
    assert.equal(pollerArtifact.metadata.endpoint, '/courses');
  });

  test('Integration 2: A DB fault signal and an upload fault signal create exactly TWO incidents', async () => {
    const resDb = await request(app).post('/incidents').send(dbReporter).expect(202);
    const resUpload = await request(app).post('/incidents').send(uploadReporter).expect(202);

    assert.notEqual(resDb.body.id, resUpload.body.id, 'DB and Upload incidents must have different IDs');

    const allIncidents = await Incident.find({});
    assert.equal(allIncidents.length, 2, 'Must create exactly two distinct incidents');

    const fingerprints = allIncidents.map(i => i.fingerprint);
    assert.notEqual(fingerprints[0], fingerprints[1], 'Incidents must have distinct fingerprints');
  });

  test('Dedup Window: An incident older than 10 minutes does not absorb a new signal', async () => {
    // 1. Create older incident with the DB fault fingerprint 15 minutes ago
    const oldDate = new Date(Date.now() - 15 * 60 * 1000);
    const oldIncident = await Incident.create({
      title: 'Historical DB Outage',
      description: 'DB failure from 15 mins ago',
      status: 'processing',
      fingerprint: '61018fc96fdbbc3e',
      sources: ['reporter'],
      created_at: oldDate,
      last_seen: oldDate
    });

    // 2. Send new DB fault signal
    const res = await request(app).post('/incidents').send(dbReporter).expect(202);

    assert.notEqual(res.body.id, oldIncident._id.toString(), 'Should not deduplicate against an incident older than 10 minutes');

    const count = await Incident.countDocuments({});
    assert.equal(count, 2, 'Should create a new incident when existing one is older than 10 minutes');
  });

  test('Dedup Window: A resolved incident does not absorb a new signal', async () => {
    // 1. Create already resolved incident with the same fingerprint
    const resolvedIncident = await Incident.create({
      title: 'Resolved DB Outage',
      description: 'DB failure resolved',
      status: 'resolved',
      fingerprint: '61018fc96fdbbc3e',
      sources: ['reporter'],
      created_at: new Date(),
      last_seen: new Date(),
      resolved_at: new Date()
    });

    // 2. Send new DB fault signal
    const res = await request(app).post('/incidents').send(dbReporter).expect(202);

    assert.notEqual(res.body.id, resolvedIncident._id.toString(), 'Resolved incident must not absorb new signal');

    const count = await Incident.countDocuments({});
    assert.equal(count, 2, 'Should create a new incident when existing one is resolved');
  });
});
