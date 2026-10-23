import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectDB, disconnectDB } from '../db/connection.js';
import { Incident, Artifact } from '../models/index.js';
import { dedupSignal } from '../services/dedup.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { executePipeline, pipelineQueue } from '../pipeline.js';

describe('Failed Incident Recovery & Auto-Retry Tests (Problem 3)', () => {
  before(async () => {
    await connectDB();
  });

  after(async () => {
    await disconnectDB();
  });

  test('a signal on a failed incident triggers one automatic retry', async () => {
    const signal = {
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/login',
      status: 500,
      message: 'MongoNotConnectedError: client closed',
      user_role: 'student',
      user_id: '123'
    };

    const fp = computeFingerprint(signal);

    const failedIncident = await Incident.create({
      title: 'Previous Outage',
      description: 'LMS outage caused by database crash',
      status: 'failed',
      fingerprint: fp,
      failed_stage: 'triage',
      stages_completed: ['text_processor', 'fusion', 'rag_retrieval'],
      error_message: 'Stage [triage] failed: 503 Service Unavailable',
      auto_retry_count: 0,
      retry_count: 0,
      created_at: new Date(),
      last_seen: new Date()
    });

    const { incident: updated, isRetried } = await dedupSignal(
      signal,
      'New Signal Title',
      'New Signal Description'
    );

    assert.equal(isRetried, true, 'Matching signal on failed incident must trigger automatic retry');
    assert.equal(updated.auto_retry_count, 1);
    assert.equal(updated.retry_count, 1);
    assert.equal(updated.status, 'processing');
    assert.ok(updated.last_auto_retry_at, 'last_auto_retry_at must be populated');
  });

  test('the automatic retry limits hold (cooldown < 60s and max 3 retries)', async () => {
    const signal = {
      source: 'reporter',
      service: 'demo-lms',
      endpoint: '/courses',
      status: 500,
      message: 'MongoNotConnectedError: connection closed'
    };

    const fp = computeFingerprint(signal);

    // 1. Cooldown test: Immediate signal (< 60s) must NOT trigger a second retry
    const incident = await Incident.create({
      title: 'Failed Outage Limited',
      description: 'Test description',
      status: 'failed',
      fingerprint: fp,
      failed_stage: 'root_cause',
      stages_completed: ['text_processor', 'fusion', 'rag_retrieval', 'triage'],
      auto_retry_count: 1,
      retry_count: 1,
      last_auto_retry_at: new Date(), // Just now (< 60s)
      created_at: new Date(),
      last_seen: new Date()
    });

    const { incident: immediateResult, isRetried: isImmediateRetried } = await dedupSignal(
      signal,
      'Title',
      'Desc'
    );

    assert.equal(isImmediateRetried, false, 'Must not retry within 60s cooldown');
    assert.equal(immediateResult.auto_retry_count, 1, 'Auto retry count must stay at 1');
    assert.equal(immediateResult.status, 'failed', 'Incident must remain failed');

    // 2. Max 3 retries limit test:
    // Set auto_retry_count to 3 and last_auto_retry_at to 2 minutes ago
    incident.auto_retry_count = 3;
    incident.last_auto_retry_at = new Date(Date.now() - 120000);
    incident.status = 'failed';
    await incident.save();

    const { incident: maxedResult, isRetried: isMaxedRetried } = await dedupSignal(
      signal,
      'Title',
      'Desc'
    );

    assert.equal(isMaxedRetried, false, 'Must not retry once max 3 retries is reached');
    assert.equal(maxedResult.auto_retry_count, 3, 'Must remain at 3 retries');
    assert.equal(maxedResult.status, 'failed', 'Incident must stop and stay failed');
  });

  test('a retry that succeeds sets status to "review"', async () => {
    // Preserve original environment variables to restore afterward
    const savedEnv = {
      DEMO_MODE: process.env.DEMO_MODE,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
      GEMINI_MODEL_STRONG: process.env.GEMINI_MODEL_STRONG
    };

    try {
      // Configure model settings and enable offline demo mode for mocked Gemini responses
      process.env.DEMO_MODE = 'true';
      process.env.GEMINI_MODEL = 'gemini-3.8-flash';
      process.env.GEMINI_MODEL_STRONG = 'gemini-3.8-flash';

      const incident = await Incident.create({
        title: 'LMS Assignment Upload & 500 Error Outage',
        description: 'Students cannot open assignment pages since 2pm, the course page shows a 500 error and the upload button spins forever.',
        status: 'failed',
        failed_stage: 'triage',
        stages_completed: ['text_processor', 'fusion', 'rag_retrieval'],
        error_message: 'Temporary model error',
        retry_count: 1,
        auto_retry_count: 1,
        created_at: new Date(),
        last_seen: new Date()
      });

      const artifact = await Artifact.create({
        incident_id: incident._id,
        kind: 'text',
        source: 'user_submission'
      });

      await executePipeline({
        incidentId: incident._id,
        artifactId: artifact._id,
        text: incident.description
      });

      const finalIncident = await Incident.findById(incident._id);
      assert.equal(finalIncident.status, 'review', 'A retry that succeeds must set status to "review"');
      assert.equal(finalIncident.failed_stage, null, 'failed_stage must be cleared on success');
      assert.equal(finalIncident.error_message, null, 'error_message must be cleared on success');
      assert.ok(finalIncident.stages_completed.length > 0, 'stages_completed must be populated');
    } finally {
      // Restore original environment variables
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
