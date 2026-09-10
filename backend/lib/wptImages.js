/**
 * WPT image classification.
 *
 * Western Pacific Tile serves images from Ecwid/CloudFront with opaque numeric
 * filenames ("5687776782.jpg"), so the keyword-based isLifestyleUrl() in base.js
 * can't tell a clean tile SWATCH from a room SCENE. The reliable signal is the
 * image's ASPECT RATIO versus the tile's own aspect ratio:
 *
 *   - A swatch is a flat render of the tile → its aspect ratio matches the tile
 *     ("24x48" swatches are 2400x1200 = 2.00; a "9x48" plank swatch is 1920x512
 *     = 3.75, near the 5.33 tile ratio and nowhere near a photo ratio).
 *   - A room scene is a photograph → a "photographic" ratio (~1.33 / 1.5 / 1.78)
 *     that, for most tiles, is far from the tile ratio.
 *
 * We score every image by how close its aspect ratio is to the tile's, pick the
 * best swatch as primary, and demote scenes to 'lifestyle'. When a product has
 * only scenes (some WPT products ship no swatch), the least-bad image still wins
 * primary — we can't invent a swatch.
 *
 * This module is pure (no IO): callers measure width/height (via sharp) and pass
 * the numbers in, which keeps it usable from both the scraper and a data-fix
 * script and makes it unit-testable.
 */

/** Tile aspect ratio (>= 1) from a size string like "24x48" / "11.25x11.18". null if unknown. */
export function tileAspect(size) {
  const m = String(size || '').match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!a || !b) return null;
  return Math.max(a, b) / Math.min(a, b);
}

/** Image aspect ratio (>= 1) from width/height. null if either is missing. */
export function imgAspect(w, h) {
  if (!w || !h) return null;
  return Math.max(w, h) / Math.min(w, h);
}

/**
 * Classify + rank measured images for a tile of the given size.
 *
 * @param {Array<{url:string,width?:number,height?:number,[k:string]:any}>} images
 * @param {string|null} size  tile size string ("24x48")
 * @param {object} [opts]
 * @param {number} [opts.tol=0.12]  base absolute tolerance on |imgAR - tileAR|
 * @returns {Array} same objects, each augmented with {ar, dist, kind:'swatch'|'scene'},
 *                  sorted best-swatch-first (primary = index 0).
 */
export function classifyImages(images, size, opts = {}) {
  const { tol = 0.12 } = opts;
  const R = tileAspect(size);

  const scored = (images || []).map((im) => {
    const ar = imgAspect(im.width, im.height);
    let kind = 'scene';
    let dist = Infinity;
    if (ar != null && R != null) {
      dist = Math.abs(ar - R);
      // Wider tiles need a looser absolute tolerance (a 5.33 plank swatch renders
      // at ~3.75); scale tolerance with the tile ratio. A swatch either matches
      // the tile ratio, is extremely wide (no room photo exceeds ~2.2:1), or is a
      // near-square shot of a square tile. Only a clearly WIDE photographic image
      // (ar >= 1.6) that does NOT match the tile is treated as a room scene —
      // small-format mosaics are photographed at ~1.0-1.5 and are swatches.
      const relTol = Math.max(tol, R * 0.08);
      const matchesTile = dist <= relTol || ar >= 2.2 || (R <= 1.15 && ar <= 1.10);
      kind = matchesTile ? 'swatch' : ar >= 1.6 ? 'scene' : 'swatch';
    } else if (ar != null) {
      // No tile size: rank wider (more swatch-like) first; only mid-wide
      // photographic ratios read as scenes.
      dist = 1 / ar;
      kind = ar >= 2.2 || ar < 1.6 ? 'swatch' : 'scene';
    }
    return { ...im, ar, dist, kind };
  });

  // Primary = image whose aspect ratio is CLOSEST to the tile's (the swatch),
  // breaking ties by resolution. Ranking by closeness — not by the swatch/scene
  // label — ensures a wide plank swatch outranks a higher-res room scene.
  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0));
  });

  return scored;
}

/**
 * Map a ranked list (from classifyImages) to asset_type + sort_order rows.
 * Exactly one 'primary' (index 0); remaining swatches → 'alternate';
 * scenes → 'lifestyle'. Caps at maxImages.
 *
 * @returns {Array<{url,original_url,asset_type,sort_order,kind}>}
 */
export function toMediaRows(ranked, { maxImages = 6 } = {}) {
  return ranked.slice(0, maxImages).map((im, i) => ({
    url: im.url,
    original_url: im.original_url || im.url,
    asset_type: i === 0 ? 'primary' : im.kind === 'swatch' ? 'alternate' : 'lifestyle',
    sort_order: i,
    kind: im.kind,
  }));
}
