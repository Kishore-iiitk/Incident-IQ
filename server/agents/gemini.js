import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { redactSensitiveData } from '../utils/redactor.js';
import { Analysis } from '../models/index.js';
import { PROMPT_VERSION, STAGE_SCHEMAS } from './prompts/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Execute an LLM stage with redaction, JSON enforcement, Zod validation,
 * single retry on failure, and audit recording in the analyses collection.
 */
export async function runGeminiStage({
  stage,
  systemPrompt,
  userPrompt,
  schema = STAGE_SCHEMAS[stage],
  incidentId = null,
  isStrongModel = false,
  mockClient = null // for testing retry & validation mechanics
}) {
  const startTime = Date.now();
  const fastModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const strongModel = process.env.GEMINI_MODEL_STRONG || 'gemini-2.5-pro';
  const modelName = isStrongModel ? strongModel : fastModel;

  // 1. Redact input before sending to external API
  const redactedUserPrompt = redactSensitiveData(userPrompt);
  const redactedSystemPrompt = redactSensitiveData(systemPrompt);

  const isDemoMode = process.env.DEMO_MODE === 'true';

  let rawOutputText = null;
  let parsedJSON = null;
  let validatedOutput = null;
  let usedModel = modelName;
  let isFromDemoCache = false;

  // 2. DEMO_MODE handling: serve real recorded output from cache if enabled
  if (isDemoMode) {
    if (recordedRunsCache && recordedRunsCache[stage]) {
      console.log(`[GeminiAgent] DEMO_MODE=true: Serving recorded real output for stage "${stage}"`);
      const cached = JSON.parse(JSON.stringify(recordedRunsCache[stage]));
      
      // If evidenceId placeholder is in cached output, map to real evidence ID if present
      if (stage === 'root_cause' && userPrompt) {
        const idMatch = userPrompt.match(/"_id":\s*"([a-f0-9]{24})"/i) || userPrompt.match(/"id":\s*"([a-f0-9]{24})"/i);
        if (idMatch && cached.supporting_evidence) {
          cached.supporting_evidence = cached.supporting_evidence.map(item => ({
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
      usedModel = `${modelName} (DEMO_MODE cache)`;
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

    const client = mockClient || new GoogleGenAI({ apiKey });

    // Function to perform generation call
    const callModel = async (prompt) => {
      if (mockClient && mockClient.models && mockClient.models.generateContent) {
        return await mockClient.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction: redactedSystemPrompt,
            responseMimeType: 'application/json'
          }
        });
      }

      const response = await client.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction: `${redactedSystemPrompt}\nIMPORTANT: You must respond ONLY with raw, valid JSON. Do not include markdown codeblocks or preamble.`,
          responseMimeType: 'application/json'
        }
      });
      return response;
    };

    // Attempt 1
    try {
      const response = await callModel(redactedUserPrompt);
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
    } catch (firstAttemptErr) {
      console.warn(`[GeminiAgent] Stage "${stage}" attempt 1 failed: ${firstAttemptErr.message}. Retrying once with error feedback...`);

      // Attempt 2 (Retry once with validation error feedback)
      try {
        const retryPrompt = `${redactedUserPrompt}

PREVIOUS ATTEMPT FAILED SCHEMA VALIDATION.
Reason for failure: ${firstAttemptErr.message}
Previous raw output: ${rawOutputText || 'Invalid format'}

CRITICAL REQUIREMENT: Return ONLY strictly valid JSON adhering exactly to the specified schema, correcting the issues above.`;

        const retryResponse = await callModel(retryPrompt);
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
      } catch (secondAttemptErr) {
        const latencyMs = Date.now() - startTime;
        console.error(`[GeminiAgent] Stage "${stage}" failed after retry:`, secondAttemptErr.message);

        // Record failed analysis attempt if incidentId is provided
        if (incidentId) {
          try {
            await Analysis.create({
              incident_id: incidentId,
              stage,
              output: { error: secondAttemptErr.message, raw: rawOutputText },
              model: modelName,
              prompt_version: PROMPT_VERSION,
              latency_ms: latencyMs
            });
          } catch (dbErr) {
            console.error('[GeminiAgent] Failed to save error analysis record:', dbErr.message);
          }
        }

        throw new Error(`[GeminiAgent] Stage "${stage}" failed after 1 retry: ${secondAttemptErr.message}`);
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
