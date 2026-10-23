import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiRateLimiter,
  GeminiQuotaExceededError,
  QUOTA_TYPE,
  isRateLimitError,
  isDailyQuotaExhausted,
  classifyQuotaError,
  parseRetryDelay,
  extractQuotaDetails,
  sanitizeErrorMessage,
  sanitizeErrorDetails,
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

  describe('Sanitization & Secret Redaction', () => {
    test('redacts Google API key in query parameters and URLs', () => {
      const raw = 'Request to https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyD-FakeKey1234567890abcdef123456 failed with status 429';
      const sanitized = sanitizeErrorMessage(raw);
      assert.ok(!sanitized.includes('AIzaSyD-FakeKey1234567890abcdef123456'));
      assert.ok(sanitized.includes('key=[REDACTED_API_KEY]'));
    });

    test('redacts standalone Google API keys matching pattern', () => {
      const raw = 'Error using key AIzaSyA1234567890abcdef1234567890abcdef: quota exceeded';
      const sanitized = sanitizeErrorMessage(raw);
      assert.ok(!sanitized.includes('AIzaSyA1234567890abcdef1234567890abcdef'));
      assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
    });

    test('deeply sanitizes nested objects and arrays without altering metrics or status', () => {
      const details = {
        apiKey: 'AIzaSyD-FakeKey1234567890abcdef123456',
        status: 429,
        violations: [
          {
            quotaMetric: 'GenerateRequestsPerDay',
            url: 'https://api.google.com?key=AIzaSyD-FakeKey1234567890abcdef123456'
          }
        ]
      };
      const sanitized = sanitizeErrorDetails(details);
      assert.equal(sanitized.apiKey, '[REDACTED_API_KEY]');
      assert.equal(sanitized.status, 429);
      assert.equal(sanitized.violations[0].quotaMetric, 'GenerateRequestsPerDay');
      assert.ok(!sanitized.violations[0].url.includes('AIzaSyD-FakeKey1234567890abcdef123456'));
      assert.ok(sanitized.violations[0].url.includes('[REDACTED_API_KEY]'));
    });
  });

  describe('isRateLimitError', () => {
    test('identifies HTTP 429 status codes', () => {
      assert.equal(isRateLimitError({ status: 429 }), true);
      assert.equal(isRateLimitError({ statusCode: 429 }), true);
      assert.equal(isRateLimitError({ error: { code: 429 } }), true);
      assert.equal(isRateLimitError({ error: { status: 'RESOURCE_EXHAUSTED' } }), true);
      assert.equal(isRateLimitError(new GeminiQuotaExceededError('quota error')), true);
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

  describe('classifyQuotaError & isDailyQuotaExhausted', () => {
    test('identifies GenerateRequestsPerDay metric in message as confirmed daily exhaustion', () => {
      const err = new Error('GenerateRequestsPerDayPerProjectPerModel-FreeTier: limit 20, RetryInfo retryDelay 67033s');
      assert.equal(isDailyQuotaExhausted(err), true);
      const res = classifyQuotaError(err);
      assert.equal(res.type, QUOTA_TYPE.CONFIRMED_DAILY);
      assert.equal(res.isDaily, true);
      assert.equal(res.hasGoogleRetryDelay, true);
      assert.equal(res.retryDelayMs, 67033000);
    });

    test('identifies daily quota in errorDetails array', () => {
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
      const res = classifyQuotaError(err);
      assert.equal(res.type, QUOTA_TYPE.CONFIRMED_DAILY);
      assert.equal(res.isDaily, true);
    });

    test('CRITICAL: long retryDelay (>60s) does NOT automatically mean daily quota exhaustion', () => {
      const err = new Error('Resource exhausted. Please retry after 180s.');
      assert.equal(isDailyQuotaExhausted(err), false);
      const res = classifyQuotaError(err);
      assert.notEqual(res.type, QUOTA_TYPE.CONFIRMED_DAILY);
      assert.equal(res.type, QUOTA_TYPE.TEMPORARY_RATE_LIMIT);
      assert.equal(res.isDaily, false);
      assert.equal(res.retryDelayMs, 180000);
      assert.equal(res.hasGoogleRetryDelay, true);
    });

    test('classifies short temporary RPM rate limits as temporary_rate_limit', () => {
      const err = new Error('Rate limit reached: 5 RPM. Please retry after 12s.');
      assert.equal(isDailyQuotaExhausted(err), false);
      const res = classifyQuotaError(err);
      assert.equal(res.type, QUOTA_TYPE.TEMPORARY_RATE_LIMIT);
      assert.equal(res.isDaily, false);
      assert.equal(res.retryDelayMs, 12000);
    });

    test('classifies generic 429 without metric or delay as unknown_quota', () => {
      const err = new Error('Resource has been exhausted (e.g. check quota).');
      err.status = 429;
      assert.equal(isDailyQuotaExhausted(err), false);
      const res = classifyQuotaError(err);
      assert.equal(res.type, QUOTA_TYPE.UNKNOWN_QUOTA);
      assert.equal(res.isDaily, false);
      assert.equal(res.isUnknown, true);
      assert.equal(res.retryDelayMs, null);
    });
  });

  describe('SDK errors with JSON details inside error.message', () => {
    test('extracts QuotaFailure and RetryInfo from JSON inside error.message', () => {
      const sdkError = new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyD-FakeKey1234567890abcdef123456: [429 Too Many Requests]
{
  "error": {
    "code": 429,
    "message": "Resource has been exhausted (e.g. check quota).",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "description": "Quota exceeded for quota metric 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "67033s"
      }
    ]
  }
}`);
      sdkError.status = 429;

      // Verify parseRetryDelay extracts 67033s from JSON in error.message
      assert.equal(parseRetryDelay(sdkError), 67033000);

      // Verify isDailyQuotaExhausted detects daily metric from JSON violations
      assert.equal(isDailyQuotaExhausted(sdkError), true);

      // Verify classifyQuotaError returns confirmed_daily with sanitized message
      const res = classifyQuotaError(sdkError);
      assert.equal(res.type, QUOTA_TYPE.CONFIRMED_DAILY);
      assert.equal(res.isDaily, true);
      assert.equal(res.retryDelayMs, 67033000);
      assert.equal(res.hasGoogleRetryDelay, true);
      assert.ok(!res.sanitizedMessage.includes('AIzaSyD-FakeKey1234567890abcdef123456'));
      assert.ok(res.sanitizedDetails.metricNames.includes('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
    });

    test('extracts temporary RPM limit with RetryInfo from JSON inside error.message', () => {
      const sdkError = new Error(`429 RESOURCE_EXHAUSTED: {
  "error": {
    "code": 429,
    "message": "Quota exceeded for quota metric 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            "description": "GenerateRequestsPerMinute exceeded"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "15s"
      }
    ]
  }
}`);
      assert.equal(parseRetryDelay(sdkError), 15000);
      assert.equal(isDailyQuotaExhausted(sdkError), false);
      const res = classifyQuotaError(sdkError);
      assert.equal(res.type, QUOTA_TYPE.TEMPORARY_RATE_LIMIT);
      assert.equal(res.isDaily, false);
      assert.equal(res.retryDelayMs, 15000);
    });

    test('handles SDK error where JSON has QuotaFailure but NO RetryInfo', () => {
      const sdkError = new Error(`429 Too Many Requests: {
  "error": {
    "code": 429,
    "message": "Resource has been exhausted.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
          }
        ]
      }
    ]
  }
}`);
      assert.equal(parseRetryDelay(sdkError), null);
      assert.equal(isDailyQuotaExhausted(sdkError), true);
      const res = classifyQuotaError(sdkError);
      assert.equal(res.type, QUOTA_TYPE.CONFIRMED_DAILY);
      assert.equal(res.hasGoogleRetryDelay, false);
      assert.equal(res.retryDelayMs, null);
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

    test('fails PROMPTLY when daily quota is exhausted with Google retryDelay (67033s)', async () => {
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
          assert.equal(err.quotaType, QUOTA_TYPE.CONFIRMED_DAILY);
          assert.equal(err.isLocalEstimate, false);
          assert.ok(err.message.includes('GenerateRequestsPerDay limit reached'));
          assert.ok(err.message.includes('Google retryDelay: 67033s'));
          assert.ok(err.message.includes('Original error:'));
          assert.ok(err.sanitizedDetails !== null);
          return true;
        }
      );

      const elapsed = Date.now() - startTime;
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

    test('labels fallback cooldown as local estimate when Google omits RetryInfo on daily quota', async () => {
      let callCount = 0;
      const dailyErrWithoutDelay = new Error(`429 QuotaExceeded: {
  "error": {
    "code": 429,
    "message": "Resource has been exhausted.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          { "quotaMetric": "GenerateRequestsPerDay" }
        ]
      }
    ]
  }
}`);
      dailyErrWithoutDelay.status = 429;

      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            callCount++;
            throw dailyErrWithoutDelay;
          }, { limiter, maxBudgetMs: 5000 });
        },
        (err) => {
          assert.ok(err instanceof GeminiQuotaExceededError);
          assert.equal(err.isDaily, true);
          assert.equal(err.quotaType, QUOTA_TYPE.CONFIRMED_DAILY);
          assert.equal(err.isLocalEstimate, true);
          // Must NOT show 86400s as a Google retry delay; must label as local estimate!
          assert.ok(!err.message.includes('Google retryDelay: 86400s'));
          assert.ok(err.message.includes('local fallback cooldown estimate: 86400s'));
          assert.ok(err.message.includes('Original error:'));
          return true;
        }
      );

      assert.equal(callCount, 1);
    });

    test('delay exceeding execution budget does NOT mean daily quota exhaustion', async () => {
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
          assert.ok(err.message.includes('xceeds maximum execution budget'));
          assert.equal(err.isDaily, false, 'Must NOT be marked as daily quota exhaustion');
          assert.equal(err.quotaType, QUOTA_TYPE.TEMPORARY_RATE_LIMIT);
          assert.equal(err.retryDelayMs, 90000);
          assert.ok(!err.message.includes('GenerateRequestsPerDay'));
          assert.ok(err.message.includes('Original error:'));
          return true;
        }
      );

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 200, `Expected prompt failure, but took ${elapsed}ms`);
      assert.equal(callCount, 1);
    });

    test('preserves sanitized original error and redacts API keys during execution failure', async () => {
      const errWithKey = new Error('Request to https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyD-Secret1234567890abcdef123456 failed: Rate limit reached: 5 RPM. Please retry after 120s.');
      errWithKey.status = 429;

      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            throw errWithKey;
          }, { limiter, maxBudgetMs: 5000 });
        },
        (err) => {
          assert.ok(err instanceof GeminiQuotaExceededError);
          // Verify API key is NOT in message or sanitized details
          assert.ok(!err.message.includes('AIzaSyD-Secret1234567890abcdef123456'));
          assert.ok(err.message.includes('key=[REDACTED_API_KEY]'));
          assert.ok(err.sanitizedDetails.message.includes('key=[REDACTED_API_KEY]'));
          return true;
        }
      );
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

    test('handles unknown quota error with backoff and fails when cumulative budget exceeded', async () => {
      let callCount = 0;
      const unknownErr = new Error('Resource has been exhausted (e.g. check quota).');
      unknownErr.status = 429;

      await assert.rejects(
        async () => {
          await executeWithRetry(async () => {
            callCount++;
            throw unknownErr;
          }, { limiter, maxBudgetMs: 200, baseBackoffMs: 300 });
        },
        (err) => {
          assert.ok(err instanceof GeminiQuotaExceededError);
          assert.equal(err.isDaily, false);
          assert.equal(err.quotaType, QUOTA_TYPE.UNKNOWN_QUOTA);
          assert.equal(err.isLocalEstimate, true);
          assert.ok(err.message.includes('Original error:'));
          return true;
        }
      );

      assert.equal(callCount, 1);
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
