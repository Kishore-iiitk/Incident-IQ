import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  processText,
  stripEmailNoise,
  extractProductArea,
  assessImpact,
  assessSentiment
} from '../processors/text.js';

describe('Text / Email Processor Unit Tests', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-text-test-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('stripEmailNoise removes greetings, signatures and quoted replies', () => {
    const rawEmail = `Hi Support Team,

Students cannot submit assignment 3 because the course portal returns HTTP 500.
We need this resolved ASAP.

Thanks and regards,
Dr. Robert Smith
Sent from my iPhone

> On Monday, Oct 20, 2026 at 9:00 AM, user wrote:
> Previous message here`;

    const cleaned = stripEmailNoise(rawEmail);
    assert.ok(!cleaned.includes('Hi Support Team,'));
    assert.ok(!cleaned.includes('Dr. Robert Smith'));
    assert.ok(!cleaned.includes('Sent from my iPhone'));
    assert.ok(!cleaned.includes('Previous message here'));
    assert.ok(cleaned.includes('Students cannot submit assignment 3'));
    assert.ok(cleaned.includes('HTTP 500'));
  });

  test('extractProductArea detects relevant technical domains', () => {
    const authText = 'User cannot login or authenticate via SSO';
    const courseText = 'Assignment submission and syllabus grade upload failed';
    const dbText = 'Database query timeout connection pool exhausted';

    assert.ok(extractProductArea(authText).includes('Authentication'));
    assert.ok(extractProductArea(courseText).includes('Course Management'));
    assert.ok(extractProductArea(dbText).includes('Database'));
  });

  test('assessImpact identifies severity indicators', () => {
    const high = assessImpact('CRITICAL: Complete outage blocking all students from login');
    const low = assessImpact('Minor display alignment typo on login button');

    assert.ok(high.includes('Widespread') || high.includes('Blocking'));
    assert.equal(low, 'Impact not clearly stated');
  });

  test('assessSentiment detects urgency and frustration', () => {
    const frustrated = assessSentiment('Unacceptable system crash during exam! Horrible emergency!');
    const neutral = assessSentiment('System logs indicate a service restart occurred.');

    assert.ok(frustrated === 'negative' || frustrated === 'very_negative');
    assert.equal(neutral, 'neutral');
  });

  test('processText successfully parses and redacts email content', async () => {
    const email = `Dear Incident Team,

Professor Jane Doe (contact: jane.doe@university.edu or +1-555-432-8765) reports
that course enrollment is throwing error 500 and the database seems unreachable.

Best regards,
University Helpdesk`;

    const evidence = await processText({ content: email, id: 'EV-04' });

    assert.equal(evidence.id, 'EV-04');
    assert.equal(evidence.status, 'ok');
    assert.equal(evidence.source, 'email');
    assert.equal(evidence.type, 'text');
    assert.ok(evidence.entities.includes('Course Management') || evidence.entities.includes('Database'));
    assert.ok(evidence.errors.length > 0);
    // Ensure PII was redacted
    assert.ok(!evidence.strippedContent.includes('jane.doe@university.edu'));
    assert.ok(!evidence.strippedContent.includes('+1-555-432-8765'));
  });

  test('processText reads from email file correctly', async () => {
    const filePath = path.join(tempDir, 'complaint.txt');
    fs.writeFileSync(filePath, 'Login page is returning 503 service unavailable.', 'utf8');

    const evidence = await processText({ filePath, id: 'EV-05' });
    assert.equal(evidence.id, 'EV-05');
    assert.equal(evidence.status, 'ok');
    assert.ok(evidence.entities.includes('Authentication'));
  });

  test('processText returns status "skipped" when no input is provided', async () => {
    const evidence = await processText({ id: 'EV-06' });
    assert.equal(evidence.status, 'skipped');
    assert.ok(evidence.reason);
  });

  test('processText returns status "skipped" when file does not exist', async () => {
    const evidence = await processText({ filePath: '/nonexistent/email.txt', id: 'EV-07' });
    assert.equal(evidence.status, 'skipped');
    assert.ok(evidence.reason.includes('File not found'));
  });

  test('processText returns status "failed" when content is empty string', async () => {
    const evidence = await processText({ content: '', id: 'EV-08' });
    assert.equal(evidence.status, 'failed');
    assert.ok(evidence.reason);
  });

  test('processText returns status "failed" when file is empty (0 bytes)', async () => {
    const emptyFile = path.join(tempDir, 'empty.txt');
    fs.writeFileSync(emptyFile, '', 'utf8');

    const evidence = await processText({ filePath: emptyFile, id: 'EV-09' });
    assert.equal(evidence.status, 'failed');
    assert.ok(evidence.reason.includes('empty'));
  });

  test('processText handles email with only greeting/signature gracefully', async () => {
    const noiseOnly = `Hi Support,

Thanks,
John`;

    const evidence = await processText({ content: noiseOnly, id: 'EV-10' });
    assert.equal(evidence.status, 'ok');
    assert.ok(evidence.summary.includes('noise'));
  });
});
