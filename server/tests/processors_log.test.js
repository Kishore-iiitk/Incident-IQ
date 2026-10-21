import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  processLog,
  parseLine,
  clusterLines,
  extractStackTraces,
  normalizeTimestamp
} from '../processors/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Log Processor Unit Tests', () => {
  const tempDir = path.join(__dirname, 'fixtures', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  test('parses Demo LMS log format line accurately', () => {
    const line = '2026-10-20T10:42:11.123Z ERROR POST /upload 500 12ms msg="MongoNotConnectedError: Connection closed"';
    const parsed = parseLine(line);

    assert.ok(parsed);
    assert.equal(parsed.format, 'demo_lms');
    assert.equal(parsed.level, 'ERROR');
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.route, '/upload');
    assert.equal(parsed.status, 500);
    assert.equal(parsed.duration, 12);
    assert.equal(parsed.message, 'MongoNotConnectedError: Connection closed');
    assert.equal(parsed.timestamp, '2026-10-20T10:42:11.123Z');
  });

  test('parses Generic ISO timestamp lines', () => {
    const line = '2026-10-21T08:00:00.000Z WARN High memory usage detected on worker 4';
    const parsed = parseLine(line);

    assert.ok(parsed);
    assert.equal(parsed.format, 'generic_iso');
    assert.equal(parsed.level, 'WARN');
    assert.ok(parsed.message.includes('High memory usage'));
    assert.equal(parsed.timestamp, '2026-10-21T08:00:00.000Z');
  });

  test('parses Apache access log lines', () => {
    const line = '192.168.1.1 - frank [10/Oct/2026:13:55:36 +0000] "GET /courses HTTP/1.1" 500 2326';
    const parsed = parseLine(line);

    assert.ok(parsed);
    assert.equal(parsed.format, 'apache_access');
    assert.equal(parsed.level, 'ERROR');
    assert.equal(parsed.method, 'GET');
    assert.equal(parsed.route, '/courses');
    assert.equal(parsed.status, 500);
    assert.ok(parsed.timestamp.includes('2026-10-10'));
  });

  test('parses Apache error log lines', () => {
    const line = '[Wed Oct 11 14:32:52 2026] [error] [pid 2942] Connection to upstream server failed';
    const parsed = parseLine(line);

    assert.ok(parsed);
    assert.equal(parsed.format, 'apache_error');
    assert.equal(parsed.level, 'ERROR');
    assert.ok(parsed.message.includes('Connection to upstream server failed'));
  });

  test('extracts stack traces from multi-line log output', () => {
    const lines = [
      '2026-10-20T10:42:11.123Z ERROR POST /upload 500 12ms msg="Failed"',
      'Error: Database connection failed',
      '    at MongoClient.connect (/app/node_modules/mongodb/client.js:42:10)',
      '    at async connectLmsDB (/app/demo-lms/db.js:15:5)',
      '2026-10-20T10:42:12.000Z INFO GET /health 200 1ms msg="OK"'
    ];

    const stacks = extractStackTraces(lines);
    assert.equal(stacks.length, 1);
    assert.ok(stacks[0].includes('at MongoClient.connect'));
    assert.ok(stacks[0].includes('at async connectLmsDB'));
  });

  test('clusters repeated error lines into templates with occurrence counts', () => {
    const lines = [
      parseLine('2026-10-20T10:42:11.123Z ERROR GET /courses 500 12ms msg="Client must be connected"'),
      parseLine('2026-10-20T10:42:12.456Z ERROR GET /courses 500 15ms msg="Client must be connected"'),
      parseLine('2026-10-20T10:42:13.789Z ERROR GET /courses 500 8ms msg="Client must be connected"'),
      parseLine('2026-10-20T10:42:14.000Z ERROR POST /upload 500 5ms msg="UploadServiceFailure"')
    ];

    const templates = clusterLines(lines);
    assert.ok(templates.length >= 2);
    // Top template should be the repeated /courses line with count 3
    assert.equal(templates[0].count, 3);
    assert.equal(templates[1].count, 1);
  });

  test('processLog with mocked Gemini client produces AI summary', async () => {
    const logContent = `2026-10-21T08:00:00.000Z ERROR GET /courses 500 10ms msg="MongoNotConnectedError"
2026-10-21T08:00:01.000Z ERROR GET /courses 500 12ms msg="MongoNotConnectedError"`;

    let calledPrompt = null;
    const mockGemini = {
      models: {
        generateContent: async ({ contents }) => {
          calledPrompt = contents;
          return { text: JSON.stringify({ summary: 'Database outage causing 500 errors on course pages.' }) };
        }
      }
    };

    const evidence = await processLog({
      content: logContent,
      id: 'EV-01',
      geminiClient: mockGemini
    });

    assert.equal(evidence.id, 'EV-01');
    assert.equal(evidence.status, 'ok');
    assert.equal(evidence.summary, 'Database outage causing 500 errors on course pages.');
    assert.equal(evidence.confidence, 0.85);
    assert.ok(calledPrompt);
  });

  test('processLog falls back to parsed template summary when Gemini throws', async () => {
    const logContent = `2026-10-21T08:00:00.000Z ERROR GET /courses 500 10ms msg="MongoNotConnectedError"
2026-10-21T08:00:01.000Z ERROR GET /courses 500 12ms msg="MongoNotConnectedError"`;

    const mockFailingGemini = {
      models: {
        generateContent: async () => {
          throw new Error('Gemini API quota exceeded (offline test)');
        }
      }
    };

    const evidence = await processLog({
      content: logContent,
      id: 'EV-01',
      geminiClient: mockFailingGemini
    });

    assert.equal(evidence.status, 'ok');
    assert.ok(evidence.summary.includes('Log analysis'));
    assert.ok(evidence.summary.includes('MongoNotConnectedError'));
    assert.equal(evidence.confidence, 0.5, 'Fallback confidence should be 0.5');
  });

  test('processLog falls back when Gemini returns malformed JSON', async () => {
    const logContent = '2026-10-21T08:00:00.000Z ERROR GET /courses 500 10ms msg="DB Error"';
    const mockMalformedGemini = {
      models: {
        generateContent: async () => {
          return { text: 'Not valid json: { broken' };
        }
      }
    };

    const evidence = await processLog({
      content: logContent,
      id: 'EV-01',
      geminiClient: mockMalformedGemini
    });

    assert.equal(evidence.status, 'ok');
    assert.ok(evidence.summary.includes('Log analysis'));
    assert.equal(evidence.confidence, 0.5);
  });

  test('processLog handles empty content cleanly (status: failed, never throws)', async () => {
    const evidence = await processLog({ content: '', id: 'EV-01' });
    assert.equal(evidence.status, 'failed');
    assert.ok(evidence.reason);
  });

  test('processLog handles missing file path cleanly (status: skipped, never throws)', async () => {
    const evidence = await processLog({ filePath: '/nonexistent/path/app.log', id: 'EV-01' });
    assert.equal(evidence.status, 'skipped');
    assert.ok(evidence.reason.includes('File not found'));
  });

  test('processLog handles oversized file (> 5 MB) cleanly (status: failed, never throws)', async () => {
    const bigFile = path.join(tempDir, 'oversized.log');
    // Create 5.1 MB file
    const buffer = Buffer.alloc(5.1 * 1024 * 1024, 'a');
    fs.writeFileSync(bigFile, buffer);

    try {
      const evidence = await processLog({ filePath: bigFile, id: 'EV-01' });
      assert.equal(evidence.status, 'failed');
      assert.ok(evidence.reason.includes('exceeds 5 MB limit'));
    } finally {
      if (fs.existsSync(bigFile)) fs.unlinkSync(bigFile);
    }
  });
});
