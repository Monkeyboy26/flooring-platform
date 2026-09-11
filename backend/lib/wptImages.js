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
 * True if pixel stats look like a DOCUMENTATION/marketing slide rather than a
 * product photo. WPT's Ecwid galleries embed brand cards ("PROTECT Antimicrobial
 * protection") and technical spec-sheet tables — white-dominated with text/tables
 * and almost no color.
 *
 * White/saturation/brightness ALONE can't tell these from a white-marble swatch
 * (Statuario measures 97% white / 0.4 sat / 253 bright — even MORE extreme than a
 * spec sheet). The separator is EDGE DENSITY: text and table rules are ~0.29-0.38
 * edge, a marble swatch's soft veining only ~0.08. So filler additionally requires
 * high edge density on top of being near-pure-white.
 *   filler          → white ~0.76+, sat ~0-6, bright ~240+, edge ~0.17-0.22 (text/tables)
 *   marble layout   → white ~0.9+,  sat ~0-1, bright ~245+, edge ~0.10 (grout grid)  (kept)
 *   marble swatch   → white ~0.97,  sat ~0.4, bright ~253,  edge ~0.003              (kept)
 * A 0.14 edge floor sits in the gap between a white-marble tile layout (~0.10) and
 * a text-dense documentation slide (~0.17+), so real marble imagery is never dropped.
 * @param {{whiteFrac:number, saturation:number, meanBright:number, edgeFrac:number}} s
 */
export function isFillerStats(s) {
  if (!s) return false;
  return s.whiteFrac >= 0.6 && s.saturation < 8 && s.meanBright >= 238 && (s.edgeFrac ?? 0) >= 0.14;
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
    let isSwatch = false;
    if (ar != null && R != null) {
      dist = Math.abs(ar - R);
      // Wider tiles need a looser absolute tolerance (a 5.33 plank swatch renders
      // at ~3.75); scale tolerance with the tile ratio.
      const relTol = Math.max(tol, R * 0.08);
      const matchesTile = dist <= relTol || ar >= 2.2 || (R <= 1.15 && ar <= 1.10);
      // For RANKING: a swatch matches the tile ratio, is extremely wide (no room
      // photo exceeds ~2.2:1), or is near-square (product shots of small-format /
      // fabric-look tiles are square even when the tile is 12x24). A mid-range
      // photographic ratio (1.35-2.2, not matching) is a room scene → rank last.
      isSwatch = matchesTile || ar < 1.35;
      // For LABELING (asset_type): only a clearly WIDE non-matching image is a
      // 'lifestyle' room scene; borderline shots stay 'alternate' gallery images.
      kind = matchesTile ? 'swatch' : ar >= 1.6 ? 'scene' : 'swatch';
    } else if (ar != null) {
      // No tile size: prefer near-square / very-wide (swatch-like) over mid-wide.
      dist = Math.abs(ar - 1);
      isSwatch = ar < 1.35 || ar >= 2.2;
      kind = ar >= 1.6 && ar < 2.2 ? 'scene' : 'swatch';
    }
    return { ...im, ar, dist, kind, isSwatch };
  });

  // Primary = best swatch: swatches (tile-matching / near-square / extreme-wide)
  // rank ahead of room scenes; within a group, closest-to-tile, then PLAINEST
  // (lowest edge density — a mosaic sheet's grout grid reads far higher than a
  // plain field swatch, so this demotes coordinating-mosaic images out of
  // primary), then higher resolution.
  const edge = (x) => (typeof x.edgeFrac === 'number' ? x.edgeFrac : 0);
  scored.sort((a, b) => {
    if (a.isSwatch !== b.isSwatch) return a.isSwatch ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (Math.abs(edge(a) - edge(b)) > 0.02) return edge(a) - edge(b);
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
