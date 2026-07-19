/**
 * daltile-crosswalk.js
 *
 * Shared matcher that lands TradePro portal in-stock items on active
 * EDI-coded catalog SKUs. Daltile runs two code families for the same
 * physical item — the portal "sales SKU" (019036MOD1P4) and the EDI 832
 * item code (0190S4639MODGL) — so exact code equality alone parks nearly
 * all stock on unpublished twins. The funnel below narrows same-color,
 * same-size, finish-compatible candidates with progressively weaker
 * signals until one twin remains.
 *
 * Used by daltile-inventory.js (live scrape) and _match-diag.js (offline
 * replay of data/daltile-instock.json).
 */

export const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const first = (v) => Array.isArray(v) ? v[0] : v;
export const finishCompatible = (a, b) => a === b || (a && b && (a.startsWith(b) || b.startsWith(a)));

// ─── Size canonicalization ───────────────────────────────────────────────────
// Portal and DB spell the same dimension differently: "1/2X12" ↔ "0.5x12",
// "4 3/4x6 5/8" ↔ "4.75X6.625". Parse each side to decimal and reformat.

function parseDim(s) {
  s = String(s).trim();
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  return null;
}

export function canonSize(v) {
  const raw = String(v ?? '').trim();
  const m = raw.match(/^(.+?)\s*[xX×]\s*(.+)$/);
  if (m) {
    const w = parseDim(m[1]), h = parseDim(m[2]);
    if (w != null && h != null) return `${w}x${h}`;
  }
  const single = parseDim(raw);
  if (single != null) return String(single);
  return norm(raw);
}

// ─── SKU-code similarity ─────────────────────────────────────────────────────

// The portal sales-SKU and its EDI twin encode the same tokens in slightly
// different layouts (HS05RCT1224VXTM ↔ HS05RCT1224VXTMT), so among
// attribute-equal candidates the true twin has the longest common
// subsequence with the portal code. Ties stay ambiguous.
export const lcsLen = (a, b) => {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
};

// Longest common CONTIGUOUS substring — trim codes share literal tokens
// (S3419T, 2448A) that subsequence scoring dilutes.
export const lcSubstr = (a, b) => {
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best;
};

// ─── Pattern kinds ───────────────────────────────────────────────────────────
// Mosaic pattern encoded in the EDI item code vs how the portal spells it in
// sku/description/shape. A candidate carrying a specific pattern the portal
// doesn't echo is the wrong twin (D208HEX22MT vs D208STJ22MT for "22MS1P").

const CAND_KINDS = [
  ['hex', /HEXMS|HEX\d|EHX/],
  ['herringbone', /HERR|HER\d/],
  ['lattice', /LTW\d/],
  ['penny', /PNYRD/],
  ['chevron', /CHEV|CHV\d/],
  ['arabesque', /ARB\d/],
  ['harlequin', /HAR\d/],
  ['cube', /3DC/],
  ['brick', /BRKJ/],
  ['picket', /PKT|PCK/],
];

const PORTAL_KINDS = [
  ['hex', /HEX/],
  ['herringbone', /HERRINGBONE|\dHB(?![A-Z])/],
  ['lattice', /LATTICE|\dLW/],
  ['penny', /PENNY|PNY/],
  ['chevron', /CHEVRON|CHV/],
  ['arabesque', /ARABESQUE|ARB/],
  ['harlequin', /HARLEQUIN/],
  ['cube', /CUBE|3DC/],
  ['brick', /BRICK|\dBJ/],
  ['picket', /PICKET|PCK|PKT/],
];

// Kind from the EDI item code (color prefix stripped by the caller)
function candKind(itemCode) {
  for (const [kind, re] of CAND_KINDS) {
    if (re.test(itemCode)) return kind;
  }
  return null;
}

function portalKinds(text) {
  const kinds = new Set();
  for (const [kind, re] of PORTAL_KINDS) {
    if (re.test(text)) kinds.add(kind);
  }
  return kinds;
}

// ─── Index & crosswalk ───────────────────────────────────────────────────────

/**
 * Index active catalog rows by canonical size.
 * Rows need: id, vendor_sku, variant_type, collection, product_name,
 * sqft_per_box, cost, size, finish, shape.
 *
 * aliasRows (non-active DAL/AO/MZ rows, vendor_sku only) form the portal-code
 * alias registry used by the alias-claim signal in crosswalkItem.
 */
export function buildActiveIndex(rows, aliasRows = []) {
  const bySize = new Map();
  for (const row of rows) {
    const raw = String(row.size ?? '').trim();
    // Multi-size attribute values ("1x6, 2x6, 3x6, 4x6" trim strips, "2, 6"
    // Keystones hexes) canonicalize as a whole to a garbage key no portal size
    // can hit — index the row under each listed size as well
    const keys = new Set([canonSize(raw)]);
    const parts = raw.split(',');
    if (parts.length > 1) for (const p of parts) keys.add(canonSize(p));
    keys.delete('');
    for (const key of keys) {
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push(row);
    }
  }
  const aliasByColor = new Map();
  for (const row of aliasRows) {
    const sku = norm(row.vendor_sku);
    if (sku.length < 5) continue;
    const color = sku.slice(0, 4);
    if (!aliasByColor.has(color)) aliasByColor.set(color, []);
    aliasByColor.get(color).push(sku);
  }
  return { bySize, aliasByColor, count: rows.length };
}

/**
 * Crosswalk one portal item to active catalog SKUs.
 *
 * Returns { state, matches, candidates } where state is 'matched' |
 * 'ambiguous' | 'none'. matches is [{ row, share }] — share < 1 only for
 * left/right corner pairs, where the portal lists one combined item and the
 * quantity is split across both pieces.
 */
export function crosswalkItem(item, index, stats = {}) {
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
  const rawSku = (item.sku || '').toUpperCase();
  const colorCode = String(item.color || '').toUpperCase();
  const sizeKey = canonSize(first(item.nominalsize));
  const itemFinish = norm(first(item.finish));

  let candidates = (colorCode && sizeKey && index.bySize.get(sizeKey) || [])
    .filter(c => c.vendor_sku.toUpperCase().startsWith(colorCode))
    .filter(c => finishCompatible(norm(c.finish), itemFinish));

  // Item-code echo: when the portal sales SKU contains a candidate's full
  // EDI item code (0780SCRL46691P2 ⊃ SCRL4669), that candidate IS the twin —
  // strongest signal in the funnel, and it overrides the trim-type reject
  // below (trim product names don't always say "Trim").
  const skuNormFull = norm(rawSku);
  const codeOf = (c) => norm(c.vendor_sku.slice(4)).replace(/(mt|gl|pl|hn|tx|ab|nc|st|eu|sx|lp)j?\d*$/, '');
  let codeEchoed = false;
  if (candidates.length >= 1) {
    const echoed = candidates.filter(c => {
      const code = codeOf(c);
      return code.length >= 4 && skuNormFull.includes(code);
    });
    if (echoed.length >= 1 && echoed.length < candidates.length) {
      candidates = echoed;
      codeEchoed = true;
      bump('itemCodeEcho');
    }
  }

  // Alias claim: the non-active rows carry the portal sales SKU for each EDI
  // code family, so they double as a registry of which portal code owns which
  // candidate. A candidate whose item code appears inside a DIFFERENT alias
  // (0T03Q1665U1A claims Q1665AB while we're matching 0T03661A) belongs to
  // that other portal item — drop it, unless the portal code echoes the
  // candidate's code itself (then it's a legitimate twin of this item too).
  if (candidates.length > 1 && index.aliasByColor) {
    const aliasPool = index.aliasByColor.get(norm(colorCode)) || [];
    if (aliasPool.length > 0) {
      const unclaimed = candidates.filter(c => {
        const code = codeOf(c);
        if (code.length < 4 || skuNormFull.includes(code)) return true;
        const own = norm(c.vendor_sku);
        return !aliasPool.some(a => a !== skuNormFull && a !== own && a.includes(code));
      });
      if (unclaimed.length >= 1 && unclaimed.length < candidates.length) {
        candidates = unclaimed;
        bump('aliasClaimed');
      }
    }
  }

  // Series tiebreaker
  if (candidates.length > 1) {
    const seriesKey = norm(item.seriesname);
    const bySeries = candidates.filter(c => norm(c.collection) === seriesKey);
    if (bySeries.length >= 1) candidates = bySeries;
  }

  // Field tile vs trim/accessory: the portal's planproducttype says which
  // side of a field-vs-trim collision this item belongs to. A trim item
  // (also recognizable by "Cove"/"Bullnose"/… in its description) with ONLY
  // field-tile candidates has no active twin — don't let it land on one.
  const portalIsTrim = /trim|installation/i.test(String(first(item.planproducttype) || '')) ||
    /cove base|bullnose|cove bc|quarter round|chair rail|pencil|mud cap/i.test(String(item.skudescription || ''));
  if (candidates.length >= 1 && !codeEchoed) {
    const isTrimCand = (c) => c.variant_type === 'accessory' || /trim/i.test(c.product_name || '');
    const aligned = candidates.filter(c => isTrimCand(c) === portalIsTrim);
    if (aligned.length >= 1 && aligned.length < candidates.length) { candidates = aligned; bump('typeAligned'); }
    else if (aligned.length === 0 && portalIsTrim) { bump('trimRejected'); return { state: 'none', matches: [], candidates: [] }; }
  }

  // Variant markers (MB = Microban, BV = beveled) must be echoed by the
  // portal sku/description, else those candidates are the wrong variant
  const portalStr = (rawSku + ' ' + (item.skudescription || '') + ' ' + String(first(item.shapeandmosaic) || '')).toUpperCase();
  if (candidates.length > 1) {
    for (const [tok, re] of [['MB', /MICROBAN|MB/], ['BV', /BEV/]]) {
      const withTok = candidates.filter(c => c.vendor_sku.toUpperCase().slice(4).includes(tok));
      if (withTok.length > 0 && withTok.length < candidates.length) {
        const keep = re.test(portalStr) ? withTok : candidates.filter(c => !withTok.includes(c));
        if (keep.length >= 1) candidates = keep;
      }
    }
  }

  // Pattern-kind echo: same idea as MB/BV but for mosaic patterns encoded in
  // the item code (HEX22 vs STJ22, LTW13 vs HER13, …)
  if (candidates.length > 1) {
    const echoed = portalKinds(portalStr);
    const kinds = new Map(candidates.map(c => [c, candKind(c.vendor_sku.toUpperCase().slice(4))]));
    const kept = candidates.filter(c => {
      const k = kinds.get(c);
      return !k || echoed.has(k);
    });
    // When the portal names a kind, prefer candidates OF that kind
    let refined = kept;
    if (echoed.size > 0) {
      const ofKind = kept.filter(c => echoed.has(kinds.get(c)));
      if (ofKind.length >= 1) refined = ofKind;
    }
    if (refined.length >= 1 && refined.length < candidates.length) { candidates = refined; bump('kindAligned'); }
  }

  // Shape alignment (Hexagon vs Straight Joint mosaics, etc.)
  if (candidates.length > 1) {
    const itemShape = norm(first(item.shapeandmosaic));
    if (itemShape) {
      const shaped = candidates.filter(c => norm(c.shape) && norm(c.shape) === itemShape);
      if (shaped.length >= 1 && shaped.length < candidates.length) { candidates = shaped; bump('shapeAligned'); }
    }
  }

  // Fraction/thickness variants (DB3/8 vs DB5/8 dome): the portal code
  // carries the fraction digits — require the echo
  if (candidates.length > 1) {
    const fractions = new Map(candidates.map(c => {
      const f = c.vendor_sku.match(/(\d)\/(\d+)/);
      return [c, f ? f[1] + f[2] : null];
    }));
    const distinct = new Set([...fractions.values()].filter(Boolean));
    if (distinct.size > 1) {
      const skuNorm = norm(rawSku);
      const echoed = [...distinct].filter(d => skuNorm.includes(d));
      if (echoed.length === 1) {
        const keep = candidates.filter(c => !fractions.get(c) || fractions.get(c) === echoed[0]);
        if (keep.length >= 1 && keep.length < candidates.length) { candidates = keep; bump('fractionAligned'); }
      }
    }
  }

  // Distinguishing letter tokens: item codes carry alpha markers (DB vs SHB
  // dome variants, C813 vs CB813 cove variants). A marker that not all
  // candidates share must be echoed verbatim in the portal code.
  if (candidates.length > 1) {
    const skuNorm = norm(rawSku.slice(colorCode.length));
    // Generic shape codes aren't markers — the portal never echoes them
    const SHAPE_RUNS = new Set(['squ', 'rct', 'plk', 'hex', 'oct']);
    const runsOf = (c) => (norm(c.vendor_sku.slice(4)).match(/[a-z]{2,}/g) || [])
      .filter(r => !SHAPE_RUNS.has(r));
    const runSets = new Map(candidates.map(c => [c, new Set(runsOf(c))]));
    const common = [...runSets.get(candidates[0])].filter(r => candidates.every(c => runSets.get(c).has(r)));
    const kept = candidates.filter(c =>
      [...runSets.get(c)].filter(r => !common.includes(r)).every(r => skuNorm.includes(r))
    );
    if (kept.length >= 1 && kept.length < candidates.length) { candidates = kept; bump('tokenAligned'); }
  }

  // Contiguous shared token beats subsequence for trim codes (color prefix
  // stripped; normalized so 3/8 ↔ 38 compare). Narrow to the top scorers.
  if (candidates.length > 1) {
    const rem = norm(rawSku.slice(colorCode.length));
    const scored = candidates.map(c => ({ c, score: lcSubstr(rem, norm(c.vendor_sku.slice(colorCode.length))) }));
    const best = Math.max(...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === best).map(s => s.c);
    if (winners.length < candidates.length) { candidates = winners; if (winners.length === 1) bump('substrResolved'); }
  }

  // Dealer price: the portal classprices should equal the EDI cost of the twin
  if (candidates.length > 1 && item.classprices > 0) {
    const close = candidates.filter(c => c.cost > 0 && Math.abs(parseFloat(c.cost) - item.classprices) / item.classprices < 0.03);
    if (close.length === 1) { candidates = [close[0]]; bump('priceResolved'); }
  }
  // Weaker form: a UNIQUE nearest cost within 15% still separates twins whose
  // prices genuinely differ (SQU66 field tile vs Q1665 abrasive quarry)
  if (candidates.length > 1 && item.classprices > 0) {
    const diffs = candidates
      .map(c => ({ c, diff: c.cost > 0 ? Math.abs(parseFloat(c.cost) - item.classprices) / item.classprices : Infinity }))
      .sort((a, b) => a.diff - b.diff);
    if (diffs[0].diff < 0.15 && diffs.length > 1 && diffs[1].diff - diffs[0].diff > 0.05) {
      candidates = [diffs[0].c];
      bump('nearPriceResolved');
    }
  }

  if (candidates.length > 1) {
    const scored = candidates.map(c => ({ c, score: lcsLen(rawSku, c.vendor_sku.toUpperCase()) }));
    const best = Math.max(...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === best);
    if (winners.length === 1) candidates = [winners[0].c];
  }

  // Left/right corner pairs (SCL3401/SCR3401, QCL/QCR): the portal lists one
  // combined item — split the quantity across both pieces
  if (candidates.length > 1) {
    const stripLR = (c) => c.vendor_sku.toUpperCase().replace(/(S?Q?C)[LR]/g, '$1X');
    const collapsed = new Set(candidates.map(stripLR));
    if (collapsed.size === 1) {
      bump('cornerSplit');
      return { state: 'matched', matches: candidates.map(c => ({ row: c, share: 1 / candidates.length })), candidates };
    }
  }

  if (candidates.length === 1) return { state: 'matched', matches: [{ row: candidates[0], share: 1 }], candidates };
  if (candidates.length > 1) {
    // A still-ambiguous set where EVERY candidate's cost is wildly off the
    // portal's dealer price is a different item that survived on attributes
    // alone (2x8 field tile funneled onto $2.29 cove trims) — call it
    // unmatched rather than ambiguous. Never applied to resolved matches:
    // portal prices are per-piece for some trims, so units don't always
    // compare, and a lone survivor is better evidence than a price delta.
    if (item.classprices > 0 && candidates.every(c =>
      c.cost > 0 && Math.abs(parseFloat(c.cost) - item.classprices) / item.classprices > 0.4)) {
      bump('priceRejected');
      return { state: 'none', matches: [], candidates: [] };
    }
    return { state: 'ambiguous', matches: [], candidates };
  }
  return { state: 'none', matches: [], candidates };
}
