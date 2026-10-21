import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveData } from '../utils/redactor.js';
import { processLog } from '../processors/log.js';

describe('Redactor Extended Tests (Phase 4)', () => {
  test('redacts email addresses', () => {
    const text = 'Contact lead engineer at jane.doe@company.org for access.';
    const result = redactSensitiveData(text);
    assert.ok(!result.includes('jane.doe@company.org'));
    assert.ok(result.includes('[REDACTED_EMAIL]'));
  });

  test('redacts phone numbers in various formats', () => {
    const text = 'Call escalation line at +1 (555) 345-6789 or 555.234.5678 immediately.';
    const result = redactSensitiveData(text);
    assert.ok(!result.includes('555'));
    assert.ok(result.includes('[REDACTED_PHONE]'));
  });

  test('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secretKey1234567890';
    const result = redactSensitiveData(text);
    assert.ok(!result.includes('eyJhbGciOiJIUzI1Ni'));
    assert.ok(result.includes('Bearer [REDACTED_TOKEN]'));
  });

  test('redacts API key definitions and secrets', () => {
    const text = 'Connecting with api_key="sk-live998877665544332211aabbccddeeff" and secret="superSecretPass12345678"';
    const result = redactSensitiveData(text);
    assert.ok(!result.includes('sk-live998877665544332211aabbccddeeff'));
    assert.ok(!result.includes('superSecretPass12345678'));
    assert.ok(result.includes('[REDACTED_TOKEN]'));
  });

  test('redacts long hexadecimal strings (32+ characters)', () => {
    const hex = '4f8b2c1d9e7a6f5e4d3c2b1a0f9e8d7c'; // 32 hex chars
    const text = `Session auth token: ${hex} expired`;
    const result = redactSensitiveData(text);
    assert.ok(!result.includes(hex));
    assert.ok(result.includes('[REDACTED_TOKEN]'));
  });

  test('preserves short hex identifiers like MongoDB ObjectIDs (24 chars)', () => {
    const mongoId = '507f1f77bcf86cd799439011';
    const text = `Document id is ${mongoId}`;
    const result = redactSensitiveData(text);
    assert.ok(result.includes(mongoId));
  });

  test('redacts long base64 strings', () => {
    const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=';
    const text = `Client public key cert: ${b64}`;
    const result = redactSensitiveData(text);
    assert.ok(!result.includes(b64));
    assert.ok(result.includes('[REDACTED_TOKEN]'));
  });

  test('redacts personal names in user, reporter and greeting contexts', () => {
    const text1 = 'Reporter: Alice Smith submitted the ticket.';
    const text2 = 'Dear Bob Johnson,\nPlease review.';
    const text3 = 'Best regards,\nCharlie Davis';

    const r1 = redactSensitiveData(text1);
    const r2 = redactSensitiveData(text2);
    const r3 = redactSensitiveData(text3);

    assert.ok(!r1.includes('Alice Smith'));
    assert.ok(r1.includes('[REDACTED_NAME]'));

    assert.ok(!r2.includes('Bob Johnson'));
    assert.ok(r2.includes('[REDACTED_NAME]'));

    assert.ok(!r3.includes('Charlie Davis'));
    assert.ok(r3.includes('[REDACTED_NAME]'));
  });

  test('PROVES fake email and fake token NEVER reach a mocked Gemini call', async () => {
    const FAKE_EMAIL = 'confidential.leaked.admin@secret-internal.enterprise.org';
    const FAKE_TOKEN = 'sk-prod-99998888777766665555444433332222';

    let capturedPrompt = '';
    const mockGeminiClient = {
      models: {
        generateContent: async ({ contents }) => {
          capturedPrompt = typeof contents === 'string' ? contents : JSON.stringify(contents);
          return {
            text: JSON.stringify({
              summary: 'Mocked safe summary of database connection pool failure'
            })
          };
        }
      }
    };

    // Construct a log that contains the fake email and fake token
    const rawLog = [
      `2026-10-21T10:00:00.000Z ERROR user=${FAKE_EMAIL} token=${FAKE_TOKEN} msg="DB Connection Failed"`,
      `2026-10-21T10:00:01.000Z ERROR user=${FAKE_EMAIL} token=${FAKE_TOKEN} msg="DB Connection Failed"`,
      `2026-10-21T10:00:02.000Z ERROR user=${FAKE_EMAIL} token=${FAKE_TOKEN} msg="DB Connection Failed"`
    ].join('\n');

    // Run processLog with the mockGeminiClient
    const evidence = await processLog({
      content: rawLog,
      id: 'EV-REDACT-TEST',
      geminiClient: mockGeminiClient
    });

    assert.equal(evidence.status, 'ok');
    assert.ok(capturedPrompt.length > 0, 'Gemini must have been called with a prompt');

    // VERIFY: Fake email and fake token never reached Gemini
    assert.equal(
      capturedPrompt.includes(FAKE_EMAIL),
      false,
      `LEAK DETECTED: The fake email "${FAKE_EMAIL}" reached the Gemini prompt!`
    );

    assert.equal(
      capturedPrompt.includes(FAKE_TOKEN),
      false,
      `LEAK DETECTED: The fake token "${FAKE_TOKEN}" reached the Gemini prompt!`
    );

    // Verify they were redacted
    assert.ok(
      capturedPrompt.includes('[REDACTED_EMAIL]'),
      'Prompt must contain [REDACTED_EMAIL]'
    );
    assert.ok(
      capturedPrompt.includes('[REDACTED_TOKEN]'),
      'Prompt must contain [REDACTED_TOKEN]'
    );
  });
});
