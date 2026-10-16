import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runGeminiStage } from '../agents/gemini.js';
import { connectDB, disconnectDB } from '../db/connection.js';

describe('Gemini Agent Wrapper & Retry Mechanism', () => {
  before(async () => {
    await connectDB();
  });

  after(async () => {
    await disconnectDB();
  });

  test('Gemini wrapper retries once when first attempt returns invalid JSON and succeeds on second attempt', async () => {
    const testSchema = z.object({
      status: z.string(),
      code: z.number()
    });

    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: async () => {
          callCount++;
          if (callCount === 1) {
            // First attempt: invalid JSON
            return { text: 'This is not valid JSON at all: { broken ' };
          }
          // Second attempt (retry): valid JSON adhering to schema
          return { text: JSON.stringify({ status: 'recovered', code: 200 }) };
        }
      }
    };

    const result = await runGeminiStage({
      stage: 'test_stage',
      systemPrompt: 'System instruction',
      userPrompt: 'User prompt',
      schema: testSchema,
      mockClient
    });

    assert.equal(callCount, 2, 'Should have called the model twice (1 initial + 1 retry)');
    assert.equal(result.output.status, 'recovered');
    assert.equal(result.output.code, 200);
  });

  test('Gemini wrapper fails cleanly after 1 retry if output remains invalid', async () => {
    const testSchema = z.object({
      required_field: z.string()
    });

    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: async () => {
          callCount++;
          // Always return invalid schema
          return { text: JSON.stringify({ wrong_key: 123 }) };
        }
      }
    };

    await assert.rejects(
      async () => {
        await runGeminiStage({
          stage: 'failing_stage',
          systemPrompt: 'System',
          userPrompt: 'Prompt',
          schema: testSchema,
          mockClient
        });
      },
      /failed after 1 retry/
    );

    assert.equal(callCount, 2, 'Should have attempted exactly twice before failing');
  });
});
