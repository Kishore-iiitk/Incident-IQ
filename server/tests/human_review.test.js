import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../app.js';
import { Incident, Analysis, Review, ConfirmedIncident } from '../models/index.js';

let mongod;
let app;

test('Human Review & Resolution API Suite', async (t) => {
  t.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    app = createApp();
  });

  t.after(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  t.beforeEach(async () => {
    await Incident.deleteMany({});
    await Analysis.deleteMany({});
    await Review.deleteMany({});
    await ConfirmedIncident.deleteMany({});
  });

  await t.test('POST /incidents/:id/review logs approve action and clears needs_review', async () => {
    const inc = await Incident.create({
      title: 'Database connection spike',
      description: 'Spike in db connection errors',
      severity: 'P2',
      needs_review: true,
      assigned_team: 'Backend'
    });

    const res = await request(app)
      .post(`/incidents/${inc._id}/review`)
      .send({
        field: 'severity',
        action: 'approve',
        reviewer: 'alice'
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updatedInc = await Incident.findById(inc._id);
    assert.equal(updatedInc.needs_review, false);
    assert.equal(updatedInc.severity, 'P2');

    const review = await Review.findOne({ incident_id: inc._id });
    assert.ok(review);
    assert.equal(review.field, 'severity');
    assert.equal(review.action, 'approve');
    assert.equal(review.old_value, 'P2');
    assert.equal(review.new_value, 'P2');
    assert.equal(review.reviewer, 'alice');
  });

  await t.test('POST /incidents/:id/review logs edit action, updates incident and preserves audit trail', async () => {
    const inc = await Incident.create({
      title: 'File upload memory leak',
      description: 'Upload workers leaking memory',
      severity: 'P3',
      needs_review: true,
      assigned_team: 'Backend'
    });

    const res = await request(app)
      .post(`/incidents/${inc._id}/review`)
      .send({
        field: 'severity',
        action: 'edit',
        new_value: 'P1',
        reviewer: 'bob'
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updatedInc = await Incident.findById(inc._id);
    assert.equal(updatedInc.severity, 'P1');
    assert.equal(updatedInc.needs_review, false);

    const review = await Review.findOne({ incident_id: inc._id });
    assert.ok(review);
    assert.equal(review.action, 'edit');
    assert.equal(review.old_value, 'P3');
    assert.equal(review.new_value, 'P1');
    assert.equal(review.reviewer, 'bob');
  });

  await t.test('POST /incidents/:id/resolve marks incident resolved and saves confirmed incident record', async () => {
    const inc = await Incident.create({
      title: 'Database replica lag',
      description: 'Replica out of sync by 20 minutes',
      severity: 'P2',
      status: 'review'
    });

    const res = await request(app)
      .post(`/incidents/${inc._id}/resolve`)
      .send({
        root_cause: 'Network partition delayed WAL replication to standby replica',
        resolution: 'Resynced WAL and restored network route',
        symptoms: 'Read queries showing stale data'
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updatedInc = await Incident.findById(inc._id);
    assert.equal(updatedInc.status, 'resolved');
    assert.ok(updatedInc.resolved_at);

    const confirmed = await ConfirmedIncident.findOne({ id: `CONFIRMED-${inc._id}` });
    assert.ok(confirmed);
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.source, 'resolved');
    assert.equal(confirmed.root_cause, 'Network partition delayed WAL replication to standby replica');
  });
});
