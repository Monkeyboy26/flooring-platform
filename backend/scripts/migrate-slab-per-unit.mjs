#!/usr/bin/env node
/**
 * One-time migration: convert unit-sold, per-sqft-priced slabs (and same-shape
 * trim) that carry a known slab/piece area (packaging.sqft_per_box) into real
 * per-slab pricing, so every surface agrees.
 *
 * Before, these stored a per-SQFT rate ($/sf) but sold by the unit. The storefront
 * computed the piece price on the fly (displayPrice = retail × sqft_per_box), but
 * the rep catalog/item-entry showed the bare $/sf — so Caesarstone read ~$33/ea in
 * the wizard vs ~$1,967/ea on the storefront. This bakes the piece price into the
 * data (retail/cost × sqft_per_box, price_basis → per_unit) so no surface has to
 * special-case it. sqft_per_box is left in place as the slab-area / coverage figure.
 *
 * Scope: sell_by IN ('unit','piece') AND price_basis IN ('per_sqft','sqft') AND
 * sqft_per_box > 0. Slabs WITHOUT an area stay per_sqft (rep enters the size at the
 * line — see [[slab-size-entry]]). Idempotent: already-migrated per_unit rows are
 * skipped. Writes a before backup to backend/data/ first. Dry-run unless --apply.
 */
import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const SELECT = `
  SELECT pr.sku_id, pr.retail_price, pr.cost, pr.price_basis, pk.sqft_per_box, c.slug
  FROM pricing pr
  JOIN skus s ON s.id = pr.sku_id
  JOIN products p ON p.id = s.product_id
  JOIN categories c ON c.id = p.category_id
  JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.sell_by IN ('unit','piece')
    AND pr.price_basis IN ('per_sqft','sqft')
    AND pk.sqft_per_box > 0`;

async function main() {
  const { rows } = await pool.query(SELECT);
  console.log(`${rows.length} SKU(s) match (unit + per_sqft + sqft_per_box).`);
  if (!rows.length) { await pool.end(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', 'data', `slab-per-unit-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`Backup → ${backup}`);

  for (const r of rows.slice(0, 5)) {
    const area = parseFloat(r.sqft_per_box);
    console.log(`  ${r.slug}  $${r.retail_price}/sf × ${area} = $${(r.retail_price * area).toFixed(2)}/ea`);
  }

  if (!APPLY) { console.log('\nDry-run. Re-run with --apply to write.'); await pool.end(); return; }

  const res = await pool.query(`
    UPDATE pricing pr
    SET retail_price = ROUND(pr.retail_price * pk.sqft_per_box, 2),
        cost = CASE WHEN pr.cost IS NOT NULL THEN ROUND(pr.cost * pk.sqft_per_box, 2) ELSE NULL END,
        price_basis = 'per_unit'
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN packaging pk ON pk.sku_id = s.id
    WHERE pr.sku_id = s.id
      AND s.sell_by IN ('unit','piece')
      AND pr.price_basis IN ('per_sqft','sqft')
      AND pk.sqft_per_box > 0`);
  console.log(`Migrated ${res.rowCount} row(s) to per_unit.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
