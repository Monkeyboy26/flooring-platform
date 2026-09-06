/**
 * fix-daltile-cw-glossy-trim-smear-2026-09.mjs — Daltile Color Wheel Classic
 * GLOSSY trim pieces carry the color's FIELD-TILE per-SF rate as their
 * "per-piece" cost (2026-04 import artifact; found while rooting out the
 * per-each/per-box sweep, owner 2026-09-05).
 *
 * The basis is correct — Daltile quotes trim PC in the 832 (S4269 = 2x6
 * surface bullnose, A4200 = radius bullnose, SCL/SCR = cove corners) — but one
 * number per color was smeared across every glossy trim shape: Arctic White
 * 2x6 bullnose stored at $4.50/pc vs the feed's true $1.37/pc (3.3x over),
 * while its cove corners' true cost is $5.50/pc (stored retail $3.09 on K175
 * corners is BELOW true cost). The matte twins (0790/K775/…) have per-shape
 * prices and are fine.
 *
 * Detection: per Color Wheel Classic product, per_unit trim SKUs whose stored
 * cost equals a field-tile per-SF rate of the same product (±$0.02). Truth:
 * the cached 832 feed (/tmp/dal-feed-priced.json — run
 * scripts/daltile-feed-cache.mjs first); live SKU → EDI SKU by stripping the
 * GL finish suffix and appending the price-group suffix 1P1/1P2. Repriced rows
 * get a daltile_edi_map entry so daltile-edi-overlay keeps them current, and
 * their borrowed field-box packaging (12.5 sf/box) is nulled — the feed has no
 * box data for PC trim.
 *
 * Idempotent (repriced rows no longer match the smear signature).
 * Dry-run unless --apply.
 */
import fs from 'fs';
import { pool } from '../db.js';
import { upsertPricing } from '../scrapers/base.js';

const APPLY = process.argv.includes('--apply');
const FEED_PATH = process.argv.find((a) => a.startsWith('--feed='))?.split('=')[1]
  || '/tmp/dal-feed-priced.json';
const r2 = (v) => Math.round(v * 100) / 100;

const feed = new Map(
  JSON.parse(fs.readFileSync(FEED_PATH, 'utf-8'))
    .filter((it) => it.cost > 0)
    .map((it) => [it.vendor_sku.toUpperCase(), it]));
console.log(`feed: ${feed.size} priced EDI items from ${FEED_PATH}`);

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type, p.id AS product_id,
         p.name AS product, pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked,
         pk.sqft_per_box, pk.pieces_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE v.code = 'DAL' AND s.status = 'active'
    AND p.name ILIKE 'Daltile Color Wheel Classic%'`);

// Feed-sync EVERY glossy per_unit CW trim: the 2026-04 smear hit the glossy
// set unevenly (K111/0190 exactly at the field rate, K175 at $1.97 vs field
// $2.00, 0180 against a stale rate), so signature-matching under-catches.
// Repricing TO the feed's PC cost is safe to over-apply — correct rows are
// no-ops. Matte twins keep their per-shape prices (real source, verified).
const reprice = [], unmatched = [], ambiguous = [];
for (const s of rows) {
  if (s.price_basis !== 'per_unit' || !(s.cost > 0)) continue;
  if (!/GL$/i.test(s.vendor_sku)) continue; // glossy set only
  const base = s.vendor_sku.toUpperCase().replace(/GL$/, '');
  const hit1 = feed.get(`${base}1P1`), hit2 = feed.get(`${base}1P2`);
  if (hit1 && hit2 && Math.abs(hit1.cost - hit2.cost) > 0.02 * hit1.cost) {
    ambiguous.push({ ...s, c1: hit1.cost, c2: hit2.cost });
    continue;
  }
  const hit = hit1 || hit2;
  const ediSku = hit1 ? `${base}1P1` : `${base}1P2`;
  if (!hit || !/^(PC|EA|EACH)$/i.test(hit.uom || '')) {
    unmatched.push(s);
    continue;
  }
  if (Math.abs(Number(s.cost) - hit.cost) <= 0.02) continue; // already correct
  reprice.push({ ...s, ediSku, newCost: hit.cost, feedName: hit.product_name });
}

console.log(`\n=== DAL Color Wheel glossy trim smear (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
console.log(`reprice: ${reprice.length}, no feed match: ${unmatched.length}, ambiguous 1P1/1P2: ${ambiguous.length}\n`);
for (const s of ambiguous) {
  console.log(`  AMBIGUOUS ${s.vendor_sku} 1P1 $${s.c1} vs 1P2 $${s.c2} (left as-is)`);
}
for (const s of unmatched) {
  console.log(`  NO-MATCH ${s.vendor_sku} "${s.product} — ${s.variant_name}" cost $${s.cost} (left as-is)`);
}
for (const s of reprice) {
  console.log(`  ${s.vendor_sku} → ${s.ediSku} "${s.feedName}" ` +
    `cost $${s.cost} → $${s.newCost}/pc, retail $${s.retail_price} → ~$${r2(s.newCost * 1.6)} pre-nine` +
    `${s.retail_locked ? ' [retail_locked]' : ''}`);
}

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }

for (const s of reprice) {
  await upsertPricing(pool, s.sku_id, {
    cost: s.newCost, retail_price: r2(s.newCost * 1.6), price_basis: 'per_unit',
  });
  // borrowed field-box packaging — the feed has no carton for PC trim
  await pool.query(`
    UPDATE packaging SET sqft_per_box = NULL, pieces_per_box = NULL
    WHERE sku_id = $1 AND sqft_per_box IS NOT NULL`, [s.sku_id]);
  await pool.query(`
    INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
    VALUES ($1, $2, 'high', 'cw-glossy-trim-grp-rename')
    ON CONFLICT (live_vendor_sku) DO UPDATE
      SET edi_vendor_sku = EXCLUDED.edi_vendor_sku, method = EXCLUDED.method, updated_at = now()`,
    [s.vendor_sku, s.ediSku]);
}
console.log(`\nAPPLIED: ${reprice.length} repriced + mapped`);
await pool.end();
