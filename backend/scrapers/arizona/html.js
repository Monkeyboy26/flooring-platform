import { deslugify } from '../base.js';

/**
 * Decode HTML entities (named and numeric).
 */
export function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Clean attribute value slug (e.g., "matte-finish" → "Matte Finish").
 * Uses deslugify for proper fraction handling.
 */
export function cleanAttrValue(slug) {
  return deslugify(slug);
}

/**
 * Strip HTML tags from a string.
 */
export function stripTags(str) {
  return htmlDecode(str.replace(/<[^>]+>/g, ''));
}
