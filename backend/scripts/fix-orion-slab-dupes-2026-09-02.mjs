// Orion (169) slab-duplicate cleanup — 2026-09-02 session.
//
// Idempotent. Safe to re-run: every statement is guarded to only touch rows
// still in the "wrong" state, and deletions skip anything referenced by an
// order/cart/PO/estimate/credit memo.
//
// deploy.sh ships CODE only; run this against the prod DB manually:
//   ssh ubuntu@32.188.96.3 -i roma-prod.pem
//   docker compose exec -T api node scripts/fix-orion-slab-dupes-2026-09-02.mjs
//
// Background:
//   A full Orion re-scrape on 2026-09-02 hit Orion's renamed slab product URLs
//   ("<Name> Slab Natural Stone Countertop"). Because the scraper keyed SKUs off
//   the URL slug, it CREATED ~46 brand-new zero-priced duplicate products next to
//   the existing June records (which hold the real prices + images) instead of
//   updating them. Symptoms the owner saw: duplicate slab cards, $0 slabs, and
//   "Taj Mahal Slab Natural Stone [Countertop]" miscategorized as porcelain-tile.
//   The scraper name-normalization + slab SKU-identity fixes (orion.js) stop this
//   recurring on the next scrape; this script cleans the rows already written.
//
// Fixes:
//   1. Delete the "<X> Slab Natural Stone [Countertop]" duplicate products (vendor
//      169) and all their child rows. The priced catalog lives in the bare-name
//      records, which are untouched. Guarded: skips any product whose SKUs are
//      referenced by an order/cart/PO/estimate/credit memo (none are, today).
//   2. Blue Forest & Palma variant-name fix: their Size attribute is correct
//      (24x48) but the variant_name pill still shows the metric "60x120". Rewrite
//      any Orion variant_name that is a centimetre-scale WxH (either dim >= 50) to
//      the SKU's inch Size attribute so the storefront pill reads 24x48.

import { pool } from '../db.js';

async function main() {
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');

    const { rows: vr } = await client.query(`SELECT id FROM vendors WHERE code = '169'`);
    if (!vr.length) throw new Error('Orion vendor (code 169) not found');
    const orion = vr[0].id;

    // ── 1. Delete the "Slab Natural Stone [Countertop]" duplicate products ──
    // Target set: vendor 169 products whose name ends in the marketing suffix the
    // renamed URLs produced. Exclude anything referenced by a transaction.
    const dupFilter = `
      p.vendor_id = $1
      AND p.name ~* ' Slab Natural Stone( Countertop)?$'
      AND NOT EXISTS (
        SELECT 1 FROM skus s
        WHERE s.product_id = p.id AND (
             EXISTS (SELECT 1 FROM order_items         x WHERE x.sku_id = s.id)
          OR EXISTS (SELECT 1 FROM cart_items          x WHERE x.sku_id = s.id)
          OR EXISTS (SELECT 1 FROM purchase_order_items x WHERE x.sku_id = s.id)
          OR EXISTS (SELECT 1 FROM estimate_items       x WHERE x.sku_id = s.id)
          OR EXISTS (SELECT 1 FROM credit_memo_items    x WHERE x.sku_id = s.id)
        )
      )`;

    const { rows: dupProducts } = await client.query(
      `SELECT p.id, p.name FROM products p WHERE ${dupFilter} ORDER BY p.name`, [orion]);
    const dupIds = dupProducts.map(r => r.id);
    summary.duplicate_products_found = dupProducts.length;
    summary.duplicate_product_names = dupProducts.map(r => r.name);

    if (dupIds.length) {
      const skuIdRows = await client.query(
        `SELECT id FROM skus WHERE product_id = ANY($1)`, [dupIds]);
      const skuIds = skuIdRows.rows.map(r => r.id);

      if (skuIds.length) {
        // Child rows without ON DELETE CASCADE must go first.
        await client.query(`DELETE FROM sku_attributes      WHERE sku_id = ANY($1)`, [skuIds]);
        await client.query(`DELETE FROM pricing             WHERE sku_id = ANY($1)`, [skuIds]);
        await client.query(`DELETE FROM packaging           WHERE sku_id = ANY($1)`, [skuIds]);
        await client.query(`DELETE FROM media_assets        WHERE sku_id = ANY($1)`, [skuIds]);
        // CASCADE-backed children (harmless to delete explicitly; keeps it obvious).
        await client.query(`DELETE FROM inventory_snapshots WHERE sku_id = ANY($1)`, [skuIds]);
        await client.query(`DELETE FROM quality_violations  WHERE sku_id = ANY($1)`, [skuIds]);
      }
      // Product-level media (asset_type primary/lifestyle rows tied to product, not sku).
      await client.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [dupIds]);
      await client.query(`DELETE FROM quality_violations WHERE product_id = ANY($1)`, [dupIds]);
      const delSkus = await client.query(`DELETE FROM skus WHERE product_id = ANY($1)`, [dupIds]);
      const delProds = await client.query(`DELETE FROM products WHERE id = ANY($1)`, [dupIds]);
      summary.deleted_skus = delSkus.rowCount;
      summary.deleted_products = delProds.rowCount;
    } else {
      summary.deleted_skus = 0;
      summary.deleted_products = 0;
    }

    // ── 2. Blue Forest / Palma metric variant_name → inch Size attribute ──
    const cmFix = await client.query(`
      UPDATE skus s
      SET variant_name = sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'size'
      WHERE sa.sku_id = s.id
        AND s.product_id IN (SELECT id FROM products WHERE vendor_id = $1)
        AND s.variant_name ~ '^[0-9]+x[0-9]+$'
        AND (split_part(s.variant_name, 'x', 1)::int >= 50
          OR split_part(s.variant_name, 'x', 2)::int >= 50)
        AND sa.value ~ '^[0-9]+x[0-9]+$'
        AND (split_part(sa.value, 'x', 1)::int < 50
         AND split_part(sa.value, 'x', 2)::int < 50)`,
      [orion]);
    summary.variant_name_metric_fixed = cmFix.rowCount;

    await client.query('COMMIT');
    console.log('[fix-orion-slab-dupes-2026-09-02] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fix-orion-slab-dupes-2026-09-02] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
