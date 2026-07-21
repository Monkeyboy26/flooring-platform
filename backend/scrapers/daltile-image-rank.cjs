/**
 * daltile-image-rank.cjs
 *
 * Shared, dependency-free logic for choosing the correct PRIMARY image for a
 * Daltile SKU. Used by:
 *   - scripts/daltile-reconcile-images.cjs  (one-time / repeatable DB cleanup)
 *   - scrapers/daltile-unified.js           (import-time safety net)
 *
 * The Daltile product map (built from Coveo) associates each coveoSku with an
 * authoritative `productImageUrl`. That URL is the source of truth for the
 * SKU's look. Our stored image can drift from it for two reasons the storefront
 * exposes as "rough" matching:
 *
 *   1. Wrong PATTERN / kind — a mosaic (or trim silhouette) render landed on a
 *      plain field tile (or vice-versa), usually from an older color-only
 *      fallback ladder. These are genuinely wrong and always corrected.
 *   2. Size / aspect DRIFT — right color, right look, but a different tile size
 *      (a 3x6 render shown for a 2x12 plank). We only correct this when the map
 *      offers a size-accurate *real render* (never a downgrade to a flat swatch),
 *      so richer imagery is never traded away for pure size accuracy.
 *
 * CommonJS so the `.cjs` script can `require()` it and the ESM scraper can
 * `import` its default export.
 */

'use strict';

// ── URL classification ──────────────────────────────────────────────────────

function isPlaceholderUrl(url) {
  if (!url) return true;
  const l = url.toLowerCase();
  return l.includes('placeholder') || l.includes('coming-soon') ||
    l.includes('no-series') || l.includes('no.series');
}

function isSwatchUrl(url) {
  return !!url && url.toLowerCase().includes('swatch');
}

function isScene7Url(url) {
  return !!url && url.includes('scene7');
}

function isDamTifUrl(url) {
  return !!url && url.includes('digitalassets.daltile.com');
}

// Mosaic / patterned renders — the piece layout defines the look (herringbone,
// hex, harlequin, cube, etc.). A field tile must never carry one of these.
function isMosaicImage(url) {
  if (!url) return false;
  const u = url.toUpperCase();
  return u.includes('_MSC_') || u.includes('_MSC.') ||
    u.includes('HERRINGBONE') || u.includes('CHEVRON') ||
    u.includes('BRICKJOINT') || u.includes('BRKJNT') ||
    u.includes('HEXMSC') || u.includes('CIRCLEMSC') ||
    u.includes('ARCHES_MSC') || u.includes('FEATHER_MSC') ||
    u.includes('WAVE_MSC') || u.includes('QUILTPATTERN') ||
    u.includes('KALEIDOSCOPE') || u.includes('HARLEQUIN') ||
    u.includes('CUBE_MSC');
}

// Generic trim silhouettes (bullnose, cove base, stair nose, reducers, …) that
// are profile shots rather than color-specific product photos.
const TRIM_IMAGE_TOKENS = [
  '_PROSERIES', 'VQRND', 'VSTRD', 'VSCAP', 'RNDSTRD', 'EXTSN', 'VSLCAP',
  'RDSN', 'RDRTR', 'ENDCAP', 'TREAD', 'REDUCER', 'TMOLD', 'VNOSE',
  'SLIMT', 'COVEBASE', 'STAIRCAP', 'STAIRNOSE', 'BULLNOSE',
];
function isTrimImage(url) {
  if (!url) return false;
  const u = url.toUpperCase();
  return TRIM_IMAGE_TOKENS.some((t) => u.includes(t));
}

// The NxN size token baked into a Daltile scene7/DAM filename, e.g.
// "DAL_CG40_12x24_Legacy_PL_Grid" → "12x24".
function imageSizeToken(url) {
  if (!url) return null;
  const m = url.toLowerCase().match(/_(\d+x\d+)_/);
  return m ? m[1] : null;
}

// ── SKU classification ──────────────────────────────────────────────────────

// Vinyl / pro-series trim codes that appear in the vendor_sku itself.
const TRIM_SKU_TOKENS = [
  'VQRND', 'VSCAP', 'VSLCAP', 'EXTSN', 'VSTRD', 'RNDSTRD', 'VNOSE',
  'RDSN', 'RDRTR', 'ENDCAP', 'TREAD', 'REDUCER', 'TMOLD', 'SLIMT',
];
function skuIsTrim(vendorSku, productType) {
  if (productType && productType.toUpperCase().includes('TRIM')) return true;
  if (!vendorSku) return false;
  const V = vendorSku.toUpperCase();
  if (TRIM_SKU_TOKENS.some((t) => V.includes(t))) return true;
  // Shape code follows the 4-char color prefix: SN=bullnose corner, SC*=cove
  // base, S<digit>=bullnose, A/C/CB=cove base, Q=quarter round.
  const tok = vendorSku.slice(4);
  return /^(SN|SCL|SCR|SC|S\d|AC?\d|C\d|CB\d|Q)/i.test(tok);
}

/**
 * Normalize a raw map URL the same way the importer stores it: upgrade the tiny
 * DAM TIF renditions to the full-quality 1280px JPEG.
 */
function normalizeMapUrl(url) {
  if (!url) return url;
  if (url.includes('digitalassets.daltile.com') && url.includes('/jcr:content/renditions/')) {
    return url.replace(/\/jcr:content\/renditions\/[^/]+$/, '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg');
  }
  return url;
}

/**
 * Decide whether a SKU's currently-stored primary image should be replaced by
 * the map's authoritative image, and why.
 *
 * @param {object} p
 * @param {string} p.vendorSku      SKU vendor code (== coveoSku for tiles)
 * @param {string} [p.productType]  Coveo productType (e.g. "Floor Tile Trim")
 * @param {string} p.currentUrl     image currently stored on the SKU
 * @param {string} p.mapImageUrl    raw productImageUrl from the product map
 * @returns {{replace: boolean, newUrl: (string|null), reason: string}}
 */
function planPrimaryImageFix({ vendorSku, productType, currentUrl, mapImageUrl }) {
  const keep = (reason) => ({ replace: false, newUrl: null, reason });

  const M = normalizeMapUrl(mapImageUrl);
  const D = currentUrl;

  if (!M || isPlaceholderUrl(M)) return keep('map-unusable');
  if (!D) return { replace: true, newUrl: M, reason: 'missing-image' };
  if (M === D) return keep('already-correct');

  const trimSku = skuIsTrim(vendorSku, productType);
  const Dtrim = isTrimImage(D);
  const Mtrim = isTrimImage(M);

  let reason = null;
  if (isPlaceholderUrl(D)) {
    reason = 'placeholder-fix';
  } else if (trimSku) {
    // A trim SKU currently showing a colored field-tile render of its own color
    // is fine (richness-first) — a generic gray silhouette communicates less, so
    // we do NOT trade a real render for the map's silhouette here. Leave as-is.
  } else {
    // Field-tile SKU.
    if (Dtrim && !Mtrim) {
      reason = 'trim-correctness';               // field tile wrongly showing a trim profile
    } else if (isMosaicImage(D) !== isMosaicImage(M)) {
      reason = 'pattern-correctness';            // mosaic/plain look disagrees with the map
    } else if (isSwatchUrl(D) && !isSwatchUrl(M)) {
      reason = 'swatch-upgrade';                 // flat chip → real render
    } else {
      // Same look — only correct size/aspect drift when the map has a
      // size-accurate REAL render (never downgrade a render to a swatch).
      const ds = imageSizeToken(D);
      const ms = imageSizeToken(M);
      if (ds && ms && ds !== ms && !isSwatchUrl(M) && isScene7Url(M)) {
        reason = 'size-correct-render';
      }
    }
  }

  if (!reason) return keep('same-look');

  // Never trade a full-res scene7 render for a low-res DAM TIF, unless the
  // current image is a genuine correctness error (wrong pattern/trim/placeholder).
  const correctnessFix = reason === 'placeholder-fix' || reason === 'trim-correctness';
  if (!correctnessFix && isScene7Url(D) && isDamTifUrl(M)) {
    return keep('scene7-kept-over-damtif');
  }

  return { replace: true, newUrl: M, reason };
}

/**
 * Import-time safety net: choose the primary image URL to store for a SKU from
 * the map entry's candidates. Prefers the authoritative product render, falls
 * back to the swatch when the render is missing/placeholder, and returns null
 * when nothing usable exists. (It does NOT invent pattern data — the map's
 * per-SKU render is already look-correct — it only avoids storing placeholders.)
 *
 * @param {object} p
 * @param {string} [p.productImageUrl]
 * @param {string} [p.swatchUrl]
 * @returns {string|null}
 */
function pickPrimaryImage({ productImageUrl, swatchUrl }) {
  const primary = normalizeMapUrl(productImageUrl);
  if (primary && !isPlaceholderUrl(primary)) return primary;
  const sw = normalizeMapUrl(swatchUrl);
  if (sw && !isPlaceholderUrl(sw)) return sw;
  return null;
}

module.exports = {
  planPrimaryImageFix,
  pickPrimaryImage,
  normalizeMapUrl,
  // exported for tests / diagnostics
  isPlaceholderUrl,
  isSwatchUrl,
  isScene7Url,
  isDamTifUrl,
  isMosaicImage,
  isTrimImage,
  imageSizeToken,
  skuIsTrim,
};
