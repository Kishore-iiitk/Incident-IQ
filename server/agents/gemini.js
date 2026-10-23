import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { redactSensitiveData } from '../utils/redactor.js';
import { Analysis } from '../models/index.js';
import { PROMPT_VERSION, STAGE_SCHEMAS } from './prompts/index.js';
import { wrapGeminiClient, isDailyQuotaExhausted } from '../utils/geminiLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables if not already loaded
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Load recorded runs cache for DEMO_MODE
let recordedRunsCache = null;
try {
  const cachePath = path.join(__dirname, 'cache', 'recorded_runs.json');
  if (fs.existsSync(cachePath)) {
    recordedRunsCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
} catch (err) {
  console.warn('[GeminiAgent] Warning: could not load recorded runs cache:', err.message);
}

// Default injectable sleep function
let globalSleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setSleepFunction(fn) {
  globalSleepFn = fn;
}

export function getSleepFunction() {
  return globalSleepFn;
}

/**
 * Clean and parse raw JSON text from model output
 */
export function extractJSON(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty or non-string model output received');
  }

  // Strip code blocks like ```json ... ``` or ``` ... ```
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  // Find first { and last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

/**
 * Classify errors into retryable transport errors vs fail-fast errors.
 */
export function parseTransportError(error, modelName = '') {
  if (!error) return { isRetryable: false, status: 0, message: '' };

  const status = error.status || error.statusCode || error.error?.code || error.response?.status || 0;
  const msg = (error.message || '').toLowerCase();

  // Fail-fast status codes: 400, 401, 403, 404 (NEVER retry)
  if (status === 404 || msg.includes('404') || msg.includes('not found')) {
    return {
      isRetryable: false,
      status: 404,
      message: `Model "${modelName}" not found (HTTP 404). The model name in GEMINI_MODEL is probably wrong: ${error.message}`
    };
  }
  if (status === 400 || msg.includes('400') || msg.includes('bad request') || msg.includes('invalid argument')) {
    return { isRetryable: false, status: 400, message: error.message };
  }
  if (status === 401 || msg.includes('401') || msg.includes('unauthorized') || msg.includes('api_key_invalid')) {
    return { isRetryable: false, status: 401, message: error.message };
  }
  if (status === 403 || msg.includes('403') || msg.includes('forbidden') || msg.includes('permission denied')) {
    return { isRetryable: false, status: 403, message: error.message };
  }

  // Retryable HTTP status codes: 429, 500, 502, 503, 504
  if ([429, 500, 502, 503, 504].includes(status)) {
    return { isRetryable: true, status, message: error.message };
  }

  // Retryable network or timeout patterns
  if (
    msg.includes('503') ||
    msg.includes('high demand') ||
    msg.includes('service unavailable') ||
    msg.includes('502') ||
    msg.includes('bad gateway') ||
    msg.includes('504') ||
    msg.includes('gateway timeout') ||
    msg.includes('500') ||
    msg.includes('internal server error') ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('abort')
  ) {
    return { isRetryable: true, status: status || 503, message: error.message };
  }

  return { isRetryable: false, status, message: error.message };
}

/**
 * Parse Retry-After header or retry delay from error if present
 */
export function parseRetryAfter(error) {
  if (!error) return null;
  if (error.response && error.response.headers) {
    const headers = error.response.headers;
    const retryAfter = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
    if (retryAfter) {
      const parsed = parseFloat(retryAfter);
      if (!isNaN(parsed) && parsed > 0) return Math.ceil(parsed * 1000);
    }
  }
  if (error.retryAfter) {
    const parsed = parseFloat(error.retryAfter);
    if (!isNaN(parsed) && parsed > 0) return Math.ceil(parsed * 1000);
  }
  return null;
}

/**
 * Execute a single generation call with transport retries up to maxAttempts.
 */
async function executeTransportCall({
  client,
  modelName,
  prompt,
  redactedSystemPrompt,
  mockClient,
  maxAttempts,
  sleepFn
}) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (mockClient && mockClient.models && mockClient.models.generateContent) {
        return await client.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction: redactedSystemPrompt,
            responseMimeType: 'application/json'
          }
        });
      }

      return await client.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction: `${redactedSystemPrompt}\nIMPORTANT: You must respond ONLY with raw, valid JSON. Do not include markdown codeblocks or preamble.`,
          responseMimeType: 'application/json'
        }
      });
    } catch (err) {
      if (isDailyQuotaExhausted(err) || err.name === 'GeminiQuotaExceededError') {
        throw err;
      }

      const { isRetryable, status, message } = parseTransportError(err, modelName);

      if (!isRetryable) {
        const fatalErr = new Error(message || err.message);
        fatalErr.status = status;
        throw fatalErr;
      }

      if (attempt >= maxAttempts) {
        const exhaustedErr = new Error(`Gemini transport failed after ${maxAttempts} attempts for model "${modelName}": ${err.message}`);
        exhaustedErr.status = status;
        exhaustedErr.originalError = err;
        exhaustedErr.isRetryable = true;
        throw exhaustedErr;
      }

      // Calculate backoff: 2s, 4s, 8s plus random jitter up to 1s, or honour Retry-After
      const retryAfterMs = parseRetryAfter(err);
      let waitMs;
      if (retryAfterMs !== null) {
        waitMs = retryAfterMs;
      } else {
        const baseMs = 2000 * Math.pow(2, attempt - 1);
        const jitterMs = Math.random() * 1000;
        waitMs = baseMs + jitterMs;
      }

      console.warn(`[GeminiAgent] Transport attempt ${attempt}/${maxAttempts} failed with ${status || 'network error'}: ${err.message}. Retrying in ${Math.round(waitMs)}ms...`);
      await sleepFn(waitMs);
    }
  }
}

/**
 * Execute an LLM stage with redaction, JSON enforcement, Zod validation,
 * transport retries with exponential backoff & fallback model,
 * single retry on invalid JSON, and audit recording in the analyses collection.
 */
export async function runGeminiStage({
  stage,
  systemPrompt,
  userPrompt,
  schema = STAGE_SCHEMAS[stage],
  incidentId = null,
  isStrongModel = false,
  mockClient = null,
  sleepFn = globalSleepFn
}) {
  const startTime = Date.now();
  const fastModel = process.env.GEMINI_MODEL || (mockClient ? 'mock-model' : null);
  const strongModel = process.env.GEMINI_MODEL_STRONG || fastModel;
  const primaryModelName = isStrongModel ? strongModel : fastModel;

  if (!primaryModelName) {
    throw new Error('GEMINI_MODEL environment variable is missing.');
  }

  // 1. Redact input before sending to external API
  const redactedUserPrompt = redactSensitiveData(userPrompt);
  const redactedSystemPrompt = redactSensitiveData(systemPrompt);

  const isDemoMode = process.env.DEMO_MODE === 'true';

  let rawOutputText = null;
  let parsedJSON = null;
  let validatedOutput = null;
  let usedModel = primaryModelName;
  let isFromDemoCache = false;

  // 2. DEMO_MODE handling: serve real recorded output from cache if enabled
  if (isDemoMode) {
    if (recordedRunsCache && recordedRunsCache[stage]) {
      console.log(`[GeminiAgent] DEMO_MODE=true: Serving recorded real output for stage "${stage}"`);
      const cached = JSON.parse(JSON.stringify(recordedRunsCache[stage]));

      if (stage === 'root_cause' && userPrompt) {
        const idMatch = userPrompt.match(/"_id":\s*"([a-f0-9]{24})"/i) || userPrompt.match(/"id":\s*"([a-f0-9]{24})"/i);
        if (idMatch && cached.supporting_evidence) {
          cached.supporting_evidence = cached.supporting_evidence.map((item) => ({
            ...item,
            evidence_id: idMatch[1]
          }));
        }
      }

      parsedJSON = cached;
      const parseResult = schema ? schema.safeParse(parsedJSON) : { success: true, data: parsedJSON };
      if (!parseResult.success) {
        throw new Error(`[GeminiAgent] Cached output failed schema validation: ${parseResult.error.message}`);
      }
      validatedOutput = parseResult.data;
      validatedOutput._demo_mode = true;
      isFromDemoCache = true;
      usedModel = `${primaryModelName} (DEMO_MODE cache)`;
    } else {
      throw new Error(`[GeminiAgent] DEMO_MODE is true, but no recorded run was found for stage "${stage}".`);
    }
  } else {
    // Live Gemini invocation
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey && !mockClient) {
      throw new Error(
        `[GeminiAgent] GEMINI_API_KEY environment variable is missing and DEMO_MODE is not true. No fake AI is allowed per system rules.`
      );
    }

    const rawClient = mockClient || new GoogleGenAI({ apiKey });
    const client = mockClient ? mockClient : wrapGeminiClient(rawClient);

    const maxAttempts = parseInt(process.env.GEMINI_MAX_ATTEMPTS, 10) || 4;
    const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || '').trim();

    // Helper to run transport call with fallback model if primary fails
    const runCall = async (promptToSend) => {
      try {
        const response = await executeTransportCall({
          client,
          modelName: primaryModelName,
          prompt: promptToSend,
          redactedSystemPrompt,
          mockClient,
          maxAttempts,
          sleepFn
        });
        usedModel = primaryModelName;
        return response;
      } catch (primaryErr) {
        if (primaryErr.isRetryable && fallbackModel && fallbackModel !== primaryModelName) {
          console.warn(`[GeminiAgent] Primary model "${primaryModelName}" exhausted retryable attempts. Trying fallback model "${fallbackModel}"...`);
          const response = await executeTransportCall({
            client,
            modelName: fallbackModel,
            prompt: promptToSend,
            redactedSystemPrompt,
            mockClient,
            maxAttempts,
            sleepFn
          });
          usedModel = fallbackModel;
          return response;
        }
        throw primaryErr;
      }
    };

    // Attempt 1: Call model
    let response;
    try {
      response = await runCall(redactedUserPrompt);
    } catch (transportErr) {
      const latencyMs = Date.now() - startTime;
      if (incidentId) {
        try {
          await Analysis.create({
            incident_id: incidentId,
            stage,
            output: { error: transportErr.message },
            model: usedModel,
            prompt_version: PROMPT_VERSION,
            latency_ms: latencyMs
          });
        } catch (dbErr) {
          console.error('[GeminiAgent] Failed to save error analysis record:', dbErr.message);
        }
      }
      throw transportErr;
    }

    // Try parsing and validating JSON
    try {
      rawOutputText = response.text || (typeof response === 'string' ? response : JSON.stringify(response));
      parsedJSON = extractJSON(rawOutputText);

      if (schema) {
        const validation = schema.safeParse(parsedJSON);
        if (!validation.success) {
          throw new Error(`Schema validation error: ${validation.error.message}`);
        }
        validatedOutput = validation.data;
      } else {
        validatedOutput = parsedJSON;
      }
    } catch (firstJsonErr) {
      console.warn(`[GeminiAgent] Stage "${stage}" attempt 1 failed JSON parsing/validation: ${firstJsonErr.message}. Retrying once with error feedback...`);

      // Attempt 2 (Retry once with error feedback for invalid JSON)
      try {
        const retryPrompt = `${redactedUserPrompt}

PREVIOUS ATTEMPT FAILED SCHEMA VALIDATION.
Reason for failure: ${firstJsonErr.message}
Previous raw output: ${rawOutputText || 'Invalid format'}

CRITICAL REQUIREMENT: Return ONLY strictly valid JSON adhering exactly to the specified schema, correcting the issues above.`;

        const retryResponse = await runCall(retryPrompt);
        rawOutputText = retryResponse.text || (typeof retryResponse === 'string' ? retryResponse : JSON.stringify(retryResponse));
        parsedJSON = extractJSON(rawOutputText);

        if (schema) {
          const secondValidation = schema.safeParse(parsedJSON);
          if (!secondValidation.success) {
            throw new Error(`Schema validation error on retry: ${secondValidation.error.message}`);
          }
          validatedOutput = secondValidation.data;
        } else {
          validatedOutput = parsedJSON;
        }
      } catch (secondJsonErr) {
        const latencyMs = Date.now() - startTime;
        console.error(`[GeminiAgent] Stage "${stage}" failed after JSON retry:`, secondJsonErr.message);

        if (incidentId) {
          try {
            await Analysis.create({
              incident_id: incidentId,
              stage,
              output: { error: secondJsonErr.message, raw: rawOutputText },
              model: usedModel,
              prompt_version: PROMPT_VERSION,
              latency_ms: latencyMs
            });
          } catch (dbErr) {
            console.error('[GeminiAgent] Failed to save error analysis record:', dbErr.message);
          }
        }

        throw new Error(`[GeminiAgent] Stage "${stage}" failed after 1 retry: ${secondJsonErr.message}`);
      }
    }
  }

  const latencyMs = Date.now() - startTime;

  // 3. Save analysis record to MongoDB
  if (incidentId) {
    try {
      await Analysis.create({
        incident_id: incidentId,
        stage,
        output: validatedOutput,
        model: usedModel,
        prompt_version: PROMPT_VERSION,
        latency_ms: latencyMs
      });
    } catch (saveErr) {
      console.error(`[GeminiAgent] Could not save analysis record for stage ${stage}:`, saveErr.message);
    }
  }

  return {
    output: validatedOutput,
    latencyMs,
    model: usedModel,
    promptVersion: PROMPT_VERSION,
    isDemoMode: isFromDemoCache
  };
}

export function getGeminiClient() {
  if (process.env.DEMO_MODE === 'true') return null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return wrapGeminiClient(new GoogleGenAI({ apiKey }));
}
