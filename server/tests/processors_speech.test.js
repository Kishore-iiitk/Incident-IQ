import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processSpeech, speechResponseSchema } from '../processors/speech.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Speech Processor Unit Tests', () => {
  const tempDir = path.join(__dirname, 'fixtures', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  test('processSpeech returns status "skipped" when no file path is provided', async () => {
    const evidence = await processSpeech({ filePath: null, id: 'EV-03' });
    assert.equal(evidence.id, 'EV-03');
    assert.equal(evidence.status, 'skipped');
    assert.equal(evidence.confidence, 0);
  });

  test('processSpeech returns status "skipped" when file does not exist', async () => {
    const evidence = await processSpeech({ filePath: '/nonexistent/voice.m4a', id: 'EV-03' });
    assert.equal(evidence.status, 'skipped');
    assert.ok(evidence.reason.includes('File not found'));
  });

  test('processSpeech rejects unsupported audio extension (status: failed)', async () => {
    const fakeFilePath = path.join(tempDir, 'voice.txt');
    fs.writeFileSync(fakeFilePath, 'not an audio file');

    try {
      const evidence = await processSpeech({ filePath: fakeFilePath, id: 'EV-03' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('Unsupported audio type'));
    } finally {
      if (fs.existsSync(fakeFilePath)) fs.unlinkSync(fakeFilePath);
    }
  });

  test('processSpeech rejects oversized file > 10 MB (status: failed)', async () => {
    const bigAudioPath = path.join(tempDir, 'huge_voice.m4a');
    const buffer = Buffer.alloc(10.5 * 1024 * 1024, 0);
    fs.writeFileSync(bigAudioPath, buffer);

    try {
      const evidence = await processSpeech({ filePath: bigAudioPath, id: 'EV-03' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('exceeds 10 MB limit'));
    } finally {
      if (fs.existsSync(bigAudioPath)) fs.unlinkSync(bigAudioPath);
    }
  });

  test('processSpeech rejects empty file (0 bytes) (status: failed)', async () => {
    const emptyAudioPath = path.join(tempDir, 'empty_voice.m4a');
    fs.writeFileSync(emptyAudioPath, Buffer.alloc(0));

    try {
      const evidence = await processSpeech({ filePath: emptyAudioPath, id: 'EV-03' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('empty'));
    } finally {
      if (fs.existsSync(emptyAudioPath)) fs.unlinkSync(emptyAudioPath);
    }
  });

  test('processSpeech with mocked Gemini parses JSON with free-text impact and redacts transcript', async () => {
    const audioPath = path.join(tempDir, 'sample_note.m4a');
    fs.writeFileSync(audioPath, Buffer.from('mock audio header and bytes'));

    const mockGemini = {
      models: {
        generateContent: async () => {
          return {
            text: JSON.stringify({
              transcript: 'Hi this is John Doe from student support, user student@university.edu is unable to upload homework solutions due to server error.',
              symptom: 'Upload button fails with server error',
              affected_feature: 'assignment-upload',
              stated_impact: 'Students cannot submit assignments before midnight deadline' // Free text, NOT severity level
            })
          };
        }
      }
    };

    try {
      const evidence = await processSpeech({
        filePath: audioPath,
        id: 'EV-03',
        geminiClient: mockGemini
      });

      assert.equal(evidence.id, 'EV-03');
      assert.equal(evidence.status, 'ok');
      assert.equal(evidence.confidence, 0.7);
      assert.ok(evidence.summary.includes('assignment-upload'));
      assert.ok(evidence.speechResult);
      assert.equal(evidence.speechResult.stated_impact, 'Students cannot submit assignments before midnight deadline');
      // Verifies transcript PII redaction
      assert.ok(!evidence.speechResult.transcript.includes('student@university.edu'));
      assert.ok(evidence.speechResult.transcript.includes('[REDACTED_EMAIL]'));
    } finally {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  });

  test('processSpeech fails cleanly when Gemini throws (status: failed, never throws)', async () => {
    const audioPath = path.join(tempDir, 'failing_audio.m4a');
    fs.writeFileSync(audioPath, Buffer.from('mock audio content'));

    const mockFailingGemini = {
      models: {
        generateContent: async () => {
          throw new Error('API connection timeout');
        }
      }
    };

    try {
      const evidence = await processSpeech({
        filePath: audioPath,
        id: 'EV-03',
        geminiClient: mockFailingGemini
      });

      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('API connection timeout'));
    } finally {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  });

  test('processSpeech in DEMO_MODE prevents external Gemini calls and returns honest skipped status', async () => {
    const audioPath = path.join(tempDir, 'demo_audio.m4a');
    fs.writeFileSync(audioPath, Buffer.from('demo audio binary content'));

    let externalCallMade = false;
    const mockNetworkGemini = {
      models: {
        generateContent: async () => {
          externalCallMade = true;
          throw new Error('External API call must not be made in DEMO_MODE');
        }
      }
    };

    const prevDemoMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';

    try {
      const evidence = await processSpeech({
        filePath: audioPath,
        id: 'EV-03',
        geminiClient: mockNetworkGemini
      });

      assert.equal(externalCallMade, false, 'External Gemini API must NOT be called in DEMO_MODE');
      assert.equal(evidence.status, 'skipped', 'Must return honest skipped status');
      assert.equal(evidence.confidence, 0);
      assert.equal(evidence.reason, 'Audio transcription is unavailable in DEMO_MODE (external API disabled)');
      assert.ok(!evidence.speechResult, 'Must not invent fake speechResult or transcript');
    } finally {
      process.env.DEMO_MODE = prevDemoMode;
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  });

  test('processSpeech returns status skipped when geminiClient is absent', async () => {
    const audioPath = path.join(tempDir, 'no_client_audio.m4a');
    fs.writeFileSync(audioPath, Buffer.from('sample audio content'));

    try {
      const evidence = await processSpeech({
        filePath: audioPath,
        id: 'EV-03',
        geminiClient: null
      });

      assert.equal(evidence.status, 'skipped');
      assert.equal(evidence.confidence, 0);
      assert.ok(evidence.reason.includes('Gemini client not available'));
    } finally {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  });
});

