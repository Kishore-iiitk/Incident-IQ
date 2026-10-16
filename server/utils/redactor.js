/**
 * Redactor utility for PII and sensitive tokens.
 * Complies with the safety rule: Redact emails, names, and tokens before any text leaves for an external API.
 */

// Email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Tokens / Secrets: Bearer tokens, JWTs, API keys, hex hashes of 32+ chars, passwords
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-_.]+/gi;
const API_KEY_REGEX = /(?:api[_-]?key|secret|token|password|auth)[\s:=]+(['"])?[A-Za-z0-9\-_./+=]{16,}\1?/gi;
const JWT_REGEX = /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;
const HEX_TOKEN_REGEX = /\b[a-f0-9]{32,64}\b/gi;

// Phone numbers (international and US formats)
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

// Specific user name patterns commonly found in crash logs / error headers
const USERNAME_FLAG_REGEX = /(?:user(?:name)?|student(?:name)?|employee|reporter|engineer)[\s:=]+(['"])?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\1?/gi;

export function redactSensitiveData(input) {
  if (typeof input !== 'string') {
    if (input === null || input === undefined) return input;
    if (typeof input === 'object') {
      try {
        const json = JSON.stringify(input);
        return JSON.parse(redactSensitiveData(json));
      } catch {
        return input;
      }
    }
    return String(input);
  }

  return input
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]')
    .replace(JWT_REGEX, '[REDACTED_TOKEN]')
    .replace(API_KEY_REGEX, (match) => {
      const parts = match.split(/[\s:=]+/);
      return `${parts[0]}: "[REDACTED_TOKEN]"`;
    })
    .replace(HEX_TOKEN_REGEX, (match) => {
      // Don't redact standard 24-char mongo IDs or UUIDs with hyphens, but redact long raw hashes
      return match.length >= 32 ? '[REDACTED_TOKEN]' : match;
    })
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]')
    .replace(USERNAME_FLAG_REGEX, (match, quote, name) => {
      return match.replace(name, '[REDACTED_NAME]');
    });
}
