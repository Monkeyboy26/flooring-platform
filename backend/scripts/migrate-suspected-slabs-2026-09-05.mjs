// Suspected-slab migration — 2026-09-05 session.
//
// Single-piece >= 25 sqft "tiles" sold box/per_sqft are gauged porcelain
// panels/slabs hiding in tile categories (EMS Expanse + Agio/Perenne/Levata
// Slim + Milzetti + Silque + Prodigy + Hangar large formats, DAL SlimLite,
// ELY Trilogy Zero.3). Per platform convention (suspected-slab rule, Orion
// precedent, the Emser Zambia scraper fix) they sell per SLAB:
//
//   sell_by box -> unit, price_basis per_sqft -> per_unit,
//   cost/retail = per-sqft rate x piece area (sqft_per_box, kept for coverage)
//
// The per-sqft rates were verified GENUINE before this conversion (flat rate
// across panel sizes for Expanse; smooth size curve for premium lines) — the
// per-carton-dollars hypothesis was ruled out, so multiplying by area is safe.
//
// Products whose active SKUs are then ALL per-slab panels move to the
// porcelain-slabs leaf with category_source='manual' (pinned against
// re-import). Mixed products (panel + smaller formats) keep their category.
//
// Skips carton-with-missing-piece-count false positives via the same
// name-size-vs-box-area test as applySlabSelling / the quality rule
// (Cavanite II: 26-sqft carton of 17x17s).
//
// Source fixes shipped alongside: base.js applySlabSelling() chained into
// emser-832.js so the next 832 import converges instead of reverting.
// DAL/ELY imports are price-list scripts run manually — re-check after any
// re-import there.
//
// Idempotent (only touches box/per_sqft rows). Dry-run unless --apply.
// Prod: docker compose exec -T api node scripts/migrate-suspected-slabs-2026-09-05.mjs --apply

import { pool } from '../db.js';

const APPLY = process.argv.includes('--apply');
const VENDORS = ['EMS', 'DAL', 'ELY'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function isRealSlab(variantName, boxSqft) {
  const m = /(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/.exec(variantName || '');
  if (!m) return true;
  const pieceArea = (parseFloat(m[1]) * parseFloat(m[2])) / 144;
  return !(pieceArea > 0 && pieceArea < parseFloat(boxSqft) * 0.8);
}

async function main() {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, p.id AS product_id, v.code AS vendor, p.name, s.variant_name,
           pr.cost, pr.retail_price, pk.sqft_per_box, c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    JOIN categories c ON c.id = p.category_id
    JOIN pricing pr ON pr.sku_id = s.id
    JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = ANY($1)
      AND s.status = 'active'
      AND c.slug IN ('porcelain-tile', 'ceramic-tile', 'natural-stone', 'large-format-tile', 'wood-look-tile')
      AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
      AND pk.sqft_per_box >= 25 AND COALESCE(pk.pieces_per_box, 1) = 1
    ORDER BY v.code, p.name, s.variant_name`, [VENDORS]);

  const convert = rows.filter(r => isRealSlab(r.variant_name, r.sqft_per_box));
  const skipped = rows.filter(r => !isRealSlab(r.variant_name, r.sqft_per_box));

  console.log(`${rows.length} candidate SKU(s); converting ${convert.length}, skipping ${skipped.length} carton false positive(s)\n`);
  for (const r of skipped) console.log(`  SKIP (carton): ${r.vendor} ${r.name} — ${r.variant_name} (${r.sqft_per_box} sf box)`);

  const byProduct = new Map();
  for (const r of convert) {
    const area = parseFloat(r.sqft_per_box);
    r.newCost = r.cost != null ? round2(r.cost * area) : null;
    r.newRetail = r.retail_price != null ? round2(r.retail_price * area) : null;
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }

  for (const r of convert.slice(0, 12)) {
    console.log(`  ${r.vendor} ${r.name} — ${r.variant_name}: $${r.cost}/sf x ${parseFloat(r.sqft_per_box).toFixed(1)} sf = $${r.newCost}/slab (retail $${r.newRetail})`);
  }
  if (convert.length > 12) console.log(`  ... and ${convert.length - 12} more`);

  if (!APPLY) { console.log('\nDry-run. Re-run with --apply to write.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of convert) {
      await client.query(`UPDATE skus SET sell_by = 'unit', updated_at = NOW() WHERE id = $1`, [r.sku_id]);
      await client.query(
        `UPDATE pricing SET price_basis = 'per_unit', cost = $2, retail_price = $3 WHERE sku_id = $1`,
        [r.sku_id, r.newCost, r.newRetail]);
    }
    console.log(`\nConverted ${convert.length} SKU(s) to per-slab.`);

    // Move now-pure-slab products to the porcelain-slabs leaf and pin them.
    const moved = await client.query(`
      UPDATE products p SET
        category_id = (SELECT id FROM categories WHERE slug = 'porcelain-slabs'),
        category_source = 'manual',
        updated_at = NOW()
      WHERE p.id = ANY($1)
        AND NOT EXISTS (
          SELECT 1 FROM skus s
          LEFT JOIN packaging pk ON pk.sku_id = s.id
          WHERE s.product_id = p.id AND s.status = 'active'
            AND (s.sell_by <> 'unit' OR COALESCE(pk.sqft_per_box, 0) < 25 OR COALESCE(pk.pieces_per_box, 1) > 1)
        )
      RETURNING p.name`, [[...byProduct.keys()]]);
    console.log(`Moved ${moved.rowCount} pure-slab product(s) to porcelain-slabs (pinned):`);
    for (const m of moved.rows) console.log(`  ${m.name}`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
