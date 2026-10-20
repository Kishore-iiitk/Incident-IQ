import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText, deriveErrorClass, computeFingerprint } from '../utils/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fingerprint Unit Tests', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'phase3');

  const dbReporter = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_reporter.json'), 'utf8'));
  const dbPoller = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_poller.json'), 'utf8'));
  const dbLogWatcher = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'db_fault_log_watcher.json'), 'utf8'));
  const uploadReporter = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'upload_fault_reporter.json'), 'utf8'));
  const slowLoginPoller = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'slow_login_poller.json'), 'utf8'));

  test('normalizer strips timestamps, ObjectIDs, UUIDs, hostnames, numbers, and durations', () => {
    const raw = '2026-10-20T10:42:11.123Z ERROR POST /upload/507f1f77bcf86cd799439011 500 12ms msg="Error on 127.0.0.1:4100 id c9a646d3-9c61-4cd9-bc15-4702978d356e with 42 items"';
    const normalized = normalizeText(raw);

    assert.ok(!normalized.includes('2026-10-20'));
    assert.ok(!normalized.includes('507f1f77bcf86cd799439011'));
    assert.ok(!normalized.includes('c9a646d3-9c61-4cd9-bc15-4702978d356e'));
    assert.ok(!normalized.includes('127.0.0.1'));
    assert.ok(!normalized.includes('12ms'));
    assert.ok(normalized.includes('<TIMESTAMP>'));
    assert.ok(normalized.includes('<OBJECTID>'));
    assert.ok(normalized.includes('<UUID>'));
    assert.ok(normalized.includes('<HOST>'));
  });

  test('deriveErrorClass maps all DB fault variants to db_connection', () => {
    assert.equal(deriveErrorClass(dbReporter), 'db_connection');
    assert.equal(deriveErrorClass(dbPoller), 'db_connection');
    assert.equal(deriveErrorClass(dbLogWatcher), 'db_connection');
  });

  test('deriveErrorClass correctly identifies upload_error and slow_response', () => {
    assert.equal(deriveErrorClass(uploadReporter), 'upload_error');
    assert.equal(deriveErrorClass(slowLoginPoller), 'slow_response');
  });

  test('real DB fault samples from reporter, poller, and log watcher produce the EXACT same fingerprint', () => {
    const fpReporter = computeFingerprint(dbReporter);
    const fpPoller = computeFingerprint(dbPoller);
    const fpLogWatcher = computeFingerprint(dbLogWatcher);

    assert.ok(fpReporter, 'Fingerprint must be non-empty');
    assert.equal(fpReporter, fpPoller, 'Reporter and Poller must produce identical fingerprint for DB fault');
    assert.equal(fpPoller, fpLogWatcher, 'Poller and Log Watcher must produce identical fingerprint for DB fault');
  });

  test('upload-fault and slow-login samples each produce different fingerprints', () => {
    const fpDb = computeFingerprint(dbReporter);
    const fpUpload = computeFingerprint(uploadReporter);
    const fpSlowLogin = computeFingerprint(slowLoginPoller);

    assert.notEqual(fpUpload, fpDb, 'Upload fault must have different fingerprint from DB fault');
    assert.notEqual(fpSlowLogin, fpDb, 'Slow login must have different fingerprint from DB fault');
    assert.notEqual(fpUpload, fpSlowLogin, 'Upload fault must have different fingerprint from slow login');
  });
});
