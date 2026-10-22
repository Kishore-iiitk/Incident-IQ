import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runGeminiStage, setSleepFunction } from '../agents/gemini.js';
import { connectDB, disconnectDB } from '../db/connection.js';

describe('Gemini Resilience & Fallback Tests (Problem 2)', () => {
  const instantSleep = async () => {};

  before(async () => {
    await connectDB();
    setSleepFunction(instantSleep);
  });

  after(async () => {
    await disconnectDB();
  });

  const testSchema = z.object({
    status: z.string(),
    code: z.number()
  });

  test('two 503s then success returns the result', async () => {
    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: async ({ model }) => {
          callCount++;
          if (callCount <= 2) {
            const err = new Error('This model is currently experiencing high demand');
            err.status = 503;
            throw err;
          }
          return {
            text: JSON.stringify({ status: 'recovered_from_503', code: 200 })
          };
        }
      }
    };

    const result = await runGeminiStage({
      stage: 'triage',
      systemPrompt: 'System instruction',
      userPrompt: 'User prompt',
      schema: testSchema,
      mockClient,
      sleepFn: instantSleep
    });

    assert.equal(callCount, 3, 'Should have succeeded on the 3rd attempt (after 2 503s)');
    assert.equal(result.output.status, 'recovered_from_503');
    assert.equal(result.output.code, 200);
  });

  test('persistent 503 fails after GEMINI_MAX_ATTEMPTS with the right error', async () => {
    process.env.GEMINI_MAX_ATTEMPTS = '3';
    let callCount = 0;

    const mockClient = {
      models: {
        generateContent: async () => {
          callCount++;
          const err = new Error('This model is currently experiencing high demand');
          err.status = 503;
          throw err;
        }
      }
    };

    await assert.rejects(
      async () => {
        await runGeminiStage({
          stage: 'triage',
          systemPrompt: 'System',
          userPrompt: 'Prompt',
          schema: testSchema,
          mockClient,
          sleepFn: instantSleep
        });
      },
      (err) => {
        assert.ok(
          err.message.includes('failed after 3 attempts') || err.message.includes('high demand'),
          `Error message should indicate failure after attempts: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(callCount, 3, 'Should have stopped after GEMINI_MAX_ATTEMPTS (3 attempts)');
    delete process.env.GEMINI_MAX_ATTEMPTS;
  });

  test('a 404 is not retried and message mentions model name is probably wrong', async () => {
    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: async () => {
          callCount++;
          const err = new Error('models/invalid-model is not found for API version v1beta');
          err.status = 404;
          throw err;
        }
      }
    };

    await assert.rejects(
      async () => {
        await runGeminiStage({
          stage: 'triage',
          systemPrompt: 'System',
          userPrompt: 'Prompt',
          schema: testSchema,
          mockClient,
          sleepFn: instantSleep
        });
      },
      (err) => {
        assert.ok(
          err.message.includes('The model name in GEMINI_MODEL is probably wrong') || err.message.includes('HTTP 404'),
          `Error message must mention model name is probably wrong: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(callCount, 1, '404 must fail fast immediately with 0 retries');
  });

  test('invalid JSON still gets exactly one retry', async () => {
    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: async () => {
          callCount++;
          if (callCount === 1) {
            return { text: 'Invalid JSON response without braces' };
          }
          return { text: JSON.stringify({ status: 'json_fixed', code: 200 }) };
        }
      }
    };

    const result = await runGeminiStage({
      stage: 'triage',
      systemPrompt: 'System',
      userPrompt: 'Prompt',
      schema: testSchema,
      mockClient,
      sleepFn: instantSleep
    });

    assert.equal(callCount, 2, 'Invalid JSON should get exactly one retry');
    assert.equal(result.output.status, 'json_fixed');
  });

  test('the fallback model is used when the primary keeps failing', async () => {
    process.env.GEMINI_MAX_ATTEMPTS = '2';
    process.env.GEMINI_MODEL = 'primary-model-test';
    process.env.GEMINI_FALLBACK_MODEL = 'fallback-model-test';

    const modelsCalled = [];
    const mockClient = {
      models: {
        generateContent: async ({ model }) => {
          modelsCalled.push(model);
          if (model === 'primary-model-test') {
            const err = new Error('Primary model unavailable');
            err.status = 503;
            throw err;
          }
          return { text: JSON.stringify({ status: 'fallback_success', code: 200 }) };
        }
      }
    };

    const result = await runGeminiStage({
      stage: 'triage',
      systemPrompt: 'System',
      userPrompt: 'Prompt',
      schema: testSchema,
      mockClient,
      sleepFn: instantSleep
    });

    assert.equal(result.output.status, 'fallback_success');
    assert.equal(result.model, 'fallback-model-test', 'Recorded model must be the fallback model');
    assert.deepEqual(
      modelsCalled,
      ['primary-model-test', 'primary-model-test', 'fallback-model-test'],
      'Primary should be tried 2 times, followed by fallback model'
    );

    delete process.env.GEMINI_FALLBACK_MODEL;
    delete process.env.GEMINI_MAX_ATTEMPTS;
  });
});
