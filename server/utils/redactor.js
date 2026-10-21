/**
 * Redactor utility for PII and sensitive tokens.
 * Complies with the safety rule: Redact emails, names, and tokens before any text leaves for an external API.
 */

// Email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone numbers (international and US formats)
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

// Tokens / Secrets: Bearer tokens, JWTs, API keys, long hex (32+ chars), long base64 strings
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-_.]+/gi;
const JWT_REGEX = /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;
const API_KEY_REGEX = /(?:api[_-]?key|secret|token|password|auth|access_key)[\s:=]+(['"])?[A-Za-z0-9\-_./+=]{16,}\1?/gi;
const GENERIC_TOKEN_PREFIX_REGEX = /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9\-_]{20,}|xox[baprs]-[a-zA-Z0-9]{10,})\b/g;

// Long hex tokens: 32+ hexadecimal characters
const HEX_TOKEN_REGEX = /\b[a-f0-9]{32,}\b/gi;

// Long Base64 strings: 40+ characters of base64 alphabet, optionally padded with =
const BASE64_TOKEN_REGEX = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

// Name patterns:
// 1. "User: Alice Smith", "Reporter: Bob Jones", "Student Name: Charlie Brown", etc.
const USERNAME_FLAG_REGEX = /(?:user(?:name)?|student(?:name)?|employee|reporter|engineer|author|customer|name)[\s:=]+(['"])?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\1?/gi;

// 2. Greetings like "Dear Alice Smith," or "Hi John Doe,"
const GREETING_NAME_REGEX = /\b(?:dear|hi|hello|hey)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?=[,\n]|$)/gi;

// 3. Signoffs like "Regards, Jane Smith", "Thanks,\nJohn", "Sincerely, Bob", "Best regards,\nCharlie"
const SIGNOFF_NAME_REGEX = /(?:best\s+regards|warm\s+regards|kind\s+regards|regards|sincerely|thanks|thank\s+you|cheers|yours\s+truly)[,:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi;

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

  let text = input;

  // 1. Bearer tokens and known token structures
  text = text.replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]');
  text = text.replace(JWT_REGEX, '[REDACTED_TOKEN]');
  text = text.replace(GENERIC_TOKEN_PREFIX_REGEX, '[REDACTED_TOKEN]');

  // 2. API Key / Secret assignments
  text = text.replace(API_KEY_REGEX, (match) => {
    const parts = match.split(/[\s:=]+/);
    return `${parts[0]}: "[REDACTED_TOKEN]"`;
  });

  // 3. Long hex tokens (32+ chars)
  text = text.replace(HEX_TOKEN_REGEX, (match) => {
    // Only redact 32+ hex chars (don't redact 24-char MongoDB ObjectIDs)
    return match.length >= 32 ? '[REDACTED_TOKEN]' : match;
  });

  // 4. Long base64 tokens
  text = text.replace(BASE64_TOKEN_REGEX, '[REDACTED_TOKEN]');

  // 5. Emails and phones
  text = text.replace(EMAIL_REGEX, '[REDACTED_EMAIL]');
  text = text.replace(PHONE_REGEX, '[REDACTED_PHONE]');

  // 6. Names
  text = text.replace(USERNAME_FLAG_REGEX, (match, quote, name) => {
    return match.replace(name, '[REDACTED_NAME]');
  });
  text = text.replace(GREETING_NAME_REGEX, (match, name) => {
    // Do not redact generic words like 'Team', 'All', 'Support'
    if (/^(?:team|all|everyone|support|there)$/i.test(name.trim())) return match;
    return match.replace(name, '[REDACTED_NAME]');
  });
  text = text.replace(SIGNOFF_NAME_REGEX, (match, name) => {
    if (/^(?:team|all|everyone|support)$/i.test(name.trim())) return match;
    return match.replace(name, '[REDACTED_NAME]');
  });

  return text;
}
