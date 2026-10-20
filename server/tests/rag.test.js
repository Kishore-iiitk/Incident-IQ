import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { retrieve, cosineSimilarity } from '../rag/retrieve.js';
import { runRagRetrieval } from '../processors/rag.js';
import { Incident } from '../models/index.js';
import { connectDB, disconnectDB } from '../db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REAL_INDEX_PATH = path.join(__dirname, '..', 'rag', 'kb_index.json');

describe('RAG Retrieval & Processor Suite', () => {
  let realIndexData;

  before(async () => {
    await connectDB();
    const raw = fs.readFileSync(REAL_INDEX_PATH, 'utf-8');
    realIndexData = JSON.parse(raw);
  });

  after(async () => {
    await disconnectDB();
  });

  test('cosineSimilarity calculates exact dot product over norms', () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    assert.equal(cosineSimilarity(v1, v2), 1.0);

    const v3 = [0, 1, 0];
    assert.equal(cosineSimilarity(v1, v3), 0.0);

    const v4 = [-1, 0, 0];
    assert.equal(cosineSimilarity(v1, v4), -1.0);
  });

  test('retrieve() with an injected embedFn ranks the nearest incident first and returns k results', async () => {
    // Pick an incident to target: KB-003 ("Session Eviction During Login")
    const targetIncident = realIndexData.incidents.find(i => i.id === 'KB-003');
    assert.ok(targetIncident, 'KB-003 should exist in real index');

    // Injected embedFn returns KB-003's exact embedding
    const injectedEmbedFn = async (text) => {
      return targetIncident.embedding;
    };

    const results = await retrieve('Users redirected back to login page repeatedly', {
      k: 3,
      embedFn: injectedEmbedFn
    });

    assert.equal(results.length, 3, 'Should return exactly k=3 results');
    assert.equal(results[0].id, 'KB-003', 'Nearest incident should be ranked first');
    assert.equal(results[0].score, 1.0, 'Exact match cosine similarity should be 1.0');
    assert.equal(results[0].title, targetIncident.title);
    assert.equal(results[0].family, targetIncident.family);
    assert.equal(results[0].service, targetIncident.service);
    assert.ok(results[0].symptoms);
    assert.ok(results[0].root_cause);
    assert.ok(results[0].resolution);
  });

  test('retrieve() applies the redactor to query text before passing to embedFn', async () => {
    let capturedText = null;

    const testEmbedFn = async (text) => {
      capturedText = text;
      return realIndexData.incidents[0].embedding;
    };

    const rawQuery = 'Student user_email: student@university.edu reported token Bearer abc123def456xyz789';
    await retrieve(rawQuery, { k: 2, embedFn: testEmbedFn });

    assert.ok(capturedText, 'embedFn should have been called');
    assert.ok(!capturedText.includes('student@university.edu'), 'Email must be redacted');
    assert.ok(!capturedText.includes('abc123def456xyz789'), 'Bearer token must be redacted');
    assert.ok(capturedText.includes('[REDACTED_EMAIL]'), 'Should contain [REDACTED_EMAIL]');
    assert.ok(capturedText.includes('[REDACTED_TOKEN]'), 'Should contain [REDACTED_TOKEN]');
  });

  test('retrieve() throws when the index is missing', async () => {
    const fakeIndexPath = path.join(__dirname, 'non_existent_index.json');

    await assert.rejects(
      async () => {
        await retrieve('Any query', {
          indexPath: fakeIndexPath,
          embedFn: async () => [0.1, 0.2]
        });
      },
      /KB index unavailable: file not found/
    );
  });

  test('retrieve() throws clear error when ML service is unavailable and no embedFn provided', async () => {
    const originalUrl = process.env.ML_SERVICE_URL;
    process.env.ML_SERVICE_URL = 'http://127.0.0.1:59999'; // Non-existent service

    try {
      await assert.rejects(
        async () => {
          await retrieve('Any incident description');
        },
        /ML service unavailable/
      );
    } finally {
      process.env.ML_SERVICE_URL = originalUrl;
    }
  });

  test('retrieve() throws "atlas backend not configured" when backend is atlas and MONGODB_ATLAS_URI is not set', async () => {
    const originalUri = process.env.MONGODB_ATLAS_URI;
    delete process.env.MONGODB_ATLAS_URI;

    try {
      await assert.rejects(
        async () => {
          await retrieve('Any incident description', { backend: 'atlas' });
        },
        /atlas backend not configured/
      );
    } finally {
      if (originalUri) process.env.MONGODB_ATLAS_URI = originalUri;
    }
  });

  test('rag.js returns [] and logs warning when retrieval throws, marking incident as retrieval_unavailable', async () => {
    const originalUrl = process.env.ML_SERVICE_URL;
    process.env.ML_SERVICE_URL = 'http://127.0.0.1:59999'; // Force retrieval to throw

    const incident = await Incident.create({
      title: 'Outage with unreachable RAG service',
      description: 'System login failure',
      status: 'processing'
    });

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
      origWarn(...args);
    };

    try {
      const results = await runRagRetrieval({
        incidentId: incident._id,
        contextBundle: {
          title: incident.title,
          description: incident.description
        }
      });

      // Assert it returns [] and does NOT crash
      assert.deepEqual(results, [], 'Processor must gracefully return []');

      // Assert warning was logged
      assert.ok(warnings.some(w => w.includes('[RAG] Retrieval warning')), 'Must log warning');

      // Assert incident is marked as retrieval_unavailable
      const updatedIncident = await Incident.findById(incident._id);
      assert.equal(updatedIncident.retrieval_status, 'retrieval_unavailable');
    } finally {
      console.warn = origWarn;
      process.env.ML_SERVICE_URL = originalUrl;
    }
  });

  test('retrieve() drops results below RAG_MIN_SCORE threshold', async () => {
    // Target KB-003, which has top scores: 1.0 (KB-003), 0.5713 (KB-005), 0.5537 (KB-001), 0.4894 (KB-002)
    const targetIncident = realIndexData.incidents.find(i => i.id === 'KB-003');
    const injectedEmbedFn = async () => targetIncident.embedding;

    // 1. With standard threshold 0.41, returns top 3 (1.0, ~0.57, ~0.55)
    const normalResults = await retrieve('Session login loop', { k: 5, embedFn: injectedEmbedFn });
    assert.ok(normalResults.length >= 3, 'Should return all results >= 0.41');
    assert.ok(normalResults.every(r => r.score >= 0.41), 'All items must meet default threshold');

    // 2. Set strict RAG_MIN_SCORE env var to 0.56
    const origMin = process.env.RAG_MIN_SCORE;
    process.env.RAG_MIN_SCORE = '0.56';

    try {
      const filteredResults = await retrieve('Session login loop', { k: 5, embedFn: injectedEmbedFn });
      // Only KB-003 (1.0) and KB-005 (0.5713) should qualify; KB-001 (0.5537) and KB-002 (0.4894) must be dropped
      assert.equal(filteredResults.length, 2, 'Only items >= 0.56 should remain');
      assert.ok(filteredResults.every(r => r.score >= 0.56), 'All returned items must be >= 0.56');

      // 3. Set threshold above all items except exact match (> 0.90)
      const exactOnly = await retrieve('Session login loop', { k: 5, embedFn: injectedEmbedFn, minScore: 0.90 });
      assert.equal(exactOnly.length, 1, 'Only exact match should exceed 0.90');
      assert.equal(exactOnly[0].id, 'KB-003');

      // 4. Threshold higher than any match returns empty list
      const noneQualify = await retrieve('Session login loop', { k: 5, embedFn: injectedEmbedFn, minScore: 1.05 });
      assert.deepEqual(noneQualify, [], 'Results below minScore must return empty array');
    } finally {
      if (origMin !== undefined) {
        process.env.RAG_MIN_SCORE = origMin;
      } else {
        delete process.env.RAG_MIN_SCORE;
      }
    }
  });
});
