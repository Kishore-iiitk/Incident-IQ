/**
 * HTML cleaning utilities for collectors and signal builders.
 * Strips HTML tags, decodes HTML entities, collapses whitespace,
 * and truncates to a word boundary.
 */

export function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return '';
      }
    });
}

export function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, ' ');
}

export function collapseWhitespace(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim();
}

export function truncateAtWordBoundary(str, maxLen = 200) {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;

  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) {
    return cut.slice(0, lastSpace).trim();
  }
  return cut.trim();
}

export function cleanHtmlText(str, maxLen = 200) {
  if (!str || typeof str !== 'string') return '';
  // First decode entities (e.g. &lt;strong&gt; -> <strong>)
  const decoded = decodeHtmlEntities(str);
  // Then strip HTML tags
  const stripped = stripHtmlTags(decoded);
  // Decode any remaining entities and collapse whitespace
  const fullyDecoded = decodeHtmlEntities(stripped);
  const collapsed = collapseWhitespace(fullyDecoded);
  return truncateAtWordBoundary(collapsed, maxLen);
}
