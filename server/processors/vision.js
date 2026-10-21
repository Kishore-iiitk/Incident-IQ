/**
 * Vision Processor (Phase 4)
 * Sends screenshots to Gemini Vision for analysis, with tesseract.js OCR fallback.
 * 
 * NEVER throws. Returns Evidence record with status "ok", "failed", or "skipped".
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redactSensitiveData } from '../utils/redactor.js';

// Zod schema for Gemini vision response
export const visionResponseSchema = z.object({
  visible_text: z.string(),
  error_codes: z.array(z.string()),
  ui_problem: z.string(),
  confidence: z.number().min(0).max(1)
});

// Allowed image types and max size
const ALLOWED_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// MIME type mapping
const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

/**
 * Process a screenshot image and return an Evidence record.
 * @param {object} params
 * @param {string} params.filePath - Path to the image file
 * @param {string} params.id - Evidence ID (e.g. "EV-02")
 * @param {object} [params.geminiClient] - Optional Gemini client for vision analysis
 * @returns {object} Evidence record
 */
export async function processVision({ filePath, id, geminiClient }) {
  try {
    // Validate file exists
    if (!filePath) {
      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: 'No screenshot file provided',
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
        source: 'screenshot',
        type: 'image',
        summary: 'Screenshot file not found',
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
    if (!ALLOWED_TYPES.includes(ext)) {
      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: `Unsupported image type: ${ext}`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `Unsupported image type: ${ext}. Allowed: ${ALLOWED_TYPES.join(', ')}`
      };
    }

    // Check file size
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_SIZE_BYTES) {
      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: `Image file too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `File size ${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds 5 MB limit`
      };
    }

    if (stats.size === 0) {
      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: 'Empty image file',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: 'Image file is empty (0 bytes)'
      };
    }

    // Read image data
    const imageData = fs.readFileSync(filePath);
    const base64Image = imageData.toString('base64');
    const mimeType = MIME_MAP[ext] || 'image/png';

    // Try Gemini Vision
    if (geminiClient) {
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
                    data: base64Image
                  }
                },
                {
                  text: `Analyze this screenshot from a software application. Return a JSON object with exactly these fields:
{
  "visible_text": "all visible text in the screenshot",
  "error_codes": ["any error codes visible, e.g. HTTP 500, ERR_CONNECTION_REFUSED"],
  "ui_problem": "description of any UI problem or error state visible",
  "confidence": 0.0 to 1.0
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
        const validated = visionResponseSchema.parse(parsed);

        return {
          id,
          source: 'screenshot',
          type: 'image',
          summary: `Screenshot analysis: ${validated.ui_problem}. Visible text: ${validated.visible_text.substring(0, 200)}`,
          entities: [],
          errors: validated.error_codes,
          timestamps: [],
          confidence: validated.confidence,
          status: 'ok',
          visionResult: validated
        };
      } catch (geminiErr) {
        console.warn(`[VisionProcessor] Gemini vision failed: ${geminiErr.message}. Trying OCR fallback.`);
      }
    }

    // Fallback: try tesseract.js OCR
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      const { data: { text: ocrText } } = await worker.recognize(filePath);
      await worker.terminate();

      const redactedText = redactSensitiveData(ocrText || '');

      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: `OCR extracted text (Gemini unavailable): ${redactedText.substring(0, 300)}`,
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0.3,
        status: 'ok',
        note: 'Used OCR fallback (Gemini vision unavailable)',
        ocrText: redactedText
      };
    } catch (ocrErr) {
      // Both Gemini and OCR failed
      return {
        id,
        source: 'screenshot',
        type: 'image',
        summary: 'Screenshot processing failed: neither Gemini Vision nor OCR available',
        entities: [],
        errors: [],
        timestamps: [],
        confidence: 0,
        status: 'failed',
        reason: `Gemini and OCR both failed. OCR error: ${ocrErr.message}`
      };
    }
  } catch (err) {
    return {
      id,
      source: 'screenshot',
      type: 'image',
      summary: `Vision processing failed: ${err.message}`,
      entities: [],
      errors: [],
      timestamps: [],
      confidence: 0,
      status: 'failed',
      reason: err.message
    };
  }
}
