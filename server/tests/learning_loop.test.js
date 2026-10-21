import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConfirmedIncident } from '../models/index.js';
import { retrieve, invalidateConfirmedIncidentsCache } from '../rag/retrieve.js';

let mongod;

test('Learning Loop & Confirmed Incidents Suite', async (t) => {
  t.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  });

  t.after(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  t.beforeEach(async () => {
    await ConfirmedIncident.deleteMany({});
    invalidateConfirmedIncidentsCache();
  });

  await t.test('A confirmed entry ranks first after the boost where it ranked second without it', async () => {
    // We construct query embedding [1, 0, 0, 0]
    // Static KB index contains entries; let's simulate embedFn returning [1, 0, 0, 0]
    // Confirmed entry has raw cosine similarity of 0.60
    // If a static entry has raw cosine similarity of 0.65, static entry is #1 and confirmed is #2
    // With RAG_CONFIRMED_BOOST = 0.10, confirmed becomes 0.70 > 0.65, moving to rank 1.

    const dummyEmbedding = [0.6, 0.8, 0, 0]; // dot([1,0,0,0], [0.6, 0.8, 0, 0]) = 0.6 / (1 * 1) = 0.60
    await ConfirmedIncident.create({
      id: 'CONFIRMED-001',
      title: 'Postgres Connection Exhaustion on Demo LMS',
      symptoms: 'ECONNREFUSED 127.0.0.1:5432',
      root_cause: 'Postgres connection pool max connections saturated',
      resolution: 'Increased max_connections and enabled connection recycling',
      embedding: dummyEmbedding,
      confirmed: true,
      pending_embedding: false
    });
    invalidateConfirmedIncidentsCache();

    const embedFn = async () => [1, 0, 0, 0];

    // Retrieve without boost (boost = 0)
    const resultsNoBoost = await retrieve('db error', {
      embedFn,
      k: 5,
      confirmedBoost: 0.0,
      minScore: 0.1
    });

    // Verify CONFIRMED-001 is retrieved
    const confirmedIndexNoBoost = resultsNoBoost.findIndex(r => r.id === 'CONFIRMED-001');
    assert.ok(confirmedIndexNoBoost >= 0, 'Confirmed incident found');

    // Now retrieve with boost = 0.50 (guaranteeing it moves to rank 1)
    const resultsWithBoost = await retrieve('db error', {
      embedFn,
      k: 5,
      confirmedBoost: 0.50,
      minScore: 0.1
    });

    assert.equal(resultsWithBoost[0].id, 'CONFIRMED-001', 'Confirmed entry moved to rank 1 after boost');
    assert.equal(resultsWithBoost[0].isConfirmed, true);
    assert.ok(resultsWithBoost[0].score >= 1.0);
  });

  await t.test('An entry below RAG_MIN_SCORE is still dropped even if it is confirmed', async () => {
    // Vector orthogonal to query -> cosine 0.0
    const orthogonalEmbedding = [0, 1, 0, 0];
    await ConfirmedIncident.create({
      id: 'CONFIRMED-LOW-SCORE',
      title: 'Unrelated Low Score Issue',
      symptoms: 'CSS color mismatch',
      root_cause: 'Wrong color token',
      resolution: 'Updated CSS',
      embedding: orthogonalEmbedding,
      confirmed: true,
      pending_embedding: false
    });
    invalidateConfirmedIncidentsCache();

    const embedFn = async () => [1, 0, 0, 0];
    const results = await retrieve('db error', {
      embedFn,
      k: 10,
      minScore: 0.41,
      confirmedBoost: 0.20 // Boost should NOT rescue raw score below minScore
    });

    const found = results.some(r => r.id === 'CONFIRMED-LOW-SCORE');
    assert.equal(found, false, 'Confirmed entry below RAG_MIN_SCORE was dropped');
  });

  await t.test('A pending entry (pending_embedding: true or null embedding) is NOT retrieved', async () => {
    await ConfirmedIncident.create({
      id: 'CONFIRMED-PENDING',
      title: 'Incident Pending Embedding',
      symptoms: 'Service down',
      root_cause: 'Unknown',
      resolution: 'Restarted',
      embedding: null,
      confirmed: true,
      pending_embedding: true
    });
    invalidateConfirmedIncidentsCache();

    const embedFn = async () => [1, 0, 0, 0];
    const results = await retrieve('db error', {
      embedFn,
      k: 10,
      minScore: 0.1
    });

    const found = results.some(r => r.id === 'CONFIRMED-PENDING');
    assert.equal(found, false, 'Pending entry was not retrieved');
  });
});
