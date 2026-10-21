import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiRateLimiter,
  GeminiQuotaExceededError,
  isRateLimitError,
  isDailyQuotaExhausted,
  parseRetryDelay,
  executeWithRetry,
  wrapGeminiClient
} from '../utils/geminiLimiter.js';
import { runGeminiStage } from '../agents/gemini.js';

describe('Gemini Rate Limiter & 429 Retry Tests', () => {
  let limiter;

  beforeEach(() => {
    limiter = new GeminiRateLimiter({ rpm: 5, minGapMs: 10 });
    limiter.reset();
  });

  describe('isRateLimitError', () => {
    test('identifies HTTP 429 status codes', () => {
      assert.equal(isRateLimitError({ status: 429 }), true);
      assert.equal(isRateLimitError({ statusCode: 429 }), true);
      assert.equal(isRateLimitError({ error: { code: 429 } }), true);
      assert.equal(isRateLimitError({ error: { status: 'RESOURCE_EXHAUSTED' } }), true);
    });

    test('identifies quota and rate limit messages', () => {
      assert.equal(isRateLimitError(new Error('Resource has been exhausted (e.g. check quota).')), true);
      assert.equal(isRateLimitError(new Error('Quota exceeded for quota metric: GenerateRequestsPerMinute')), true);
      assert.equal(isRateLimitError(new Error('Rate limit reached: 5 RPM')), true);
      assert.equal(isRateLimitError(new Error('429 Too Many Requests')), true);
    });

    test('returns false for non-429 errors', () => {
      assert.equal(isRateLimitError(new Error('404 Not Found: model not found')), false);
      assert.equal(isRateLimitError(new Error('JSON parse error')), false);
      assert.equal(isRateLimitError({ status: 500, message: 'Internal Server Error' }), false);
      assert.equal(isRateLimitError(null), false);
    });
  });

  describe('isDailyQuotaExhausted', () => {
    test('identifies GenerateRequestsPerDay metric in message', () => {
      const err = new Error('GenerateRequestsPerDayPerProjectPerModel-FreeTier: limit 20, RetryInfo retryDelay 67033s');
      assert.equal(isDailyQuotaExhausted(err), true);
    });

    test('identifies daily quota in errorDetails', () => {
      const err = {
        status: 429,
        errorDetails: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                description: 'Quota exceeded for metric: GenerateRequestsPerDay'
              }
            ]
          }
        ]
      };
      assert.equal(isDailyQuotaExhausted(err), true);
    });

    test('identifies long retryDelay (>60s) as daily/long exhaustion', () => {
      const err = new Error('Resource exhausted. Please retry after 180s.');
      assert.equal(isDailyQuotaExhausted(err), true);
    });

    test('returns false for short temporary RPM rate limits', () => {
      const err = new Error('Rate limit reached: 5 RPM. Please retry after 12s.');
      assert.equal(isDailyQuotaExhausted(err), false);
    });
  });

  describe('parseRetryDelay', () => {
    test('extracts large delay from live error format', () => {
      const err = new Error('GenerateRequestsPerDayPerProjectPerModel-FreeTier: limit 20, RetryInfo retryDelay 67033s');
      assert.equal(parseRetryDelay(err), 67033000);
    });

    test('extracts delay from Google RPC RetryInfo with string delay', () => {
      const err = {
        errorDetails: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '15s'
          }
        ]
      };
      assert.equal(parseRetryDelay(err), 15000);
    });

    test('extracts delay from Google RPC RetryInfo with fractional string delay', () => {
      const err = {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '12.5s'
          }
        ]
      };
      assert.equal(parseRetryDelay(err), 12500);
    });

    test('extracts delay from Google RPC RetryInfo object with seconds and nanos', () => {
      const err = {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: { seconds: 8, nanos: 500000000 }
            }
          ]
        }
      };
      assert.equal(parseRetryDelay(err), 8500);
    });

    test('extracts delay from retry-after header', () => {
      const err = {
        response: {
          headers: {
            get: (name) => name === 'retry-after' ? '18' : null
          }
        }
      };
      assert.equal(parseRetryDelay(err), 18000);
    });

    test('extracts delay from error message regex', () => {
      const err = new Error('Resource has been exhausted. Please retry after 14s.');
      assert.equal(parseRetryDelay(err), 14000);

      const err2 = new Error('Rate limit exceeded. retryDelay: 22.5s');
      assert.equal(parseRetryDelay(err2), 22500);
    });

    test('returns null when no retry info is available', () => {
      assert.equal(parseRetryDelay(new Error('Generic failure')), null);
      assert.equal(parseRetryDelay(null), null);
    });
  });

  describe('executeWithRetry with Mocked Calls', () => {
    test('executes successfully without retrying when function succeeds', async () => {
      let callCount = 0;
      const result = await executeWithRetry(async () => {
        callCount++;
        return { text: 'ok' };
      }, { limiter });

      assert.equal(callCount, 1);
      assert.deepEqual(result, { text: 'ok' });
    });

    test('rethrows immediately on non-429 error without retrying', async () => {
      let callCount = 0;
      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            callCount++;
            throw new Error('404 Model Not Found');
          }, { limiter });
        },
        /404 Model Not Found/
      );

      assert.equal(callCount, 1);
    });

    test('fails PROMPTLY without sleeping when daily quota is exhausted (67033s)', async () => {
      let callCount = 0;
      const startTime = Date.now();
      const dailyErr = new Error('GenerateRequestsPerDayPerProjectPerModel-FreeTier: limit 20, RetryInfo retryDelay 67033s');
      dailyErr.status = 429;

      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            callCount++;
            throw dailyErr;
          }, { limiter, maxBudgetMs: 5000 });
        },
        (err) => {
          assert.ok(err instanceof GeminiQuotaExceededError);
          assert.equal(err.isDaily, true);
          assert.ok(err.message.includes('GenerateRequestsPerDay limit reached'));
          assert.ok(err.message.includes('67033s'));
          return true;
        }
      );

      const elapsed = Date.now() - startTime;
      // Must fail promptly in milliseconds, NOT sleep 67033s or 4-30s!
      assert.ok(elapsed < 200, `Expected prompt failure, but took ${elapsed}ms`);
      assert.equal(callCount, 1, 'Must NOT attempt retries on exhausted daily quota');

      // Subsequent calls through the limiter must also fail fast
      let subsequentCalls = 0;
      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            subsequentCalls++;
            return 'should not run';
          }, { limiter });
        },
        /daily quota exhausted/
      );
      assert.equal(subsequentCalls, 0, 'Must block subsequent calls without making futile requests');
    });

    test('fails promptly when retryDelay exceeds maximum execution budget', async () => {
      let callCount = 0;
      const startTime = Date.now();
      const longRateLimitErr = new Error('429 RESOURCE_EXHAUSTED: retry after 90s');
      longRateLimitErr.status = 429;

      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            callCount++;
            throw longRateLimitErr;
          }, { limiter, maxBudgetMs: 5000 });
        },
        (err) => {
          assert.ok(err instanceof GeminiQuotaExceededError);
          assert.ok(err.message.includes('xceeds execution budget'));
          return true;
        }
      );

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 200, `Expected prompt failure, but took ${elapsed}ms`);
      assert.equal(callCount, 1);
    });

    test('retries on short RPM 429 respecting retryDelay and succeeds on attempt 2', async () => {
      let callCount = 0;
      const rateLimitErr = new Error('429 RESOURCE_EXHAUSTED: retry after 0.02s');
      rateLimitErr.status = 429;

      const result = await executeWithRetry(async () => {
        callCount++;
        if (callCount === 1) {
          throw rateLimitErr;
        }
        return { text: 'success after retry' };
      }, { limiter, maxRetries: 2, bufferMs: 5 });

      assert.equal(callCount, 2);
      assert.equal(result.text, 'success after retry');
    });
  });

  describe('Outer Agent Retry Prevention on Quota Exhaustion', () => {
    test('skips outer agent retry when callModel fails due to daily quota exhaustion', async () => {
      let generateCallCount = 0;
      const dailyErr = new Error('GenerateRequestsPerDayPerProjectPerModel-FreeTier: limit 20, RetryInfo retryDelay 67033s');
      dailyErr.status = 429;

      const mockClient = {
        models: {
          generateContent: async () => {
            generateCallCount++;
            throw dailyErr;
          }
        }
      };

      await assert.rejects(
        async () => {
          await runGeminiStage({
            stage: 'triage',
            systemPrompt: 'System',
            userPrompt: 'User',
            mockClient
          });
        },
        (err) => {
          assert.ok(err.message.includes('GenerateRequestsPerDay limit reached') || err.message.includes('67033s'));
          return true;
        }
      );

      // Verify Attempt 1 was made, but Attempt 2 (schema error feedback prompt) was SKIPPED!
      assert.equal(
        generateCallCount,
        1,
        'Must NOT fire outer schema feedback retry when quota is exhausted'
      );
    });
  });

  describe('wrapGeminiClient', () => {
    test('wraps mockClient.models.generateContent transparently', async () => {
      let attempts = 0;
      const mockRawClient = {
        models: {
          generateContent: async ({ contents }) => {
            attempts++;
            if (attempts === 1) {
              const err = new Error('429 Resource exhausted: retry after 0.02s');
              err.status = 429;
              throw err;
            }
            return { text: `Processed: ${contents}` };
          }
        }
      };

      const wrapped = wrapGeminiClient(mockRawClient, { limiter, bufferMs: 5 });
      const res = await wrapped.models.generateContent({ contents: 'test-prompt' });

      assert.equal(attempts, 2);
      assert.equal(res.text, 'Processed: test-prompt');
    });
  });
});
