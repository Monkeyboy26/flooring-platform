import { htmlDecode } from './html.js';

// Max gallery images per SKU (primary + lifestyle + 6 alternate)
export const MAX_GALLERY_IMAGES = 8;

/**
 * Re-parameterize a Widen CDN URL to fit within 765px wide without cropping.
 * Strips height, crop, and keep params so the CDN returns the natural aspect ratio.
 * Non-Widen URLs are returned unchanged.
 */
export function reParamWidenUrl(url) {
  if (!url.includes('.widen.net')) return url;
  let u = url;
  // Set width to 765, remove height/crop/keep so image keeps natural aspect ratio
  if (/[?&]w=\d+/.test(u)) {
    u = u.replace(/([?&])w=\d+/, '$1w=765');
  } else {
    u += (u.includes('?') ? '&' : '?') + 'w=765';
  }
  u = u.replace(/[?&]h=\d+/g, '');
  u = u.replace(/[?&]crop=yes/g, '');
  u = u.replace(/[?&]keep=[a-z]+/gi, '');
  u = u.replace(/[?&]position=[a-z]+/gi, '');
  // Ensure quality param
  if (!/[?&]quality=/.test(u)) u += '&quality=80';
  // Strip x.app portal tracking param — causes intermittent 404/placeholder from CDN
  u = u.replace(/[?&]x\.app=[^&]*/gi, '');
  // Clean up dangling ampersands
  u = u.replace(/[&]+/g, '&').replace(/\?&/, '?').replace(/&$/, '');
  return u;
}

/**
 * Normalize Widen CDN URLs: re-parameterize to 765px wide without cropping.
 * Still rejects known placeholder filenames.
 */
export function normalizeWidenUrls(urls) {
  return urls
    .filter(url => !/coming-soon/i.test(url))
    .map(url => reParamWidenUrl(url));
}

/**
 * Filter out Widen CDN placeholder images ("Preview Not Available").
 * The CDN returns HTTP 404 with `x-widen-error: resource unavailable` and an
 * 8,016-byte PNG placeholder for missing/removed assets.  Also rejects images
 * ≤ 4,000 bytes (corrupted or blank thumbnails).
 */
export const WIDEN_PLACEHOLDER_BYTES = 8016; // "Preview Not Available" PNG placeholder size

export async function filterWidenPlaceholders(urls) {
  if (!urls || urls.length === 0) return [];
  const checks = await Promise.allSettled(urls.map(async (url) => {
    if (!url.includes('.widen.net')) return { url, ok: true };
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { url, ok: false };
      const len = parseInt(res.headers.get('content-length') || '0', 10);
      // Reject small/corrupt images AND the known 8,016-byte placeholder
      if (len > 0 && len <= WIDEN_PLACEHOLDER_BYTES) return { url, ok: false };
      return { url, ok: true };
    } catch { return { url, ok: false }; }
  }));
  return checks
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url);
}

/**
 * Detect field-tile dimension patterns in Widen CDN image URLs.
 * Returns true if the filename contains standard tile/slab dimensions
 * (12x12, 18x18, etc.) or detail-shot markers (-DT-) that indicate
 * a non-mosaic product shot — these should NOT be used for mosaic SKUs.
 */
export const FIELD_TILE_IMAGE_RE = /[-_](12x12|18x18|24x24|12x24|16x16|6x24|6x12|4x12|3x6)[-_.]/i;
export const DETAIL_SHOT_RE = /[-_]DT[-_.]/i;
export const MOSAIC_IMAGE_INDICATOR_RE = /mosaic|mesh|hex|herringbone|chevron|basket|penny|fan|flower|brick|bubble|scallop|picket|rhomboid|stanza|pinwheel|octagon|arabesque|lantern/i;
export function isFieldTileUrl(url) {
  const filename = url.split('/').pop().split('?')[0];
  if (DETAIL_SHOT_RE.test(filename)) return true;
  if (FIELD_TILE_IMAGE_RE.test(filename)) {
    // Not a field tile if the filename also contains mosaic indicators
    if (MOSAIC_IMAGE_INDICATOR_RE.test(filename)) return false;
    return true;
  }
  return false;
}

/**
 * Parse gallery images from aztiles_product_gallery JS variable.
 * Format can be:
 *   - Array of arrays: [[{thumb, medium, zoom}, ...]]  (simple products)
 *   - Object with numeric keys: {"0": [{...},...], "8683": [{...},...]}  (variable products)
 *     Key "0" = shared/product-level images
 *     Other keys = WooCommerce variation_id → per-variant gallery images
 * Items have thumb/medium/zoom keys — prefer zoom (highest res), fallback to medium.
 * URLs contain &amp; HTML entities that need decoding.
 *
 * Returns { flat: [url, ...], shared: [url, ...], byVariationId: { 8683: [url, ...], ... } }
 * - flat: all images combined (used for simple products)
 * - shared: key "0" images (product-level, used when no per-variant images exist)
 * - byVariationId: keyed by WooCommerce variation_id (NOT sequential index)
 */
export function parseGallery(html) {
  const match = html.match(/aztiles_product_gallery\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/);
  if (!match) return { flat: [], shared: [], byVariationId: {} };

  function extractUrls(items) {
    const urls = items
      .map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item) {
          // Prefer zoom (highest res square crop), then medium, then full
          // Skip full if it's a .tif (400KB+ uncompressed)
          const full = item.full && !/\.tif(\?|$)/i.test(item.full) ? item.full : null;
          return item.zoom || item.medium || full || item.thumb || item.url || item.src || null;
        }
        return null;
      })
      .filter(Boolean)
      .map(u => reParamWidenUrl(u.replace(/&amp;/g, '&')));

    // Deduplicate by base filename
    const seen = new Set();
    const unique = [];
    for (const url of urls) {
      const base = url.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      unique.push(url);
    }
    return unique.slice(0, MAX_GALLERY_IMAGES);
  }

  try {
    const raw = match[1].replace(/&amp;/g, '&');
    const gallery = JSON.parse(raw);

    const byVariationId = {};
    let shared = [];
    let allItems = [];

    if (Array.isArray(gallery)) {
      // [[{thumb,medium,zoom},...]] or [{thumb,medium,zoom},...]
      for (const entry of gallery) {
        if (Array.isArray(entry)) allItems.push(...entry);
        else allItems.push(entry);
      }
    } else if (typeof gallery === 'object') {
      // {"0": [{...},...], "8683": [{...},...]} — key 0 is shared, others are variation_ids
      for (const key of Object.keys(gallery)) {
        const arr = gallery[key];
        if (!Array.isArray(arr)) continue;
        allItems.push(...arr);
        if (key === '0') {
          shared = extractUrls(arr);
        } else {
          byVariationId[Number(key)] = extractUrls(arr);
        }
      }
    }

    return { flat: extractUrls(allItems), shared, byVariationId };
  } catch {
    return { flat: [], shared: [], byVariationId: {} };
  }
}

/**
 * Parse color swatch images from the detail page.
 * These are per-color product photos (e.g., "Aequa-Castor-12x48-variation.webp")
 * displayed as clickable color option buttons.
 *
 * Structure: <span class="...color-variation..." data-parent-id="pa_color" data-value="castor" ...>
 *              <i><img src="..." alt="Castor"></i>
 *            </span>
 *
 * Returns Map<colorSlug, imageUrl>
 */
export function parseSwatchImages(html) {
  const swatches = new Map();
  // Match color-variation spans with data-parent-id="pa_color" and data-value, then find inner img src
  const regex = /data-parent-id="pa_color"[^>]*data-value="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  // Also try reverse attribute order: data-value before data-parent-id
  const regex2 = /data-value="([^"]+)"[^>]*data-parent-id="pa_color"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  while ((match = regex2.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !swatches.has(colorSlug) && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  return swatches;
}
