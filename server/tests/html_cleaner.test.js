import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtmlText, decodeHtmlEntities, stripHtmlTags, collapseWhitespace, truncateAtWordBoundary } from '../utils/htmlCleaner.js';

describe('HTML Cleaner Tests (Problem 4)', () => {
  const realCapturedProbeBody = `
    <!DOCTYPE html>
    <html>
    <head><title>500 - Server Error</title></head>
    <body style="font-family:sans-serif; background:#0f172a; color:#f87171; padding:2rem;">
      <h2>500 Internal Server Error</h2>
      <p><strong>Error:</strong> MongoNotConnectedError: Client must be connected before running operations</p>
      <pre style="background:#1e293b; padding:1rem; border-radius:4px; color:#cbd5e1; overflow-x:auto;">MongoNotConnectedError: Client must be connected before running operations
    at MongoClient.connect (C:\\Users\\demo\\node_modules\\mongodb\\lib\\mongo_client.js:123:23)</pre>
      <p><a href="/" style="color:#818cf8;">Back to Home</a></p>
    </body>
    </html>
  `;

  test('cleans real captured probe body, removes <strong> tags, and preserves clean error text', () => {
    // Probe body extract matching <p>(.*?)</p>
    const match = realCapturedProbeBody.match(/<p>(.*?)<\/p>/i);
    assert.ok(match, 'Probe body should contain a <p> tag');

    const rawMatch = match[1]; // contains "<strong>Error:</strong> MongoNotConnectedError: ..."
    assert.ok(rawMatch.includes('<strong>'), 'Raw match contains strong tags');

    const cleaned = cleanHtmlText(rawMatch, 200);

    assert.equal(cleaned.includes('<'), false, 'Cleaned text must not contain HTML tags');
    assert.equal(cleaned.includes('>'), false, 'Cleaned text must not contain HTML tags');
    assert.ok(cleaned.includes('Error: MongoNotConnectedError: Client must be connected before running operations'));
  });

  test('decodes HTML entities correctly', () => {
    const raw = '&lt;strong&gt;Error:&amp;nbsp;&quot;Upload failed&#39;s worker&quot;&lt;/strong&gt;';
    const cleaned = cleanHtmlText(raw, 200);

    assert.equal(cleaned, 'Error: "Upload failed\'s worker"');
  });

  test('truncates at word boundary within 200 characters', () => {
    const longText = 'The database cluster connection pool has exhausted all available sockets because of a sudden spike in concurrent student login attempts and network degradation on the replica set primary node resulting in timeouts.';
    assert.ok(longText.length > 200, 'Input text must be longer than 200 characters');

    const truncated = truncateAtWordBoundary(longText, 200);

    assert.ok(truncated.length <= 200, `Truncated text must be <= 200 chars (was ${truncated.length})`);
    assert.ok(!truncated.endsWith(' '), 'Truncated text should not have trailing spaces');
    // Verify it did not cut a word in the middle
    assert.ok(
      longText.startsWith(truncated),
      'Truncated text must be an exact prefix'
    );
    // The next character in longText after truncated must be a space
    assert.equal(longText[truncated.length], ' ', 'Must cut exactly at a word boundary');
  });

  test('title formatting matches new format: [POLLER] demo-lms /login: HTTP 500 - <clean message>', () => {
    const service = 'demo-lms';
    const endpoint = '/login';
    const status = 500;
    const rawMessage = 'Health probe failed with HTTP 500: <strong>Error:</strong> MongoNotConnectedError: Client must be connected before running operations';

    const cleanedMsg = cleanHtmlText(rawMessage, 200);
    const probeMatch = cleanedMsg.match(/^Health probe failed with HTTP \d+:\s*(.+)$/i);
    const detail = probeMatch ? probeMatch[1] : cleanedMsg;

    const title = `[POLLER] ${service} ${endpoint}: HTTP ${status} - ${detail}`;
    const cleanTitle = cleanHtmlText(title, 200);

    assert.equal(
      cleanTitle,
      '[POLLER] demo-lms /login: HTTP 500 - Error: MongoNotConnectedError: Client must be connected before running operations'
    );
    assert.ok(cleanTitle.length <= 200);
    assert.ok(!cleanTitle.includes('<'));
    assert.ok(!cleanTitle.includes('>'));
  });
});
