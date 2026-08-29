/**
 * daltile-crosswalk-grow.mjs — extend daltile_edi_map to price the unpriced-but-in-EDI SKUs.
 *
 * Context: ~593 active Daltile SKUs render priceless (call-for-pricing) because they were
 * never crosswalked to the EDI feed. A feed check (daltile-593-edi-check.mjs) showed 466
 * aren't in the 832 at all (slabs/quartz/porcelain-slab — quote items, left unpriced by
 * design) and the rest share a line+color stem. But stem-presence alone is a FALSE signal:
 * the feed often carries a different shape/format under the same line+color (Armor stems →
 * only a Jolly trim; granite slab stems → only cut tiles; Marble Attache → only field tile;
 * Color Wheel → only penny, not hex). So this matcher requires SHAPE + FINISH + SIZE
 * agreement and a clean 1:1 EDI survivor, else it leaves the SKU unpriced.
 *
 * For each 1:1 match it (mirrors daltile-crosswalk-backfill.mjs + the overlay's conventions):
 *   - inserts the daltile_edi_map row (live_vendor_sku → edi_vendor_sku)
 *   - cost = EDI cost; retail = nine-ending round-down of cost x1.6 (platform convention,
 *     matches the visible mapped catalog; respects retail_locked)
 *   - uom SF/SY → sell_by=box, price_basis=per_sqft, packaging.sqft_per_box from EDI
 *     else (PC/PK/EA/LF) → sell_by=unit, price_basis=per_unit
 * Because cost is set to the exact EDI cost, the nightly daltile-edi-overlay sees no change
 * and leaves these rows alone (idempotent). SKUs stay active. Slab/quote items untouched.
 *
 *   docker compose exec api node scripts/daltile-crosswalk-grow.mjs           # dry run
 *   docker compose exec api node scripts/daltile-crosswalk-grow.mjs --apply   # write
 */
import fs from 'fs';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
const { parse832 } = __test__;

const DAL = '550e8400-e29b-41d4-a716-446655440003';
const KEYSTONE = 1.6;
const APPLY = process.argv.includes('--apply');
const round2 = (n) => Math.round(n * 100) / 100;
// retail: round DOWN to nearest .x9 (platform nine-ending convention)
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;

// ── attribute decoders (semantic, format-agnostic; reused from validated matcher) ──
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

// ── fetch + parse current (non-archive) 832 feed ──
async function fetchEdiItems(ediConfig) {
  const ftp = await createFtpConnection(ediConfig);
  try {
    const files = (await findRemote832Files(ftp)).filter((f) => !/archive/i.test(f.remotePath));
    const items = [];
    for (const f of files) {
      const local = '/tmp/dal-grow-' + f.name;
      await ftp.downloadTo(local, f.remotePath);
      try { items.push(...parse832(fs.readFileSync(local, 'utf-8')).items); } catch (e) { console.error('parse fail', f.name, e.message); }
      try { fs.unlinkSync(local); } catch {}
    }
    console.log(`feed files: ${files.length}`);
    return items;
  } finally { try { ftp.close(); } catch {} }
}

const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const items = await fetchEdiItems(cfg);
const priced = items.filter((it) => it.vendor_sku && it.cost != null && it.cost > 0);
console.log(`parsed ${items.length} EDI items | ${priced.length} priced`);

const byStem = new Map();
for (const it of priced) { const st = stem(it.vendor_sku); if (!st) continue; (byStem.get(st) || byStem.set(st, []).get(st)).push(it); }

// unpriced active Daltile SKUs not already mapped
const live = (await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, p.name, COALESCE(s.variant_name,'') variant, c.name category, s.sell_by
  FROM products p JOIN skus s ON s.product_id=p.id
  LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.vendor_id=$1 AND s.status='active' AND pr.retail_price IS NULL
    AND NOT EXISTS (SELECT 1 FROM daltile_edi_map m WHERE m.live_vendor_sku=s.vendor_sku)
  ORDER BY c.name, s.vendor_sku`, [DAL])).rows;

const matched = [], skipped = [];
for (const r of live) {
  const st = stem(r.vendor_sku);
  const cands = st ? (byStem.get(st) || []) : [];
  if (!cands.length) { skipped.push({ r, why: 'ABSENT (no stem in feed)' }); continue; }
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
  if (survivors.length === 1) matched.push({ r, edi: survivors[0] });
  else skipped.push({ r, why: survivors.length === 0 ? 'no shape/finish/size match' : `${survivors.length} candidates (ambiguous)` });
}

const grp = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
console.log(`\nMATCHED ${matched.length} | SKIPPED ${skipped.length} (of ${live.length} unmapped-unpriced)`);
console.log('matched by category:', JSON.stringify(grp(matched, (m) => m.r.category)));
console.log('skip reasons:', JSON.stringify(grp(skipped, (s) => s.why)));

// compute pricing per match
const plan = matched.map(({ r, edi }) => {
  const uom = (edi.unit_of_measure || edi.uom || '').toUpperCase();
  const perSqft = uom === 'SF' || uom === 'SY';
  const cost = round2(edi.cost);
  return {
    sku_id: r.sku_id, live: r.vendor_sku, edi: edi.vendor_sku, name: r.name, variant: r.variant,
    cost, retail: nineEnding(cost * KEYSTONE), uom,
    sell_by: perSqft ? 'box' : 'unit', basis: perSqft ? 'per_sqft' : 'per_unit',
    sqft_per_box: perSqft && edi.sqft_per_box > 0 ? edi.sqft_per_box : null,
    method: `grow:${shapeOf(r.variant + ' ' + r.name) || 'stem'}+finish+size`,
  };
});

console.log('\n=== PLAN (all matches) ===');
for (const p of plan) console.log(`  ${p.live} → ${p.edi} | ${p.name} ${p.variant} | $${p.cost}/${p.uom} → retail $${p.retail} | ${p.sell_by}/${p.basis} spb=${p.sqft_per_box}`);

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }

const client = await pool.connect();
let n = 0;
try {
  await client.query('BEGIN');
  for (const p of plan) {
    await client.query(
      `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
       VALUES ($1,$2,'high',$3)
       ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
      [p.live, p.edi, p.method]);
    await client.query(
      `INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, price_basis=EXCLUDED.price_basis,
         retail_price=CASE WHEN pricing.retail_locked THEN pricing.retail_price ELSE EXCLUDED.retail_price END`,
      [p.sku_id, p.cost, p.retail, p.basis]);
    await client.query(`UPDATE skus SET sell_by=$2, updated_at=now() WHERE id=$1`, [p.sku_id, p.sell_by]);
    if (p.sqft_per_box) {
      await client.query(
        `INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
         ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=COALESCE(packaging.sqft_per_box, EXCLUDED.sqft_per_box)`,
        [p.sku_id, p.sqft_per_box]);
    }
    n++;
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
console.log(`\nAPPLIED: mapped + priced ${n} SKUs.`);

const prods = (await pool.query(
  `SELECT DISTINCT p.id FROM products p JOIN skus s ON s.product_id=p.id WHERE s.id = ANY($1)`,
  [plan.map((p) => p.sku_id)])).rows;
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.id]).catch(() => {});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
