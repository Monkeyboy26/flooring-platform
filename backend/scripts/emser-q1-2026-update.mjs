#!/usr/bin/env node
/**
 * Emser Q1-2026 price list update.
 *
 * Reprices the existing EMS catalog (832/catalog-scraper shaped: product = series
 * + suffix, variants = colors) from the dealer price list PDF, and deactivates
 * items missing from the list as discontinued.
 *
 * The price list has NO vendor SKU codes — matching is (series, color, size,
 * [finish]) via product collection/name + color/size/finish attributes, with
 * trim/mosaic SKUs matched via the vendor_sku suffix conventions:
 *   ...0312SB = SBN 3x12, ...0612CB = cove base, ...0106CO = cove corner,
 *   ...1212MO2 = mosaic on 12x12 mesh, M-prefix + trailing H/P = stone honed/polished.
 *
 * Natural stone pages parse with correct prices but unreliable series
 * attribution, so stone SKUs match via a series-agnostic color|size|finish
 * index and are NEVER auto-dropped.
 *
 * Drop policy (--apply-drops):
 *   - dropped: field-tile SKUs whose series is absent from the list AND whose
 *     collection name never appears in the PDF text (Emser II-successor series
 *     like LOGIC II do NOT count as presence of LOGIC); plus color/size-level
 *     misses inside on-list series; plus trims whose color left the series.
 *   - never dropped: supplier brands sold under EMS (Laticrete, Rubi, NuHeat,
 *     Signature Series profiles, ...), stone, unmatched trims/mosaics
 *     (pricing granularity, not availability), unresolved/ambiguous series.
 *
 * Usage (from backend/):
 *   node scripts/emser-q1-2026-update.mjs --pdf "/path/to/Emser Q-1-2026.pdf"   # report only
 *   ... --apply-prices     # write pricing (+ sell_by/basis corrections)
 *   ... --apply-drops      # deactivate discontinued SKUs + empty products
 *
 * Report + backup JSONs land in backend/data/.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { parsePDF, normalizeSize } from '../scrapers/emser-pricelist.js';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const PDF_PATH = getArg('--pdf');
const APPLY_PRICES = args.includes('--apply-prices');
const APPLY_DROPS = args.includes('--apply-drops');
if (!PDF_PATH || !fs.existsSync(PDF_PATH)) { console.error('Pass --pdf <path to Emser price list PDF>'); process.exit(1); }

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─── Normalization helpers ───────────────────────────────────────────────────

const TEXTURE_TOKENS = /\b(GRIP|R10|R11|R12|20MM|2CM|RECT|RECTIFIED)\b/g;
const FINISH_TAIL = /^(.*?)\s+(MATTE|POLISHED|HONED|GLOSSY|GLOSS|SATIN|LAPPATO|STRUCTURED|TEXTURED|BRUSHED|TUMBLED|CHISELED|FILLED)$/;
const SUCCESSOR_TOKEN = /^(II|III|2|3|PLUS)\b/;

function normText(s) {
  return (s || '').toUpperCase()
    .replace(/[*.,'"()]/g, ' ')
    .replace(/[-\/&]/g, ' ')
    .replace(/\bGREY\b/g, 'GRAY')
    .replace(/\s+/g, ' ')
    .trim();
}
function normSeries(s) {
  return normText(s).replace(/\s+ONLINE$/, '');
}
function normSizeKey(s) {
  const n = normalizeSize(String(s || ''));
  return n.replace(/\s*hex\s*$/i, '').trim();
}
function cleanColor(raw) {
  let c = normText(raw).replace(/\bV\d\b/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = c.replace(TEXTURE_TOKENS, ' ').replace(/\s+/g, ' ').trim();
  const textured = stripped !== c;
  c = stripped;
  // strip trailing finish tokens repeatedly: "FAWN GLOSS/MATTE" -> "FAWN GLOSS MATTE"
  // (normText drops the slash) -> FAWN + GLOSS finish; "ICE GLOSS ONLY" -> ICE
  let finish = null;
  for (;;) {
    const only = c.match(/^(.*?)\s+ONLY$/);
    if (only && only[1]) { c = only[1].trim(); continue; }
    const m = c.match(FINISH_TAIL);
    if (m && m[1]) { c = m[1].trim(); finish = m[2]; continue; }
    break;
  }
  return { color: c, finish, textured };
}
// strip material words for stone secondary lookup ("METRO CREAM LIMESTONE" -> "METRO CREAM")
function stripStoneMaterial(color) {
  return color.replace(/\b(LIMESTONE|MARBLE|TRAVERTINE|GRANITE|SLATE|QUARTZITE|SANDSTONE)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Nominal-size fallback: Emser lists nominal (12X24) while some DB rows carry
// actual dims (12x23). Generate neighbor keys within +/-1 per dimension.
function sizeNeighbors(sizeKey) {
  const m = sizeKey.match(/^(\d+)x(\d+)$/);
  if (!m) return [];
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  const out = [];
  for (const dw of [-1, 0, 1]) for (const dh of [-1, 0, 1]) {
    if (dw === 0 && dh === 0) continue;
    out.push(`${w + dw}x${h + dh}`);
  }
  return out;
}

// ─── PDF parse + indexes ─────────────────────────────────────────────────────

const rawText = execSync(`pdftotext -layout "${PDF_PATH}" -`, { maxBuffer: 100 * 1024 * 1024, encoding: 'utf-8' });
const rawLines = rawText.split('\n');
const parsed = parsePDF(rawText, { includeTrims: true, includeSpecial: true });

const TRIM_TYPES = [
  { re: /\bSBN\b|\bBULLNOSE\b/, code: 'SB' },
  { re: /\bCOVE\s*BASE\b/, code: 'CB' },
  { re: /\bCOVE\s*(CORNER|OUTSIDE)\b|\bCORNER\b/, code: 'CO' },
  { re: /\bJOLLY\b/, code: 'JL' },
  { re: /\bCOPING\b/, code: 'CP' },
  { re: /\bPENCIL\b/, code: 'PE' },
];

const idx = {
  seriesSet: new Set(),
  field: new Map(),          // series|color|size[|finish] -> entry
  seriesColors: new Map(),   // series -> Set(colors)
  mosaics: new Map(),        // series -> [{label, price, finish, special}]
  trims: new Map(),          // series -> [{typeCode, size, price, finish, special, label}]
  stone: new Map(),          // color|size[|finish] -> entry (series-agnostic)
  seriesEntries: new Map(),  // series -> [entry] (for design-suffixed color fallback)
};
// store a COPY per key — conflict flags must not bleed across indexes/keys
function addKey(map, key, entry) {
  const prev = map.get(key);
  if (prev && Math.abs(prev.price - entry.price) > 0.005) prev.conflict = true;
  else if (!prev) map.set(key, { ...entry });
}
// Only stone-classified series feed the series-agnostic stone color index —
// generic colors (BEIGE, GRAY, NERO) would otherwise false-match cheap ceramic.
const STONE_SERIES = /\bTRAV\b|\bTRAVERTINE\b|\bMARBLE\b|\bGRANITE\b|\bSLATE\b|\bQUARTZITE\b|\bLIMESTONE\b|\bSANDSTONE\b|\bFLUTIQUE\b|\bSTRUCTURE\b|\bLEDGER\b|\bEXTERO\b|\bMETRO\b|\bVENETIAN\b|\bPEBBLES?\b|\bSTONE\b/i;
function isStoneSeries(s) {
  return STONE_SERIES.test(s.name) || /\bMARBLE\b|\bTRAVERTINE\b|\bGRANITE\b|\bSLATE\b|\bLIMESTONE\b|\bQUARTZITE\b|NATURAL STONE/i.test(s.material || '');
}

for (const s of parsed) {
  const ser = normSeries(s.name);
  idx.seriesSet.add(ser);
  if (!idx.seriesColors.has(ser)) idx.seriesColors.set(ser, new Set());
  if (!idx.mosaics.has(ser)) idx.mosaics.set(ser, []);
  if (!idx.trims.has(ser)) idx.trims.set(ser, []);

  for (const b of s.sizeBlocks) {
    const size = normSizeKey(b.size);
    for (const it of b.items) {
      const rawColor = normText(it.color);
      const isMosaic = it.section === 'MOSAIC' || /^MOSAIC\b/.test(rawColor) || /\bON MESH\b/.test(rawColor);
      if (isMosaic) {
        const cc = cleanColor(it.color);
        idx.mosaics.get(ser).push({
          label: rawColor, color: cc.color, size,
          price: it.price, finish: it.finish ? normText(it.finish) : cc.finish, special: !!it.special,
        });
        continue;
      }
      const { color, finish: tailFinish, textured } = cleanColor(it.color);
      const finish = it.finish ? normText(it.finish) : tailFinish;
      if (!color) continue;
      idx.seriesColors.get(ser).add(color);
      const entry = { price: it.price, unit: b.unit, sqftPerBox: b.sqftPerBox, pcsPerBox: b.pcsPerBox,
                      special: !!it.special, textured, finish, series: ser, color, size };
      if (!idx.seriesEntries.has(ser)) idx.seriesEntries.set(ser, []);
      idx.seriesEntries.get(ser).push(entry);
      addKey(idx.field, `${ser}|${color}|${size}`, entry);
      if (finish) addKey(idx.field, `${ser}|${color}|${size}|${finish}`, entry);
      if (isStoneSeries(s)) {
        addKey(idx.stone, `${color}|${size}`, entry);
        if (finish) addKey(idx.stone, `${color}|${size}|${finish}`, entry);
        const noMat = stripStoneMaterial(color);
        if (noMat && noMat !== color) {
          addKey(idx.stone, `${noMat}|${size}`, entry);
          if (finish) addKey(idx.stone, `${noMat}|${size}|${finish}`, entry);
        }
      }
    }
  }
  for (const t of (s.trims || [])) {
    if (t.prices.length > 1) continue; // ambiguous multi-column trim row — leave alone
    const label = normText(t.label);
    const type = TRIM_TYPES.find(tt => tt.re.test(label));
    const sizeM = label.match(/(\d+)\s?X\s?(\d+)/);
    const fm = label.match(FINISH_TAIL);
    idx.trims.get(ser).push({
      typeCode: type ? type.code : null,
      size: sizeM ? `${parseInt(sizeM[1], 10)}x${parseInt(sizeM[2], 10)}` : null,
      price: t.price, finish: fm ? fm[2] : null, special: !!t.special, label,
    });
  }
}

console.log(`PDF: ${parsed.length} series, ${idx.field.size} field keys, ` +
  `${[...idx.mosaics.values()].reduce((a, b) => a + b.length, 0)} mosaic entries, ` +
  `${[...idx.trims.values()].reduce((a, b) => a + b.length, 0)} trim entries`);

// Emser "II"/"PLUS" successors: X II is a re-release of X. Our 832-era catalog
// often tracks the line WITHOUT the II (e.g. DB "Sterlina" carries the
// STERLINA II assortment). A color+size hit in the successor is treated as the
// same continuing item; misses still count as discontinued.
const successorsOf = new Map();
for (const s of idx.seriesSet) {
  const m = s.match(/^(.+)\s+(II|III|2|3|PLUS)$/);
  if (m) {
    if (!successorsOf.has(m[1])) successorsOf.set(m[1], []);
    successorsOf.get(m[1]).push(s);
  }
}
function seriesChain(ser) {
  return [ser, ...(successorsOf.get(ser) || [])].filter(s => idx.seriesSet.has(s));
}
function unionColors(serList) {
  const out = new Set();
  for (const s of serList) for (const c of (idx.seriesColors.get(s) || [])) out.add(c);
  return out;
}

// Descriptor aliases: DB collection "EXPANSE" -> PDF series "EXPANSE THIN TILE".
// Never alias to II/PLUS successors here — those go through seriesChain.
const seriesAlias = new Map();
function resolveSeriesName(collNorm) {
  if (!collNorm) return null;
  if (idx.seriesSet.has(collNorm)) return collNorm;
  if (seriesAlias.has(collNorm)) return seriesAlias.get(collNorm);
  let resolved = null;
  if (successorsOf.has(collNorm)) {
    resolved = collNorm; // pseudo-series: only successors exist on the list
  } else {
    const cands = [...idx.seriesSet].filter(s => {
      if (!s.startsWith(collNorm + ' ')) return false;
      const rest = s.slice(collNorm.length + 1);
      return !SUCCESSOR_TOKEN.test(rest);
    });
    resolved = cands.length === 1 ? cands[0] : null;
  }
  seriesAlias.set(collNorm, resolved);
  return resolved;
}

// Does this collection name appear anywhere in the PDF as a real (non-TOC) line?
// Successor tokens after the name (LOGIC II) do NOT count as presence of LOGIC.
const presenceCache = new Map();
function collectionInPdfText(collNorm) {
  if (!collNorm || collNorm.length < 3) return false;
  if (presenceCache.has(collNorm)) return presenceCache.get(collNorm);
  let found = false;
  for (const l of rawLines) {
    if (l.search(/\S/) > 10) continue;                      // series-ish lines start near the margin
    if (/\d+\.\d{2}/.test(l)) continue;                     // price row (a COLOR, not a series)
    if (/\s{3,}(Page\s*)?\d{1,3}(-\d{1,3})?\s*$/.test(l)) continue; // TOC
    const t = normText(l.trim());
    if (t === collNorm) { found = true; break; }
    if (t.startsWith(collNorm + ' ')) {
      const rest = t.slice(collNorm.length + 1);
      if (!SUCCESSOR_TOKEN.test(rest)) { found = true; break; }
    }
  }
  presenceCache.set(collNorm, found);
  return found;
}

// ─── DB load ─────────────────────────────────────────────────────────────────

const { rows: skus } = await pool.query(`
  SELECT p.id AS product_id, p.name AS pname, p.collection, p.status AS pstatus,
         s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by, s.status AS sstatus,
         pr.cost, pr.retail_price, pr.price_basis,
         pk.sqft_per_box, pk.pieces_per_box,
         MAX(sa.value) FILTER (WHERE a.slug='color')  AS color,
         MAX(sa.value) FILTER (WHERE a.slug='size')   AS size,
         MAX(sa.value) FILTER (WHERE a.slug='finish') AS finish
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id AND v.code = 'EMS'
  JOIN skus s ON s.product_id = p.id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
  LEFT JOIN attributes a ON a.id = sa.attribute_id
  WHERE s.status = 'active' AND p.status = 'active'
  GROUP BY p.id, s.id, pr.sku_id, pr.cost, pr.retail_price, pr.price_basis, pk.sqft_per_box, pk.pieces_per_box
`);
console.log(`DB: ${skus.length} active EMS SKUs`);

// Supplier brands / hardware programs sold under the EMS vendor — the tile
// price list can't confirm these either way; never touch them.
const EXCLUDED_COLL = new RegExp([
  'AQUA MIX', 'CUSTOM BUILDING', 'BLACK & DECKER', 'COLORFAST', 'MERKRETE', '\\bTEC\\b',
  'SHOWER BENCH', 'EMSER ESSENTIALS', 'EMPERVIOUS', 'EMSER SIGNATURE SERIES',
  'LATICRETE', 'NOBLE COMPANY', 'TROXELL', 'LOXCREEN', 'RUBI TOOLS', 'NUHEAT',
  'DONNELLY', 'MIRACLE SEALANTS', 'SIKA', 'TRIMACO', 'UNITED STATES GYPSUM',
  'PROTECTO WRAP', 'EASYHEAT', 'Q\\.E\\.P', 'HYDRO-BLOK', 'INNOVIS', 'PERMABASE',
  'WESTERN STATES',
].join('|'), 'i');

const STONE_COLL = /\bTRAV\b|\bTRAVERTINE\b|\bMARBLE\b|\bGRANITE\b|\bSLATE\b|\bQUARTZITE\b|\bLIMESTONE\b|\bSANDSTONE\b|\bCALACAT+A\b|\bCRE?MA MARFIL\b|WINTER FROST|\bBIANCO\b|\bCARRARA\b|\bEMPERADOR\b|\bTHASSOS\b|ST\.? CROIX|BLACK SILK|\bAVERNI\b|\bMETRO\b|\bSTONE\b|\bPEBBLES?\b|\bFLUTIQUE\b|\bSTRUCTURE\b|\bLEDGER\b|\bEXTERO\b/i;

function decodeVendorSku(vsku) {
  if (!vsku) return {};
  const m = String(vsku).toUpperCase().match(/(\d{4,6})([A-Z]{1,3}\d?)?$/);
  if (!m) return {};
  const digits = m[1];
  const half = Math.floor(digits.length / 2);
  const w = parseInt(digits.slice(0, half), 10);
  const h = parseInt(digits.slice(half), 10);
  return { skuSize: `${w}x${h}`, suffix: m[2] || '' };
}

const TRIM_SUFFIXES = new Set(['SB', 'CB', 'CO', 'BN', 'JL', 'PE', 'CP']);

function classifySku(row) {
  const name = (row.pname || '').toUpperCase();
  const { suffix } = decodeVendorSku(row.vendor_sku);
  const isStone = /^M\d/.test(row.vendor_sku || '') ||
    STONE_COLL.test(normText(row.collection || '')) ||
    /\b(MARBLE|TRAVERTINE|GRANITE|SLATE|QUARTZITE|LIMESTONE)\b/.test(normText(name));
  if (/MOSAIC/.test(name) || (suffix && suffix.startsWith('MO'))) return isStone ? 'stone-mosaic' : 'mosaic';
  if (/\bSBN\b|BULLNOSE|COVE|JOLLY|PENCIL|CHAIR RAIL|\bCOPING\b|CORNER|MO[U]?LDING|END CAP|T-?MOULD|T-?MOLD|REDUCER|QUARTER ROUND|STAIR NOSE|STAIRNOSE|RISER|TRANSITION|FLUSH STAIR/.test(name) ||
      (suffix && TRIM_SUFFIXES.has(suffix))) return isStone ? 'stone-trim' : 'trim';
  return isStone ? 'stone' : 'field';
}

function dbTrimType(row) {
  const name = (row.pname || '').toUpperCase();
  const { suffix } = decodeVendorSku(row.vendor_sku);
  if (/\bSBN\b|BULLNOSE/.test(name) || suffix === 'SB') return 'SB';
  if (/COVE\s*BASE/.test(name) || suffix === 'CB') return 'CB';
  if (/COVE\s*CORNER|CORNER/.test(name) || suffix === 'CO') return 'CO';
  if (/JOLLY/.test(name) || suffix === 'JL') return 'JL';
  if (/COPING/.test(name) || suffix === 'CP') return 'CP';
  if (/PENCIL/.test(name) || suffix === 'PE') return 'PE';
  return null;
}

function dbFinish(row) {
  if (row.finish) return normText(row.finish).split(' ')[0];
  const name = (row.pname || '') + ' ' + (row.variant_name || '');
  const m = name.toUpperCase().match(/\b(MATTE|POLISHED|HONED|GLOSSY|GLOSS|SATIN|LAPPATO|BRUSHED|TUMBLED|CHISELED)\b/);
  if (m) return m[1];
  const tail = (row.vendor_sku || '').match(/\d([HP])$/);
  if (tail) return tail[1] === 'H' ? 'HONED' : 'POLISHED';
  return null;
}

// ─── Matching ────────────────────────────────────────────────────────────────

const report = {
  generated: new Date().toISOString(), pdf: PDF_PATH,
  repriced: [], unchanged: [], seriesMissing: [], unresolvedSeries: [],
  colorMissing: [], sizeMissing: [], trimColorMissing: [],
  trimUnmatched: [], mosaicUnmatched: [], stoneUnmatched: [],
  excluded: [], noAttrs: [], conflict: [],
};
const priceUpdates = [];

function queueReprice(row, brief, m) {
  let newCost = null, basis = row.price_basis, sellBy = row.sell_by;
  if (m.kind === 'field' || m.kind === 'stone') {
    if (m.unit === 'PC') { newCost = m.price; basis = 'per_unit'; sellBy = 'unit'; }
    else if (row.sell_by === 'unit' && row.price_basis === 'per_unit') {
      // per-piece stone/loose piece: cost = sqft rate x piece area if packaging known
      const spb = parseFloat(row.sqft_per_box || 0), ppb = parseFloat(row.pieces_per_box || 0);
      if (spb > 0 && ppb > 0) newCost = m.price * (spb / ppb);
      else { brief.reason = 'unit-sold field/stone sku without packaging'; report.conflict.push(brief); return; }
    } else { newCost = m.price; basis = 'per_sqft'; }
  } else if (m.kind === 'mosaic') {
    const spb = parseFloat(row.sqft_per_box || 0), ppb = parseFloat(row.pieces_per_box || 0);
    let sheetArea = null;
    if (spb > 0 && ppb > 0) sheetArea = spb / ppb;
    else if (spb > 0 && spb <= 2.5) sheetArea = spb; // packaging stored as per-sheet area
    if (row.sell_by === 'unit') {
      if (!sheetArea) { brief.reason = 'mosaic sheet area unknown'; report.conflict.push(brief); return; }
      newCost = m.price * sheetArea; basis = 'per_unit'; sellBy = 'unit';
    } else { newCost = m.price; basis = 'per_sqft'; }
  } else if (m.kind === 'trim') {
    newCost = m.price; basis = 'per_unit'; sellBy = 'unit';
  }
  if (newCost == null || !(newCost > 0)) return;
  newCost = Math.round(newCost * 100) / 100;
  const oldCost = row.cost != null ? parseFloat(row.cost) : null;
  const changed = oldCost == null || Math.abs(oldCost - newCost) > 0.005 ||
    basis !== row.price_basis || sellBy !== row.sell_by;
  const upd = { ...brief, kind: m.kind, newCost, newBasis: basis, newSellBy: sellBy, special: !!m.special };
  if (changed) { report.repriced.push(upd); priceUpdates.push({ row, upd }); }
  else report.unchanged.push(upd);
}

function fieldLookup(serList, color, size, finish, hay) {
  const transposed = size.replace(/^(\d+)x(\d+)$/, '$2x$1');
  const sizeCands = [size, ...(transposed !== size ? [transposed] : []), ...sizeNeighbors(size)];
  let sawConflict = false;
  for (const ser of serList) {
    if (finish) {
      const e = idx.field.get(`${ser}|${color}|${size}|${finish}`);
      if (e && !e.conflict) return e;
      if (e) sawConflict = true;
    }
    for (const sz of sizeCands) {
      const e = idx.field.get(`${ser}|${color}|${sz}`);
      if (e && !e.conflict) return e;
      if (e) sawConflict = true;
    }
  }
  // design/line-qualified PDF colors ("WHITE GLARE", "WINDSOR SUTTON"): match
  // when the DB color is one word of the PDF label and every other token
  // appears in the DB product/variant text
  if (hay) {
    for (const ser of serList) {
      const cands = (idx.seriesEntries.get(ser) || []).filter(e => {
        if (e.size !== size && e.size !== transposed) return false;
        const words = e.color.split(' ').filter(Boolean);
        if (!words.includes(color) || words.length < 2) return false;
        // multi-word DB colors: require whole-phrase containment instead
        if (color.includes(' ') && !e.color.includes(color)) return false;
        const rest = words.filter(w => !color.split(' ').includes(w));
        return rest.length > 0 && rest.every(t => hay.includes(t));
      });
      const uniquePrices = new Set(cands.map(c => c.price.toFixed(2)));
      if (cands.length && uniquePrices.size === 1) return cands[0];
      if (cands.length) sawConflict = true;
    }
  }
  // the item IS on the list but has multiple prices we can't disambiguate
  // (e.g. matte vs polished with no finish attr) — do NOT treat as discontinued
  return sawConflict ? 'CONFLICT' : null;
}
function stoneLookup(color, size, finish, collPrefix) {
  const variants = [color, stripStoneMaterial(color)];
  if (collPrefix && !color.startsWith(collPrefix + ' ')) variants.push(`${collPrefix} ${color}`);
  const seen = new Set();
  for (let i = variants.length - 1; i >= 0; i--) {
    if (!variants[i] || seen.has(variants[i])) variants.splice(i, 1);
    else seen.add(variants[i]);
  }
  for (const c of variants) {
    if (finish) { const e = idx.stone.get(`${c}|${size}|${finish}`); if (e && !e.conflict) return e; }
  }
  for (const c of variants) {
    const e = idx.stone.get(`${c}|${size}`);
    if (e && !e.conflict && (!finish || !e.finish || e.finish === finish)) return e;
  }
  for (const c of variants) for (const nb of sizeNeighbors(size)) {
    const key = finish ? `${c}|${nb}|${finish}` : `${c}|${nb}`;
    const e = idx.stone.get(key);
    if (e && !e.conflict) return e;
  }
  return null;
}

for (const row of skus) {
  const brief = {
    sku_id: row.sku_id, vendor_sku: row.vendor_sku, product: row.pname, collection: row.collection,
    variant: row.variant_name, color: row.color, size: row.size, finish: row.finish,
    sell_by: row.sell_by, basis: row.price_basis, cost: row.cost != null ? parseFloat(row.cost) : null,
    retail: row.retail_price != null ? parseFloat(row.retail_price) : null,
  };
  if (EXCLUDED_COLL.test(row.collection || '') || EXCLUDED_COLL.test(row.pname || '')) {
    report.excluded.push(brief); continue;
  }

  const kind = classifySku(row);
  brief.kind = kind;
  const { skuSize } = decodeVendorSku(row.vendor_sku);
  const color = cleanColor(row.color || '').color;
  const size = normSizeKey(row.size || skuSize || '');
  const finish = dbFinish(row);

  // ── Stone: series-agnostic color index; never dropped ──
  if (kind.startsWith('stone')) {
    const collPrefix = normSeries(row.collection);
    let cand = null;
    if (color && size) cand = stoneLookup(color, size, finish, collPrefix);
    if (!cand && row.variant_name) {
      const vc = cleanColor(String(row.variant_name).replace(/\d+x\d+/ig, ' ')).color;
      if (vc && size) cand = stoneLookup(vc, size, finish, collPrefix);
    }
    if (cand) queueReprice(row, brief, { kind: 'stone', price: cand.price, unit: cand.unit, special: cand.special });
    else report.stoneUnmatched.push(brief);
    continue;
  }

  // ── Resolve series ──
  const collNorm = normSeries(row.collection);
  let ser = resolveSeriesName(collNorm);
  if (!ser) {
    const pnameNorm = normSeries(row.pname);
    ser = resolveSeriesName(pnameNorm);
    if (!ser) {
      for (const s of idx.seriesSet) {
        if (pnameNorm.startsWith(s + ' ')) { ser = s; break; }
      }
    }
  }
  if (!ser) {
    if (collectionInPdfText(collNorm)) report.unresolvedSeries.push(brief);
    else report.seriesMissing.push(brief);
    continue;
  }
  brief.series = ser;
  const serList = seriesChain(ser);
  const colors = unionColors(serList);

  if (kind === 'trim') {
    // color left the series -> trim goes with it. A PDF color whose FIRST word
    // matches counts as present (trims share base colors: "GRAY RIVER" covers GRAY,
    // "WHITE LG SPECKLE" covers WHITE).
    const colorPresent = !color || colors.size === 0 ||
      colors.has(color) ||
      [...colors].some(c => c.split(' ')[0] === color.split(' ')[0]);
    if (!colorPresent) { report.trimColorMissing.push(brief); continue; }
    const ttype = dbTrimType(row);
    const tsize = normSizeKey(skuSize || row.size || '');
    const cands = serList.flatMap(s => idx.trims.get(s) || []);
    let best = cands.find(t => t.typeCode === ttype && t.size === tsize) ||
      cands.find(t => t.typeCode === ttype && t.size && sizeNeighbors(tsize).includes(t.size)) || null;
    if (!best && cands.length === 1 && (!cands[0].typeCode || cands[0].typeCode === ttype)) best = cands[0];
    if (best) {
      const finishCands = cands.filter(t => t.typeCode === best.typeCode && t.size === best.size);
      if (finishCands.length > 1 && finish) {
        const fm = finishCands.find(t => t.finish && t.finish === finish);
        if (fm) best = fm; else { report.trimUnmatched.push(brief); continue; }
      }
      queueReprice(row, brief, { kind: 'trim', price: best.price, special: best.special });
    } else report.trimUnmatched.push(brief);
    continue;
  }

  if (kind === 'mosaic') {
    const mos = serList.flatMap(s => idx.mosaics.get(s) || []);
    if (!mos.length) { report.mosaicUnmatched.push(brief); continue; }
    const hayU = normText(`${row.pname} ${row.variant_name || ''} ${row.size || ''}`).replace(/\s/g, '');
    const sizeTokens = normText(row.size || '').split(/[\s\/]+/).filter(Boolean);
    let best = null;
    // 1) decorative mosaics list COLORS as rows — match on the SKU color
    if (color) {
      let cc = mos.filter(m => m.color === color);
      if (cc.length > 1 && finish) { const f = cc.filter(m => !m.finish || m.finish === finish); if (f.length) cc = f; }
      if (cc.length > 1 && sizeTokens.length) { const f = cc.filter(m => m.size && sizeTokens.includes(m.size)); if (f.length) cc = f; }
      if (cc.length && new Set(cc.map(m => m.price.toFixed(2))).size === 1) best = cc[0];
    }
    // 2) pattern mosaics ("MOSAIC 2X2 SOLID"): shape/size token scoring
    if (!best) {
      if (mos.length === 1) best = mos[0];
      else {
        const scored = mos.map(m => {
          const tokens = m.label.match(/(\d+\s?X\s?\d+|PENNY|HEXAGON|HEX|HERRINGBONE|CHEVRON|PICKET|LANTERN|STACK|OFFSET|WAVE|TRELLIS|BRICK|LINEAR|ARC|CUPULA|TUBE)/g) || [];
          const hits = tokens.filter(t => hayU.includes(t.replace(/\s/g, ''))).length;
          return { m, hits };
        }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);
        if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) best = scored[0].m;
        else if (finish) {
          const fm = mos.filter(m => m.finish === finish);
          if (fm.length === 1) best = fm[0];
        }
      }
    }
    if (!best) { report.mosaicUnmatched.push(brief); continue; }
    queueReprice(row, brief, { kind: 'mosaic', price: best.price, special: best.special });
    continue;
  }

  // ── Field tile ──
  if (!color || !size) { report.noAttrs.push(brief); continue; }
  const hay = normText(`${row.pname} ${row.variant_name || ''}`);
  const fieldItemCount = serList.reduce((a, s) => a + (idx.seriesEntries.get(s) || []).length, 0);
  if (fieldItemCount === 0) { report.unresolvedSeries.push(brief); continue; } // series parsed empty — can't judge
  const entry = fieldLookup(serList, color, size, finish, hay);
  if (entry === 'CONFLICT') { brief.reason = 'on list, ambiguous price'; report.conflict.push(brief); continue; }
  if (entry) { queueReprice(row, brief, { kind: 'field', price: entry.price, unit: entry.unit, special: entry.special }); continue; }
  if (colors.size > 0 && !colors.has(color)) report.colorMissing.push(brief);
  else report.sizeMissing.push(brief);
}

// ─── Summary + report ────────────────────────────────────────────────────────

const sum = Object.fromEntries(Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
console.log('\nBuckets:', JSON.stringify(sum, null, 2));

const bySeries = {};
for (const b of report.seriesMissing) { const k = b.collection || b.product; bySeries[k] = (bySeries[k] || 0) + 1; }
const topMissing = Object.entries(bySeries).sort((a, b) => b[1] - a[1]);
console.log(`\nseriesMissing (droppable) spans ${topMissing.length} collections; top 40:`);
for (const [k, n] of topMissing.slice(0, 40)) console.log(`  ${n}\t${k}`);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(DATA_DIR, `emser-q1-2026-report-${ts}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log(`\nReport: ${reportPath}`);

// ─── Apply prices ────────────────────────────────────────────────────────────

if (APPLY_PRICES && priceUpdates.length) {
  const backup = priceUpdates.map(({ row }) => ({
    sku_id: row.sku_id, vendor_sku: row.vendor_sku, cost: row.cost, retail_price: row.retail_price,
    price_basis: row.price_basis, sell_by: row.sell_by,
  }));
  const bpath = path.join(DATA_DIR, `emser-q1-2026-pricing-backup-${ts}.json`);
  fs.writeFileSync(bpath, JSON.stringify(backup, null, 1));
  console.log(`Pricing backup: ${bpath}`);

  let done = 0;
  for (const { row, upd } of priceUpdates) {
    if (upd.newSellBy !== row.sell_by) {
      await pool.query(`UPDATE skus SET sell_by=$1, updated_at=NOW() WHERE id=$2`, [upd.newSellBy, row.sku_id]);
    }
    // retail passed at 2x -> upsertPricing keystone guard rewrites to 1.6x + nine-ending
    await upsertPricing(pool, row.sku_id, {
      cost: upd.newCost,
      retail_price: Math.round(upd.newCost * 2 * 100) / 100,
      price_basis: upd.newBasis,
    }, { coveringFloor: upd.kind === 'mosaic' && upd.newSellBy === 'unit' });
    done++;
    if (done % 500 === 0) console.log(`  repriced ${done}/${priceUpdates.length}`);
  }
  console.log(`Applied ${done} price updates.`);
}

// ─── Apply drops ─────────────────────────────────────────────────────────────

if (APPLY_DROPS) {
  const drops = [...report.seriesMissing, ...report.colorMissing, ...report.sizeMissing, ...report.trimColorMissing];
  const ids = drops.map(d => d.sku_id);
  const bpath = path.join(DATA_DIR, `emser-q1-2026-drops-backup-${ts}.json`);
  fs.writeFileSync(bpath, JSON.stringify(drops, null, 1));
  console.log(`Drops backup: ${bpath} (${ids.length} SKUs)`);

  const CHUNK = 500;
  let n = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await pool.query(`UPDATE skus SET status='inactive', updated_at=NOW() WHERE id = ANY($1)`, [ids.slice(i, i + CHUNK)]);
    n += r.rowCount;
  }
  console.log(`Deactivated ${n} SKUs.`);
  const pr = await pool.query(`
    UPDATE products p SET status='inactive', is_active=false, updated_at=NOW()
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE code='EMS')
      AND p.status='active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id AND s.status='active')`);
  console.log(`Deactivated ${pr.rowCount} now-empty products.`);
}

await pool.end();
