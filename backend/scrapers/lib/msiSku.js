// Shared MSI SKU primitives — color-safe matching helpers.
//
// Pure functions (no Puppeteer / DB) so scripts, the quality rule, and the DAM
// image matcher can all import them. See the MSI image-matching overhaul plan.
//
//   colorStem(sku)      → stable color-identifying stem (size/finish/view stripped)
//   cleanDamSku(damPath)→ SKU id from a DAM filename (strips view-type/debris tails)
//   stemsAgree(a, b)    → colorStem(a) === colorStem(b), thickness-normalized
//   classifyRank(...)   → precedence tier of an EXISTING media_assets row
//   RANK                → precedence of an INCOMING match, keyed by strategy/source

// ── Swatch / low-quality source-stone shots (keep in sync with msi-dam-images
//    REPLACEABLE_SWATCH_RE and fix-msi-panel-images.mjs isBadPanelImage) ──────
const REPLACEABLE_SWATCH_RE =
  /\/colornames\/(?:videos\/)?[^/]*-(marble|granite|slate|travertine|quartzite|limestone|sandstone|onyx)\.jpg$|\/images\/skus\//i;

// Strip rules, applied repeatedly until the string stops changing. Looping (vs a
// fixed order) means a token revealed by an earlier strip — e.g. the "-C" photo
// letter hidden behind "-6MM" in NSL-CALLUCM-C-6MM — still gets removed.
const STRIP_RULES = [
  // 1. Trailing trim / finish / view segments after a hyphen
  s => s.replace(/-(QR|TL|FSN|FSNL|ST|SR|EC|ECL|COR|BN|SBN|BEV|HB|SL|CL|3DHS|3DH|3DW|MULT|ALT)$/i, ''),
  // 2. Trailing single catalog/photo-view letter after a hyphen. MSI uses -N
  //    (167), -K, -T, -H, -R, -C, -G, -V as variant/catalog markers that never
  //    denote color, so a single trailing letter is always safe to drop.
  s => s.replace(/-[A-Z]$/i, ''),
  // 3. Thickness / wear-layer: 8MM, 4MM, 12MIL, 6.5MM, 4.4MM (hyphen optional)
  s => s.replace(/-?\d+(?:\.\d+)?(MM|MIL)$/i, ''),
  // 4. XxY dimension block + fraction tails + trailing finish letters/BN
  //    (3X6T, 9.5X94.5, 4X16SBN, 9.5X86-5/8)
  s => s.replace(/-?\d+(?:\.\d+)?X\d+(?:\.\d+)?(?:[-/]\d+(?:\.\d+)?)*[A-Z]*$/i, ''),
  // 5. Glued size block NNN..[finish] (1224, 2448P, 181850, 2X2P→handled by 4)
  s => s.replace(/-?\d{3,6}[A-Z]{0,3}$/i, ''),
];

/**
 * Extract a stable color-identifying stem from a vendor SKU by stripping trailing
 * size / finish / thickness / view / trim tokens. Two SKUs with the same stem are
 * the same COLOR (possibly different size/finish/trim); different stems are
 * different colors. Validated to produce 0 false-merges across the MSI catalog.
 */
export function colorStem(sku) {
  let s = String(sku || '').toUpperCase().replace(/\s+/g, '');
  for (let i = 0; i < 6; i++) {
    let next = s;
    for (const rule of STRIP_RULES) next = rule(next);
    next = next.replace(/[-]+$/g, '');
    // Never strip below a usable stem (guards against all-token SKUs)
    if (next.length < 2 || next === s) { s = next.length < 2 ? s : next; break; }
    s = next;
  }
  return s.replace(/[-]+$/g, '');
}

/**
 * Extract the SKU identifier from a DAM filename/path. Replaces the older
 * extractDamSku: also strips the AEM view-type and debris tails
 * (Single-Product-Photo, -3DH, -MULT, -ALT, _b, numbered variants) that
 * otherwise leak into the id and break matching.
 */
export function cleanDamSku(damPath) {
  let f = String(damPath || '').split('/').pop().replace(/\.\w+$/, '');
  // Strip ONLY unambiguous DAM photo-view/debris tails. Do NOT strip finish
  // tokens like -3DH / -3DW / -3DHS — those are part of real vendor_skus
  // (3D honed/wave panels); stripping them breaks the exact match. The stem
  // veto (colorStem) still normalizes those tokens, so genuine debris cases
  // (e.g. a -3DHS DAM file for a -3DH SKU) still match via the prefix path.
  f = f.replace(/[-_ ]*(Primary[- ]?Web[- ]?Image\d*|Single[- ]?Product[- ]?Photo|Iso(?:metric)?(?:[- ]?Product[- ]?Photo)?)$/i, '');
  f = f.replace(/[-_][AB]\d$/i, '');          // -A2 / _B1 alternate-shot indices
  f = f.replace(/_b(?:_\d+)?$/i, '');
  return f.trim();
}

/** True when two SKUs share a color stem (thickness token normalized). */
export function stemsAgree(a, b) {
  const norm = x => colorStem(x).replace(/(\d)M$/i, '$1MM'); // 8M → 8MM safety
  return norm(a) === norm(b) && colorStem(a).length >= 2;
}

// ── Precedence ──────────────────────────────────────────────────────────────
// Rank of an INCOMING match, so a lower-quality source never overwrites a better
// existing image. Keyed by matchDamToSku strategy and by fallback source name.
export const RANK = {
  exact: 100,
  normalized: 90,
  prefix: 80,
  'reverse-prefix': 80,
  inherited: 70,
  'cdn-verified': 50,
  'cdn-guess': 40,
  website: 30,
  swatch: 10,
};

function isDamUrl(u) {
  return /\/uploads\/msi-dam\//i.test(u) || /images\.msisurfaces\.com/i.test(u);
}
function isCdnUrl(u) {
  return /cdn\.msisurfaces\.com/i.test(u);
}

/**
 * Derive the precedence tier of an EXISTING media_assets row from the columns we
 * already store (no schema change). A mirrored image keeps its origin in
 * original_url, so a mirrored DAM primary still ranks as DAM.
 */
export function classifyRank(url, originalUrl, mirrorBytes) {
  const u = url || '';
  const o = originalUrl || '';
  // Tiny file or source-stone swatch → always replaceable
  if (mirrorBytes != null && mirrorBytes > 0 && mirrorBytes < 20000) return RANK.swatch;
  if (REPLACEABLE_SWATCH_RE.test(u) || REPLACEABLE_SWATCH_RE.test(o)) return RANK.swatch;
  if (isDamUrl(u) || isDamUrl(o)) return RANK.prefix;        // any DAM-origin → 80
  if (isCdnUrl(u) || isCdnUrl(o)) return RANK['cdn-guess'];  // 40
  return RANK.website;                                       // 30
}

export { REPLACEABLE_SWATCH_RE };
