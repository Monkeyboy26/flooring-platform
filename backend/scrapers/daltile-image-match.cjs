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

// Pattern/mosaic renders (cube mosaics, bevels, herringbone sheets, …) look
// nothing like plain field tile — only same-size matches may use them.
function isPatternUrl(url) {
  return /msc|mosaic|cube|herringbone|chevron|harlequin|penny|hex|bevel|deco|arabesque|picket/i
    .test(fileOf(url));
}

// Bath fixture shots (towel bars, soap dishes, corner shelves) share the
// color code with the tile line but must never represent tile SKUs.
function isBathFixtureUrl(url) {
  return /towel|soap|robe|tissue|hook|shelf|ba7\d\d/i.test(fileOf(url));
}

function isBathFixtureSku(vendorSku) {
  return /TWB|SPD|CRC|RBH/i.test(vendorSku || '');
}

// SKUs that ARE a pattern/mosaic format — these legitimately wear pattern renders
function isPatternSku(vendorSku) {
  return /STK|HERR|MS\d|MSMT|MSGL|BRKJ|CHEV|HEXMS|WAVE|ARCH|PNYRD|STJ|MOD|3DC|CHV|BV|OCT|PKT|PICKET|HEX/i
    .test(vendorSku || '');
}

// Derive the tile size from the vendor SKU's shape-code digits
// (RCT416 → 4X16, SQU2424 → 24X24). More reliable than the stored size
// attribute, which can carry Coveo's combined-size resolution mistakes.
function sizeFromVendorSku(vendorSku) {
  const m = (vendorSku || '').toUpperCase().match(/(?:SQU|RCT|PLK|HEX|OCT|BKJ|STJ|HER|DIA)(\d{2,5})/);
  if (!m) return null;
  const d = m[1];
  const t = (w, h) => {
    const wi = parseInt(w), hi = parseInt(h);
    return wi >= 1 && wi <= 48 && hi >= 1 && hi <= 96 ? `${wi}X${hi}` : null;
  };
  if (d.length === 2) return t(d[0], d[1]);
  if (d.length === 3) return t(d[0], d.slice(1)) || t(d.slice(0, 2), d[2]);
  return t(d.slice(0, 2), d.slice(2));
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

        // Index product shots and swatches — many palette collections
        // (Color Wheel, …) only publish a swatch for some colors.
        for (const url of [sku.productImageUrl, sku.swatchUrl]) {
          if (url && !excluded.has(url) && urlTokens(url).includes(code)) {
            if (!byCode.has(code)) byCode.set(code, []);
            byCode.get(code).push({
              url,
              size: normSize(sku.size),
              swatch: isSwatchUrl(url),
              // Shape-bound images may only match same-size, never as fallback
              shapeBound: isPatternUrl(url) || isBathFixtureUrl(url),
              file: fileOf(url).toLowerCase(),
            });
          }
        }
      }
    }
  }

  // Dedup candidates per code (swatchUrl often repeats across a color's SKUs)
  for (const [code, cands] of byCode) {
    const seen = new Set();
    byCode.set(code, cands.filter(c => !seen.has(c.url) && seen.add(c.url)));
  }

  return { byCode, knownCodes };
}

/**
 * Pick the best candidate image for a color code + size.
 * Ranking: non-swatch with matching map size AND filename size token,
 * then non-swatch matching map size, then non-swatch matching filename size.
 * With allowAnySize (non-trim SKUs): any plain non-swatch shot — pattern
 * renders (mosaics, bevels) are size-bound and never used cross-size —
 * then a color-correct swatch.
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
    || (allowAnySize ? (shots.find(c => !c.shapeBound) || cands.find(c => c.swatch)) : null)
    || null;
}

/**
 * Validate/improve a primary image URL for one SKU.
 *
 * opts.isTrim — trim/accessory SKUs only accept same-size candidates, so a
 * shape-informative silhouette is never displaced by a field-tile photo.
 * Non-trim SKUs use the full ladder: same-size shot, any-size plain shot,
 * color-correct swatch — palette collections (Color Wheel, …) rarely have a
 * shot for every size, and a color-correct image beats a perfect-size one.
 *
 * Returns { url, reason } when a better image is available, or null to keep
 * the current one. Reasons: 'wrong-color', 'swatch-upgrade',
 * 'generic-upgrade', 'backfill'.
 */
function resolveImage(index, vendorSku, size, currentUrl, opts = {}) {
  const code = skuColorCode(vendorSku);
  if (!code) return null;

  const anySize = !opts.isTrim;
  // The SKU's shape-code digits beat the stored size attribute, which can
  // carry Coveo's combined-size resolution mistakes (RCT416 recorded as 1X6)
  const skuSize = sizeFromVendorSku(vendorSku) || size;

  // No image at all — backfill with a color-correct image
  if (!currentUrl) {
    const cand = pickCandidate(index, code, skuSize, anySize);
    return cand ? { url: cand.url, reason: 'backfill' } : null;
  }

  const toks = urlTokens(currentUrl);

  if (toks.includes(code)) {
    // Color-correct, but a bath fixture shot must not represent a tile SKU
    if (isBathFixtureUrl(currentUrl) && !isBathFixtureSku(vendorSku)) {
      const cand = pickCandidate(index, code, skuSize, anySize);
      if (cand && !isBathFixtureUrl(cand.url) && cand.url !== currentUrl) {
        return { url: cand.url, reason: 'wrong-item' };
      }
      return null;
    }
    // A pattern render (mosaic sheet, bevel grid) on a plain-format SKU of a
    // different size misrepresents the product — swap for a plain shot
    if (!opts.isTrim && isPatternUrl(currentUrl) && !isPatternSku(vendorSku)) {
      const tok = sizeToken(skuSize);
      if (tok && !fileOf(currentUrl).toLowerCase().includes(tok)) {
        const cand = pickCandidate(index, code, skuSize, true);
        if (cand && !cand.shapeBound && !cand.swatch && cand.url !== currentUrl) {
          return { url: cand.url, reason: 'pattern-mismatch' };
        }
      }
      return null;
    }
    // Upgrade swatches to a real product shot.
    if (isSwatchUrl(currentUrl)) {
      const cand = pickCandidate(index, code, skuSize, anySize);
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
    const cand = pickCandidate(index, code, skuSize, true);
    return cand ? { url: cand.url, reason: 'wrong-color' } : null;
  }

  // Generic image (bare item code, DAM rendition, …). Never displace trim
  // silhouettes; for other generics a color-correct image is an upgrade.
  if (!isTrimSilhouetteUrl(currentUrl) && !isSwatchUrl(currentUrl)) {
    const cand = pickCandidate(index, code, skuSize, anySize);
    if (cand && cand.url !== currentUrl) {
      return { url: cand.url, reason: 'generic-upgrade' };
    }
  }

  return null;
}

module.exports = { buildImageIndex, resolveImage, skuColorCode, isSwatchUrl };
