/**
 * daltile-crosswalk-verify-2026-09.mjs — verify the PRICED-but-unmapped Daltile catalog
 * against the live 832 feed.
 *
 * Context: ~3.9K priced active Daltile SKUs are not in daltile_edi_map — their prices
 * are 2026-04 import artifacts nothing re-verifies (the feed renamed most codes). That
 * class hid both the cheap-mosaic bug (40 SKUs at 1/10th price) and the Multimedia bug
 * (26 SKUs at 4.5x). daltile-crosswalk-grow.mjs only targets UNPRICED SKUs; this is the
 * same shape+finish+size 1:1 matcher pointed at the priced ones, producing a cost-delta
 * report instead of blind writes.
 *
 * Buckets (delta = |live cost − feed-implied cost| / feed-implied cost):
 *   agree   ≤10%  — same price; mapping is free maintenance (overlay keeps it current)
 *   drift   10–30% — Daltile list moved since April; mapping applies the update
 *   suspect >30%  — possible wrong match OR a real mispricing — CSV for manual review
 *   basis-conflict — live sells per_sqft but feed quotes PC/EA (or vice versa outside
 *                    the per-sheet mosaic rule) — the Multimedia bug class, manual review
 * Per-sheet mosaics compare against feed $/SF × sheet coverage (deriveSheetSqft).
 *
 *   node scripts/daltile-crosswalk-verify-2026-09.mjs                # report only
 *   node scripts/daltile-crosswalk-verify-2026-09.mjs --apply-agree  # map the agree bucket
 *   node scripts/daltile-crosswalk-verify-2026-09.mjs --apply-agree --apply-drift
 * After applying, run: node run-scraper.cjs daltile-edi-overlay
 * CSV report: backend/data/daltile-crosswalk-verify-<bucket counts in stdout>.csv
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
import { deriveSheetSqft } from '../scrapers/base.js';

const { parse832 } = __test__;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const APPLY_AGREE = process.argv.includes('--apply-agree');
const APPLY_DRIFT = process.argv.includes('--apply-drift');
const APPLY_SUSPECT = process.argv.includes('--apply-suspect');

// ── manual review results (2026-09-04) for the suspect bucket ──
// False matches identified by reading the codes: size mismatches (RCT624→RCT1224,
// S36C9→S44C9, 24x24→2x3HEX), J1/J/V suffixes (Daltile value-grade variants, not
// the same item), RDG (ridge décor vs field), and trims matched across profiles.
// Excluded rows stay in the CSV for future review; everything else in suspect was
// verified against the rename families hand-checked in the mosaic/Multimedia fixes.
const SUSPECT_EXCLUDE_COLLECTIONS = new Set([
  'Harmonist', 'Haddonstone', 'Theoretical Evolved', 'Neoconcrete', 'Calgary',
  'Advantage', 'Archaia', 'Bryne', 'Prime', 'Delegate', 'Platinum', 'Bellamy Place',
  'Stacked Stone', // handled via HAND_MAPPINGS (matcher hit the CORNER piece)
]);
const SUSPECT_EXCLUDE_SKUS = new Set([
  'L725RCT1224HN',   // 12x24 field matched to a 4x20 raked mosaic
  'CT322424MZ1L',    // Marazzi 24x24 matched to a 2x3 hex mosaic
  'AR06S1/212JMT', 'AR07S1/212JMT', 'AR09S1/212JMT', // 1/2x12 jolly matched to P43F9 profile
]);

// Feed-confirmed exact renames the fuzzy matcher missed or mismatched:
// porcelain stair treads insert "XTP" (AM331224C6TX → AM33XTP1224C6TX), and the
// 6x24 stacked-stone FLATS live under ...624STACK1T (the matcher hit CORNER1T).
const HAND_MAPPINGS = {
  AM331224C6TX: 'AM33XTP1224C6TX', AM341224C6TX: 'AM34XTP1224C6TX',
  AM331624STX: 'AM33XTP1624STX', AM341624STX: 'AM34XTP1624STX',
  LB171224C6MT: 'LB17XTP1224C6MT', LB171224SMT: 'LB17XTP1224S',
  NM101224C6MT: 'NM10XTP1224C6MT', NM111224C6MT: 'NM11XTP1224C6MT', NM121224C6MT: 'NM12XTP1224C6MT',
  NM101224SMT: 'NM10XTP1224S', NM111224SMT: 'NM11XTP1224S', NM121224SMT: 'NM12XTP1224S',
  S282RCT624NC: 'S282624STACK1T', S317RCT624NC: 'S317624STACK1T',
  S349RCT624NC: 'S349624STACK1T', S701RCT624NC: 'S701624STACK1T',
};
// Stacked-stone 6x24 panels are exactly 1 sqft each; the overlay needs
// pieces_per_box to derive that (spb alone exceeds the single-sheet cap).
// Covers the four above plus the S703/DS61 pairs mapped 2026-09-03 that the
// overlay skips as sheet-coverage-unknown today.
const STACKED_PANEL_SKUS = [
  'S282RCT624NC', 'S317RCT624NC', 'S349RCT624NC', 'S701RCT624NC',
  'S703RCT624NC', 'S703STK624NC', 'DS61RCT624NC', 'DS61STK624NC',
];

// ── attribute decoders (copied from daltile-crosswalk-grow.mjs — keep in sync) ──
const stem = (c) => { const m = (c || '').toUpperCase().match(/^([A-Z]{1,3}\d{2,3})/); return m ? m[1] : null; };
const SHAPES = [
  ['plank', /plank/i], ['penny', /penny|pnyrd|\bpny\b/i], ['hexagon', /hex/i],
  ['herringbone', /herringbone|hrbn/i], ['arabesque', /arabesque/i], ['picket', /picket/i],
  ['chevron', /chevron/i], ['basketweave', /basketweave/i], ['pinwheel', /pinwheel/i],
  ['pattern', /pattern|\bpatt\b/i], ['bullnose', /bullnose|\bbn\b/i], ['jolly', /jolly/i],
  ['stairnose', /stair\s*nose|stair\s*tread|\bsn\b/i], ['quarterround', /quarter\s*round|qrtr|qrnd/i],
  ['pencil', /pencil/i], ['chairrail', /chair\s*rail/i], ['dot', /\bdot\b/i], ['cove', /\bcove\b/i],
  ['slab', /slab/i], ['square', /square|\bsqu\b/i], ['rectangle', /rectangle|\brct\b/i],
];
const shapeOf = (t) => { for (const [k, re] of SHAPES) if (re.test(t || '')) return k; return null; };
const finOf = (t) => {
  const s = (t || '').toLowerCase();
  if (/glossy|gloss|\bgl\b/.test(s)) return 'gl';
  if (/matte|\bmt\b/.test(s)) return 'mt';
  if (/polished|\bpl\b/.test(s)) return 'pl';
  if (/honed|\bhn\b/.test(s)) return 'hn';
  if (/satin|\bst\b/.test(s)) return 'st';
  if (/textured|structured|\bsx\b|\btx\b/.test(s)) return 'sx';
  if (/flamed|\bfl\b/.test(s)) return 'fl';
  return null;
};
const sizeOf = (t) => {
  const s = (t || '').toLowerCase().replace(/\s+/g, ''); const out = new Set();
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)x(free|\d+(?:\.\d+)?)/g)) out.add(`${m[1]}x${m[2]}`);
  return out;
};
const sizeEDIfromCode = (code) => {
  const s = (code || '').toUpperCase(); const out = new Set();
  if (/9FR|9XFREE/.test(s)) out.add('9xfree');
  if (/8FL|8XFREE|8FLPATT/.test(s)) out.add('8xfree');
  const m = s.match(/R9(72|48|60)/); if (m) out.add(`9x${m[1]}`);
  return out;
};
const round2 = (n) => Math.round(n * 100) / 100;

// ── fetch feed, newest file wins, reconnect+retry (Daltile FTP resets sockets) ──
const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const byEdiSku = new Map();
{
  let ftp = await createFtpConnection(cfg);
  try {
    const files = (await findRemote832Files(ftp))
      .filter((f) => !/archive/i.test(f.remotePath))
      .sort((a, b) => (a.modifiedAt?.getTime?.() || 0) - (b.modifiedAt?.getTime?.() || 0));
    for (const f of files) {
      const local = '/tmp/dal-verify-' + f.name;
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try { await ftp.downloadTo(local, f.remotePath); ok = true; }
        catch (e) {
          console.error(`download ${f.name} attempt ${attempt}: ${e.message}`);
          try { ftp.close(); } catch {}
          ftp = await createFtpConnection(cfg);
        }
      }
      if (!ok) { console.error(`SKIPPING ${f.name} after 3 attempts`); continue; }
      try {
        for (const it of parse832(fs.readFileSync(local, 'utf-8')).items) {
          if (it.vendor_sku && it.cost > 0) byEdiSku.set(it.vendor_sku.toUpperCase(), it);
        }
      } catch (e) { console.error('parse fail', f.name, e.message); }
      try { fs.unlinkSync(local); } catch {}
    }
  } finally { try { ftp.close(); } catch {} }
}
const byStem = new Map();
for (const it of byEdiSku.values()) {
  const st = stem(it.vendor_sku); if (!st) continue;
  (byStem.get(st) || byStem.set(st, []).get(st)).push(it);
}
console.log(`feed: ${byEdiSku.size} priced EDI items, ${byStem.size} stems`);

// priced active unmapped Daltile SKUs
const live = (await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, p.name, COALESCE(s.variant_name,'') variant, p.collection,
         c.slug category, s.sell_by, s.variant_type, pr.cost, pr.retail_price, pr.price_basis,
         pk.sqft_per_box pk_spb, pk.pieces_per_box pk_ppb
  FROM products p JOIN skus s ON s.product_id=p.id
  JOIN pricing pr ON pr.sku_id=s.id
  LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN packaging pk ON pk.sku_id=s.id
  WHERE p.vendor_id=$1 AND s.status='active' AND p.status='active'
    AND pr.retail_price > 0
    AND NOT EXISTS (SELECT 1 FROM daltile_edi_map m WHERE m.live_vendor_sku=s.vendor_sku)
  ORDER BY c.slug, s.vendor_sku`, [DAL])).rows;
console.log(`live: ${live.length} priced active unmapped SKUs`);

const buckets = { agree: [], drift: [], suspect: [], basisConflict: [], sheetUnknown: [] };
let absent = 0, ambiguous = 0, exact = 0;
for (const r of live) {
  // exact code match beats fuzzy
  let edi = byEdiSku.get(r.vendor_sku.toUpperCase());
  if (edi) exact++;
  if (!edi) {
    const st = stem(r.vendor_sku);
    const cands = st ? (byStem.get(st) || []) : [];
    if (!cands.length) { absent++; continue; }
    const lShape = shapeOf(r.variant + ' ' + r.name), lFin = finOf(r.variant), lSize = sizeOf(r.variant);
    const survivors = cands.filter((it) => {
      const blob = (it.product_name || '') + ' ' + (it.color || '') + ' ' + it.vendor_sku;
      const eShape = shapeOf(blob);
      if (lShape && eShape && lShape !== eShape) return false;
      if (lShape && !eShape) return false;
      const eFin = finOf(it.color || blob);
      if (lFin && eFin && lFin !== eFin) return false;
      const eSize = new Set([...sizeOf(blob), ...sizeEDIfromCode(it.vendor_sku)]);
      if (lSize.size && eSize.size && ![...lSize].some((z) => eSize.has(z))) return false;
      return true;
    });
    if (survivors.length !== 1) { ambiguous++; continue; }
    edi = survivors[0];
  }

  const uom = (edi.unit_of_measure || '').toUpperCase();
  const feedPerSqft = uom === 'SF' || uom === 'SY';
  const livePerSqft = r.price_basis === 'per_sqft' || r.price_basis === 'sqft';
  const isSheetRow = !livePerSqft && (r.category === 'mosaic-tile' || r.category === 'stacked-stone')
    && r.variant_type !== 'accessory';
  let expected;
  if (livePerSqft && feedPerSqft) expected = edi.cost;
  else if (isSheetRow && feedPerSqft) {
    const sheetSqft = deriveSheetSqft(r.pk_spb, r.pk_ppb) || deriveSheetSqft(edi.sqft_per_box, edi.pieces_per_box);
    if (!sheetSqft) { buckets.sheetUnknown.push({ r, edi }); continue; }
    expected = round2(edi.cost * sheetSqft);
  } else if (!livePerSqft && !feedPerSqft) expected = edi.cost;
  else { buckets.basisConflict.push({ r, edi, uom }); continue; }

  const delta = Math.abs(Number(r.cost) - expected) / expected;
  const row = { r, edi, expected: round2(expected), delta };
  if (delta <= 0.10) buckets.agree.push(row);
  else if (delta <= 0.30) buckets.drift.push(row);
  else buckets.suspect.push(row);
}

console.log(`\nmatched: ${buckets.agree.length + buckets.drift.length + buckets.suspect.length} `
  + `(${exact} by exact code) | agree ${buckets.agree.length} | drift ${buckets.drift.length} `
  + `| suspect ${buckets.suspect.length} | basis-conflict ${buckets.basisConflict.length} `
  + `| sheet-unknown ${buckets.sheetUnknown.length} | absent ${absent} | ambiguous ${ambiguous}`);

// CSV report of everything that needs eyes or would change price
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lines = ['bucket,category,collection,live_sku,edi_sku,edi_uom,live_cost,expected_cost,delta_pct,retail,name,variant'];
for (const [bucket, rows] of Object.entries(buckets)) {
  for (const x of rows) {
    lines.push([bucket, x.r.category, x.r.collection, x.r.vendor_sku, x.edi.vendor_sku,
      (x.edi.unit_of_measure || ''), x.r.cost, x.expected ?? '', x.delta != null ? Math.round(x.delta * 100) : '',
      x.r.retail_price, x.r.name, x.r.variant].map(esc).join(','));
  }
}
const csvPath = path.join(__dirname, '..', 'data', 'daltile-crosswalk-verify-2026-09.csv');
fs.writeFileSync(csvPath, lines.join('\n'));
console.log(`report: ${csvPath} (${lines.length - 1} rows)`);

const suspectReviewed = buckets.suspect.filter((x) =>
  !SUSPECT_EXCLUDE_COLLECTIONS.has(x.r.collection) && !SUSPECT_EXCLUDE_SKUS.has(x.r.vendor_sku));
if (APPLY_SUSPECT) {
  console.log(`suspect bucket after manual-review exclusions: ${suspectReviewed.length} of ${buckets.suspect.length}`);
}
const toApply = [
  ...(APPLY_AGREE ? buckets.agree.map((x) => ({ ...x, tag: 'agree' })) : []),
  ...(APPLY_DRIFT ? buckets.drift.map((x) => ({ ...x, tag: 'drift' })) : []),
  ...(APPLY_SUSPECT ? suspectReviewed.map((x) => ({ ...x, tag: 'suspect-reviewed' })) : []),
];
if (!toApply.length && !APPLY_SUSPECT) { console.log('\n(no --apply-* flags — report only)'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const x of toApply) {
    await client.query(
      `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
       VALUES ($1,$2,'high',$3)
       ON CONFLICT (live_vendor_sku) DO NOTHING`,
      [x.r.vendor_sku, x.edi.vendor_sku, `verify:${x.tag}+shape+finish+size`]);
  }
  if (APPLY_SUSPECT) {
    // feed-confirmed exact renames the matcher missed (treads, stacked flats)
    let hand = 0;
    for (const [liveSku, ediSku] of Object.entries(HAND_MAPPINGS)) {
      if (!byEdiSku.has(ediSku.toUpperCase())) { console.log(`  hand-map skip ${liveSku}: ${ediSku} not in feed`); continue; }
      await client.query(
        `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
         VALUES ($1,$2,'high','verify:hand-2026-09-04')
         ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
        [liveSku, ediSku]);
      hand++;
    }
    // 6x24 stacked-stone panels are 1 sqft each — give the overlay a derivable
    // sheet size (pieces_per_box = sqft_per_box) so it stops skipping them
    const { rowCount } = await client.query(
      `UPDATE packaging pk SET pieces_per_box = ROUND(pk.sqft_per_box)
       FROM skus s WHERE s.id = pk.sku_id AND s.vendor_sku = ANY($1)
         AND pk.pieces_per_box IS NULL AND pk.sqft_per_box > 0`, [STACKED_PANEL_SKUS]);
    const missingPk = (await client.query(
      `SELECT s.id FROM skus s LEFT JOIN packaging pk ON pk.sku_id = s.id
       WHERE s.vendor_sku = ANY($1) AND pk.sku_id IS NULL`, [STACKED_PANEL_SKUS])).rows;
    for (const r of missingPk) {
      await client.query(
        `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1, 4, 4) ON CONFLICT (sku_id) DO NOTHING`, [r.id]);
    }
    console.log(`hand-mapped ${hand}; stacked-panel packaging fixed ${rowCount + missingPk.length}`);
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
console.log(`\nAPPLIED ${toApply.length} matched map rows. Now run: node run-scraper.cjs daltile-edi-overlay`);
await pool.end();
