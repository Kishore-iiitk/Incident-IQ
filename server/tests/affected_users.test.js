import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDB, disconnectDB } from '../db/connection.js';
import { Incident, Artifact } from '../models/index.js';

describe('Affected Users & Probe Signal Isolation Tests', () => {
  let app;

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

  test('Three probe-triggered reporter signals plus one real user signal give affected_users = 1', async () => {
    // 1. Send three probe-triggered reporter signals (user_role: "probe", no user_id)
    for (let i = 0; i < 3; i++) {
      const probeRes = await request(app).post('/incidents').send({
        source: 'reporter',
        service: 'demo-lms',
        endpoint: '/courses',
        status: 500,
        message: 'MongoNotConnectedError: Connection closed during probe',
        user_role: 'probe',
        user_id: null
      });
      assert.ok([200, 202].includes(probeRes.status));
    }

    let incidents = await Incident.find({});
    assert.equal(incidents.length, 1, 'Should create exactly 1 incident');
    assert.equal(incidents[0].affected_users, 0, 'Probe signals must not increment affected_users');
    assert.deepEqual(incidents[0].affected_user_ids, [], 'Probe signals must not record user IDs');
    assert.ok(incidents[0].sources.includes('reporter'), 'Incident should record reporter source');

    // Verify 3 artifacts attached from probes
    let artifacts = await Artifact.find({ incident_id: incidents[0]._id });
    assert.equal(artifacts.length, 3, 'Probe signals must still attach artifacts');

    // 2. Send one real user signal (user_role: "student", user_id: "user_alice")
    const userRes = await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Client must be connected before running operations',
      user_role: 'student',
      user_id: 'user_alice'
    });
    assert.ok([200, 202].includes(userRes.status));

    incidents = await Incident.find({});
    assert.equal(incidents.length, 1, 'Still exactly 1 incident');
    assert.equal(incidents[0].affected_users, 1, 'Real user signal increments affected_users to 1');
    assert.deepEqual(incidents[0].affected_user_ids, ['user_alice']);

    artifacts = await Artifact.find({ incident_id: incidents[0]._id });
    assert.equal(artifacts.length, 4, '4 artifacts total attached');
  });

  test('The same user failing twice still gives affected_users = 1', async () => {
    // First failure from user_alice
    await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Connection closed',
      user_role: 'student',
      user_id: 'user_alice'
    });

    let incident = await Incident.findOne({});
    assert.equal(incident.affected_users, 1);
    assert.deepEqual(incident.affected_user_ids, ['user_alice']);

    // Second failure from the same user_alice
    await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Connection closed',
      user_role: 'student',
      user_id: 'user_alice'
    });

    incident = await Incident.findOne({});
    assert.equal(incident.affected_users, 1, 'Duplicate failure from same user must NOT increment affected_users');
    assert.deepEqual(incident.affected_user_ids, ['user_alice']);

    const artifacts = await Artifact.find({ incident_id: incident._id });
    assert.equal(artifacts.length, 2, 'Both artifacts should still be recorded');
  });

  test('Two different users give affected_users = 2', async () => {
    // First user: user_alice
    await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Connection closed',
      user_role: 'student',
      user_id: 'user_alice'
    });

    // Second user: user_bob
    await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Connection closed',
      user_role: 'student',
      user_id: 'user_bob'
    });

    const incident = await Incident.findOne({});
    assert.equal(incident.affected_users, 2, 'Two distinct users must give affected_users = 2');
    assert.deepEqual(incident.affected_user_ids.sort(), ['user_alice', 'user_bob']);
  });

  test('Signals with no user id do not increment affected_users', async () => {
    // Signal without user_id
    await request(app).post('/incidents').send({
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: Connection closed',
      user_role: 'student'
      // user_id omitted
    });

    const incident = await Incident.findOne({});
    assert.equal(incident.affected_users, 0, 'Signals without user_id must not increment affected_users');
    assert.deepEqual(incident.affected_user_ids, []);
  });
});
