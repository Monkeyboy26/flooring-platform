/**
 * daltile-image-match.cjs
 *
 * Shared image-matching logic for Daltile Coveo images.
 *
 * Daltile color codes are the first 4 chars of every vendor SKU (e.g.
 * K775RCT412MT → K775) and Scene7 filenames embed the same code as an
 * underscore-delimited token (DAL_K775_4x12_MT_Biscuit_Silo_01). Coveo
 * multi-SKU entries share one productimageurl across SKUs of different
 * colors, so an image must be validated per-SKU, not per-entry.
 *
 * Used by daltile-unified.js (at import time) and
 * scripts/fix-daltile-image-mismatches.cjs (to repair existing rows).
 */

const COLOR_CODE_RE = /^[A-Z0-9]{4}$/;

function skuColorCode(vendorSku) {
  const code = (vendorSku || '').toUpperCase().slice(0, 4);
  return COLOR_CODE_RE.test(code) ? code : null;
}

function fileOf(url) {
  return (url || '').split('/').pop();
}

function urlTokens(url) {
  if (!url) return [];
  return fileOf(url).split(/[_\-.]/).map(t => t.toUpperCase());
}

function isSwatchUrl(url) {
  return /swatch/i.test(fileOf(url));
}

// Trim-profile silhouettes (coping, step nose, bullnose, …) are shape-informative
// even when not color-specific — never replace them with field-tile shots.
function isTrimSilhouetteUrl(url) {
  return /trim|coping|stepnose|cove|bullnose|quarter|liner|rail|endcap|tread|reducer|profile|vcap|mudcap/i
    .test(fileOf(url));
}

function normSize(size) {
  return (size || '').toUpperCase().replace(/\s/g, '');
}

// Size token as it appears in Scene7 filenames ("4X16" → "4x16")
function sizeToken(size) {
  const m = normSize(size).match(/^(\d+)X(\d+)$/);
  return m ? `${m[1]}x${m[2]}` : null;
}

/**
 * Build the image index from a product map's series object
 * (productMap.series from daltile-product-map.json).
 *
 * Returns { byCode, knownCodes }:
 *   byCode:     Map<colorCode, [{url, size, swatch, file}]> — only images whose
 *               filename embeds the color code of the SKU they came from
 *               (self-consistent, safe to reuse for that color)
 *   knownCodes: Set<colorCode> of every 4-char SKU prefix, used to tell
 *               foreign color codes apart from item/shape codes in filenames
 */
function buildImageIndex(seriesMap, excludeUrls) {
  const byCode = new Map();
  const knownCodes = new Set();
  const excluded = excludeUrls instanceof Set ? excludeUrls : new Set(excludeUrls || []);

  for (const series of Object.values(seriesMap)) {
    const groups = [...Object.values(series.products || {}), ...Object.values(series.accessories || {})];
    for (const group of groups) {
      for (const sku of group.skus || []) {
        const code = skuColorCode(sku.coveoSku);
        if (!code) continue;
        knownCodes.add(code);

        const url = sku.productImageUrl;
        if (url && !excluded.has(url) && urlTokens(url).includes(code)) {
          if (!byCode.has(code)) byCode.set(code, []);
          byCode.get(code).push({
            url,
            size: normSize(sku.size),
            swatch: isSwatchUrl(url),
            file: fileOf(url).toLowerCase(),
          });
        }
      }
    }
  }

  return { byCode, knownCodes };
}

/**
 * Pick the best candidate image for a color code + size.
 * Ranking: non-swatch with matching map size AND filename size token,
 * then non-swatch matching map size, then non-swatch matching filename size,
 * then (if allowAnySize) any non-swatch, then any candidate.
 */
function pickCandidate(index, code, size, allowAnySize) {
  const cands = index.byCode.get(code) || [];
  if (cands.length === 0) return null;

  const sz = normSize(size);
  const tok = sizeToken(size);
  const shots = cands.filter(c => !c.swatch);

  return shots.find(c => c.size === sz && tok && c.file.includes(tok))
    || shots.find(c => c.size === sz)
    || (tok ? shots.find(c => c.file.includes(tok)) : null)
    || (allowAnySize ? (shots[0] || cands[0]) : null);
}

/**
 * Validate/improve a primary image URL for one SKU.
 *
 * Returns { url, reason } when a better image is available, or null to keep
 * the current one. Reasons: 'wrong-color', 'swatch-upgrade',
 * 'generic-upgrade', 'backfill'.
 */
function resolveImage(index, vendorSku, size, currentUrl) {
  const code = skuColorCode(vendorSku);
  if (!code) return null;

  // No image at all — backfill only with a same-size, color-correct shot
  if (!currentUrl) {
    const cand = pickCandidate(index, code, size, false);
    return cand ? { url: cand.url, reason: 'backfill' } : null;
  }

  const toks = urlTokens(currentUrl);

  if (toks.includes(code)) {
    // Color-correct. Upgrade swatches to a real product shot of the same size.
    if (isSwatchUrl(currentUrl)) {
      const cand = pickCandidate(index, code, size, false);
      if (cand && !cand.swatch && cand.url !== currentUrl) {
        return { url: cand.url, reason: 'swatch-upgrade' };
      }
    }
    return null;
  }

  // Filename embeds a different known color code — wrong-color image from a
  // multi-SKU Coveo entry. Any color-correct image beats it.
  const foreign = toks.some(t => index.knownCodes.has(t) && t !== code);
  if (foreign) {
    const cand = pickCandidate(index, code, size, true);
    return cand ? { url: cand.url, reason: 'wrong-color' } : null;
  }

  // Generic image (bare item code, DAM rendition, …). Upgrade only when a
  // same-size color shot exists, and never displace trim silhouettes.
  if (!isTrimSilhouetteUrl(currentUrl) && !isSwatchUrl(currentUrl)) {
    const cand = pickCandidate(index, code, size, false);
    if (cand && cand.url !== currentUrl) {
      return { url: cand.url, reason: 'generic-upgrade' };
    }
  }

  return null;
}

module.exports = { buildImageIndex, resolveImage, skuColorCode, isSwatchUrl };
