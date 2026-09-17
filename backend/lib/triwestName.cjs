// Tri-West product-name cleaning — the SINGLE source of truth for turning raw
// TW catalog/832/DNav name strings into retail-readable titles. Shared by the
// one-time data backfill (scripts/fix-triwest-names.mjs) and the importers
// (scripts/import-triwest-832.cjs, scripts/insert-atwork-carpet-tile.cjs) so a
// re-import can never re-introduce the noise the backfill removed.
//
// Every rule is CONSERVATIVE: it only fires when its noise pattern is present,
// so an already-clean name ("Affinity", "Bravada D'Vine") passes through byte
// for byte. Verified as a no-op against the full active TW name set.
//
// Classes handled (see plan): A raw catalog codes, B trim/molding formatting,
// C @work redundancy, D trailing bare width number.

/**
 * Clean a raw Tri-West product NAME into a retail title.
 * @param {string} raw
 * @returns {string}
 */
// Molding/trim type words. When a name is one of these, a trailing bare number
// is unambiguously a length (in inches) — safe to mark with an inch symbol.
const TRIM_RE = /\b(stair\s*nose|t-?mold(?:ing)?|reducer|end\s*cap|quarter\s*round|overlap|threshold|bullnose|molding|moulding|transition|scotia|shoe\s*mold|square\s*nose|baby\s*threshold|multi[-\s]?purpose)\b/i;

function cleanTriwestName(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let name = raw.trim();

  // (A) Capture and set aside a trailing bevel qualifier so it survives the
  // spec-strip and re-attaches as a parenthetical. "…7 X60 - Micro Bevel"
  let bevel = '';
  const bevelM = name.match(/[-–]\s*(Micro|Painted)\s+Bevel\s*$/i);
  if (bevelM) {
    bevel = bevelM[1].charAt(0).toUpperCase() + bevelM[1].slice(1).toLowerCase() + ' Bevel';
    name = name.slice(0, bevelM.index).trim();
  }

  // (A) Catalog-spec noise is only present on the raw SPC/WPC code names. Detect
  // it up front — the size strip below is gated on it so we NEVER strip a plain
  // trailing size that distinguishes sibling products ("Deja New Oak Framing
  // 7x48" vs "9x60", "Double Take Tile 12x24" vs "18x36").
  const hasCatalogNoise = /\b(SPC|WPC|Coll|W\/\s*pad|\d+(?:\.\d+)?\s*mil)\b/i.test(name);

  name = name
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, ' ')    // (12 sqft/ctn)
    .replace(/\bColl\b\.?/gi, ' ')
    .replace(/\bW\/\s*pad\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*mil\b/gi, ' ')         // 12mil, 20mil
    .replace(/\s+/g, ' ')
    .trim();

  if (hasCatalogNoise) {
    // Redundant plank/size dimensions on a raw catalog code ("9 X72",
    // "8mmx7.16", "7 X60"); the product is identified by line/bevel/house brand.
    name = name
      .replace(/\b\d+\s*mm\s*x\s*[\d.]+\b/gi, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*[xX]\s*\d+(?:\.\d+)?\b/g, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, ' ')          // wear thickness "2mm"
      .replace(/\s*[-–]\s*(?=$|\s)/g, ' ')               // dangling "- " left by strips
      .replace(/\s+/g, ' ')
      .trim();
    // Drop SPC/WPC construction tokens, but never reduce the name to just "SPC".
    const withoutTag = name.replace(/\b(SPC|WPC)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutTag) name = withoutTag;
  }

  // (C) @work carpet tiles: the category suffix re-adds "Carpet Tile" and the
  // size belongs in the variant, so drop both from the stored name.
  if (/^@work\b/i.test(name)) {
    name = name
      .replace(/\s*\bCarpet\s+Tile\b/gi, ' ')
      .replace(/\s+\d+\s*[xX]\s*\d+\s*$/,'')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // (B) Normalize molding casing: "T-molding" → "T-Molding".
  name = name.replace(/\bT-molding\b/gi, 'T-Molding');

  // (B) On a molding/trim product only, a trailing bare number is a length —
  // mark it with an inch symbol ("Flush Stair Nose 94" → 94″). Never touch a
  // model/line number ("Inception 20", "Inception 200").
  if (TRIM_RE.test(name)) {
    name = name.replace(/(\D)(\d+(?:\.\d+)?)\s*$/,'$1$2″');
  }

  // Re-attach the bevel qualifier.
  if (bevel) name = `${name} (${bevel})`;

  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Clean a Tri-West COLLECTION string. Conservative by design (owner decision
 * 2026-09-16): remove catalog-spec junk and collapse an exact "Brand - Brand"
 * echo, but KEEP plank widths ("Provenza 7.5\"") — they carry buyer-useful info
 * and several series are distinguished only by width.
 * @param {string} raw
 * @returns {string}
 */
function cleanTriwestCollection(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let col = raw
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, ' ')
    .replace(/\bColl\b\.?/gi, ' ')
    .replace(/\bW\/\s*pad\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*mil\b/gi, ' ')
    .replace(/\b(SPC|WPC)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Collapse "Brand <width> - Brand" → "Brand <width>" (the suffix just repeats
  // the brand, e.g. "Grand Pacific 7.25\" - Grand Pacific").
  const dash = col.split(' - ');
  if (dash.length === 2) {
    const brandSeg = dash[0].trim();
    const suffixSeg = dash[1].trim();
    const brandNoWidth = brandSeg.replace(/\s+\d+(?:\.\d+)?["'](?:\s+\d+\/\d+["'])?\s*$/,'').trim();
    if (suffixSeg && suffixSeg.toLowerCase() === brandNoWidth.toLowerCase()) {
      col = brandSeg;
    }
  }
  return col.replace(/\s+/g, ' ').trim();
}

/**
 * Strip catalog-code fragments from a Tri-West VARIANT name. TW variant_names
 * arrive as "<real name>, <CODE>[, <CODE>]" where CODE is a style/SKU code
 * ("Golden Glaze, ARMW81", "Silhouette - Quarter Round, 2309QTR", "Retreat
 * Brown, ARMTML, (ARMTM14987LZ)"). Split on commas and drop any segment that is
 * a bare code, keeping human descriptors (colors, sizes "3.5 in", finishes
 * "Ultra Low Gloss Urethane (9 Coats)", species "White Oak").
 *
 * A segment is a CODE when — after removing optional surrounding parens — it is
 * all uppercase letters/digits (no lowercase, no spaces) AND (contains a digit
 * OR is ≥5 chars), excluding Roman numerals. Never blanks the variant: if every
 * segment looks like a code, the original is returned unchanged.
 * @param {string} raw
 * @returns {string}
 */
function isTriwestCode(seg) {
  const s = seg.trim().replace(/^\(([^)]*)\)$/, '$1'); // unwrap (CODE)
  if (!/^[A-Z0-9]{3,}$/.test(s)) return false;         // all-caps alphanumeric only
  if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,2})$/.test(s)) return false; // Roman numeral
  return /\d/.test(s) || s.length >= 5;
}

function cleanTriwestVariant(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  if (!raw.includes(',')) return raw;                  // no segments → nothing to strip
  const segs = raw.split(',').map(x => x.trim()).filter(Boolean);
  const kept = segs.filter(seg => !isTriwestCode(seg));
  if (!kept.length) return raw.trim();                 // don't blank the variant
  return kept.join(', ');
}

module.exports = { cleanTriwestName, cleanTriwestCollection, cleanTriwestVariant };
