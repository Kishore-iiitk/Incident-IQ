/**
 * Speech Processor (Phase 4)
 * Sends audio to Gemini for transcription and symptom extraction.
 * 
 * NEVER throws. Returns Evidence record with status "ok", "failed", or "skipped".
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redactSensitiveData } from '../utils/redactor.js';

// Zod schema for Gemini speech response
export const speechResponseSchema = z.object({
  transcript: z.string(),
  symptom: z.string(),
  affected_feature: z.string(),
  stated_impact: z.string()
});

// Allowed audio types
const ALLOWED_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME_MAP = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
};

/**
 * Process an audio file (voice note) and return an Evidence record.
 * @param {object} params
 * @param {string} params.filePath - Path to the audio file
 * @param {string} params.id - Evidence ID (e.g. "EV-03")
 * @param {object} [params.geminiClient] - Optional Gemini client
 * @returns {object} Evidence record
 */
export async function processSpeech({ filePath, id, geminiClient }) {
  try {
    // Validate file
    if (!filePath) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: 'No audio file provided',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'skipped',
        reason: 'No file path provided'
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: 'Audio file not found',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'skipped',
        reason: `File not found: ${filePath}`
      };
    }

    // Check file type
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: `Unsupported audio type: ${ext}`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `Unsupported audio type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      };
    }

    // Check file size
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_SIZE_BYTES) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: `Audio file too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `File size ${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds 10 MB limit`
      };
    }

    if (stats.size === 0) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: 'Empty audio file',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Audio file is empty (0 bytes)'
      };
    }

    // Need Gemini client for audio processing
    if (!geminiClient) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: 'Audio processing unavailable: no Gemini client',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Gemini client not available for audio transcription'
      };
    }

    // Read and encode audio
    const audioData = fs.readFileSync(filePath);
    const base64Audio = audioData.toString('base64');
    const mimeType = MIME_MAP[ext] || 'audio/mp4';

    try {
      const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
      const response = await geminiClient.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Audio
                }
              },
              {
                text: `Transcribe this voice note about a software incident. Return a JSON object with exactly these fields:
{
  "transcript": "full transcription of the audio",
  "symptom": "the main symptom or problem described",
  "affected_feature": "the software feature or system affected",
  "stated_impact": "the impact described by the speaker (free text, NOT a severity level)"
}
Return ONLY valid JSON.`
              }
            ]
          }
        ],
        config: { responseMimeType: 'application/json' }
      });

      const text = response.text || (typeof response === 'string' ? response : JSON.stringify(response));
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(cleaned);
      const validated = speechResponseSchema.parse(parsed);

      // Redact any PII from the transcript
      const redactedTranscript = redactSensitiveData(validated.transcript);

      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: `Voice note: ${validated.symptom}. Feature: ${validated.affected_feature}. Impact: ${validated.stated_impact}`,
        entities: validated.affected_feature ? [validated.affected_feature] : [],
        errors: validated.symptom ? [validated.symptom] : [],
        timestamps: [],
        confidence: 0.7,
        status: 'ok',
        speechResult: {
          ...validated,
          transcript: redactedTranscript
        }
      };
    } catch (geminiErr) {
      return {
        id,
        source: 'voice_note',
        type: 'audio',
        summary: `Audio transcription failed: ${geminiErr.message}`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `Gemini audio processing failed: ${geminiErr.message}`
      };
    }
  } catch (err) {
    return {
      id,
      source: 'voice_note',
      type: 'audio',
      summary: `Speech processing failed: ${err.message}`,
      entities: [],
      errors: [],
      timestamps: [],
      confidence: 0,
      status: 'failed',
      reason: err.message
    };
  }
}
