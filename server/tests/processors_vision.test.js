import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processVision, visionResponseSchema } from '../processors/vision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Vision Processor Unit Tests', () => {
  const tempDir = path.join(__dirname, 'fixtures', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 1x1 valid transparent PNG
  const validPngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  test('processVision returns status "skipped" when no file path is provided', async () => {
    const evidence = await processVision({ filePath: null, id: 'EV-02' });
    assert.equal(evidence.id, 'EV-02');
    assert.equal(evidence.status, 'skipped');
    assert.equal(evidence.confidence, 0);
  });

  test('processVision returns status "skipped" when file does not exist', async () => {
    const evidence = await processVision({ filePath: '/nonexistent/screenshot.png', id: 'EV-02' });
    assert.equal(evidence.status, 'skipped');
    assert.ok(evidence.reason.includes('File not found'));
  });

  test('processVision rejects unsupported file type (status: failed)', async () => {
    const dummyPath = path.join(tempDir, 'document.pdf');
    fs.writeFileSync(dummyPath, 'fake pdf content');

    try {
      const evidence = await processVision({ filePath: dummyPath, id: 'EV-02' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('Unsupported image type'));
    } finally {
      if (fs.existsSync(dummyPath)) fs.unlinkSync(dummyPath);
    }
  });

  test('processVision rejects oversized file > 5 MB (status: failed)', async () => {
    const bigImagePath = path.join(tempDir, 'huge_screenshot.png');
    const buffer = Buffer.alloc(5.2 * 1024 * 1024, 0);
    fs.writeFileSync(bigImagePath, buffer);

    try {
      const evidence = await processVision({ filePath: bigImagePath, id: 'EV-02' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('exceeds 5 MB limit'));
    } finally {
      if (fs.existsSync(bigImagePath)) fs.unlinkSync(bigImagePath);
    }
  });

  test('processVision rejects empty file (0 bytes) (status: failed)', async () => {
    const emptyImgPath = path.join(tempDir, 'empty.png');
    fs.writeFileSync(emptyImgPath, Buffer.alloc(0));

    try {
      const evidence = await processVision({ filePath: emptyImgPath, id: 'EV-02' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('empty'));
    } finally {
      if (fs.existsSync(emptyImgPath)) fs.unlinkSync(emptyImgPath);
    }
  });

  test('processVision with mocked Gemini Vision parses and validates response with Zod', async () => {
    const imgPath = path.join(tempDir, 'test_screenshot.png');
    fs.writeFileSync(imgPath, validPngBuffer);

    const mockGemini = {
      models: {
        generateContent: async () => {
          return {
            text: JSON.stringify({
              visible_text: 'HTTP 500 Internal Server Error. Client must be connected before running operations.',
              error_codes: ['HTTP 500'],
              ui_problem: 'Red error banner displayed on /courses page',
              confidence: 0.92
            })
          };
        }
      }
    };

    try {
      const evidence = await processVision({
        filePath: imgPath,
        id: 'EV-02',
        geminiClient: mockGemini
      });

      assert.equal(evidence.id, 'EV-02');
      assert.equal(evidence.status, 'ok');
      assert.equal(evidence.confidence, 0.92);
      assert.ok(evidence.summary.includes('Red error banner'));
      assert.deepEqual(evidence.errors, ['HTTP 500']);
      assert.ok(evidence.visionResult);
    } finally {
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
  });

  test('processVision falls back gracefully when Gemini throws (never throws exception)', async () => {
    const imgPath = path.join(tempDir, 'test_fallback.png');
    fs.writeFileSync(imgPath, validPngBuffer);

    const mockFailingGemini = {
      models: {
        generateContent: async () => {
          throw new Error('Gemini offline mock failure');
        }
      }
    };

    try {
      // Must NOT throw
      const evidence = await processVision({
        filePath: imgPath,
        id: 'EV-02',
        geminiClient: mockFailingGemini
      });

      // OCR might succeed or fail depending on Tesseract installation, but status is never an unhandled exception
      assert.ok(['ok', 'failed'].includes(evidence.status));
      assert.equal(evidence.id, 'EV-02');
    } finally {
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
  });
});
