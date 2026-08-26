#!/usr/bin/env node

/**
 * ef-lifecycle.js — Engineered Floors / Pentz Commercial catalog lifecycle
 *
 * Runs as the final step of the `engfloors` pipeline (after ingest + cost/inventory
 * + image enrichment). Applies two idempotent, gap-fill-only rules to EF + PC
 * products and NEVER overwrites manual edits (only flips products.status):
 *
 *   ACTIVATE (draft → active)  when a product has:
 *     - at least one active, non-sample SKU with retail_price > 0
 *     - a category assigned
 *     - and is NOT known to be out of stock
 *
 *   RETIRE (active → draft)    when a product:
 *     - has no active priced SKU (discontinued / unpriced), OR
 *     - is known out of stock (has inventory data and every active SKU is at 0)
 *
 * Image presence is deliberately NOT a lifecycle factor: image-less products go
 * live (with a placeholder) and are never retired for lacking a photo. The image
 * step gap-fills photos best-effort; missing ones just stay missing.
 *
 * "Known out of stock" requires actual inventory snapshots that all read zero —
 * a product with no snapshots at all is treated as unknown, not out of stock, so
 * we never retire simply because inventory hasn't been polled yet.
 *
 * On change (and not --dry-run) it emails a summary to the ops team.
 *
 * Usage:
 *   node backend/pipelines/ef-lifecycle.js [--dry-run]
 *   docker compose exec api node pipelines/ef-lifecycle.js --dry-run
 */

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

// ── Reusable SQL predicates (p = products alias) ──────────────────────────────
const HAS_ACTIVE_PRICED_SKU = `EXISTS (
  SELECT 1 FROM skus s JOIN pricing pr ON pr.sku_id = s.id
  WHERE s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
    AND pr.retail_price > 0
)`;

// Any inventory snapshot exists for an active SKU of this product.
const HAS_INVENTORY_DATA = `EXISTS (
  SELECT 1 FROM inventory_snapshots i JOIN skus s ON s.id = i.sku_id
  WHERE s.product_id = p.id AND s.status = 'active'
)`;

// At least one active SKU has stock on hand or in transit.
const HAS_STOCK = `EXISTS (
  SELECT 1 FROM inventory_snapshots i JOIN skus s ON s.id = i.sku_id
  WHERE s.product_id = p.id AND s.status = 'active'
    AND (COALESCE(i.qty_on_hand,0) > 0 OR COALESCE(i.qty_on_hand_sqft,0) > 0
      OR COALESCE(i.qty_in_transit,0) > 0 OR COALESCE(i.qty_in_transit_sqft,0) > 0)
)`;

// Known out of stock = we have inventory data AND none of it shows stock.
const KNOWN_OUT_OF_STOCK = `(${HAS_INVENTORY_DATA} AND NOT ${HAS_STOCK})`;

// EF-side Pentz twin: the 832 creates EF-vendor duplicates of Pentz items
// (internal_sku 'EF-1-{style}-{color}-…') purely as pricing carriers;
// merge-ef-pentz-pricing.js copies their pricing onto the canonical PC-vendor
// products and drafts them. Never re-activate one whose PC twin exists
// (matched by style+color, same key the merge script uses).
const IS_MERGED_PENTZ_TWIN = `EXISTS (
  SELECT 1 FROM skus es
  WHERE es.product_id = p.id AND es.internal_sku LIKE 'EF-1-%'
    AND EXISTS (
      SELECT 1 FROM skus ps JOIN products pp ON pp.id = ps.product_id
      WHERE pp.vendor_id = (SELECT id FROM vendors WHERE code = 'PC')
        AND split_part(ps.vendor_sku, '-', 2) = split_part(es.internal_sku, '-', 3)
        AND split_part(ps.vendor_sku, '-', 3) = split_part(es.internal_sku, '-', 4)
    )
)`;

async function resolveVendorIds() {
  const res = await pool.query(`SELECT id, code FROM vendors WHERE code IN ('EF','PC')`);
  const ids = res.rows.map(r => r.id);
  if (!ids.length) throw new Error("Neither EF nor PC vendor found");
  return ids;
}

async function coverage(vendorIds) {
  const res = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE has_img) AS with_img,
      COUNT(*) AS total
    FROM (
      SELECT s.id,
        EXISTS (SELECT 1 FROM media_assets m WHERE m.asset_type='primary'
                AND (m.sku_id = s.id OR m.product_id = s.product_id)) AS has_img
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = ANY($1) AND p.status = 'active' AND s.status = 'active' AND s.is_sample = false
    ) t
  `, [vendorIds]);
  const { with_img, total } = res.rows[0];
  const pct = Number(total) > 0 ? ((Number(with_img) / Number(total)) * 100).toFixed(1) : '0.0';
  return { with_img: Number(with_img), total: Number(total), pct };
}

async function main() {
  console.log(`ef-lifecycle.js — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  const vendorIds = await resolveVendorIds();
  console.log(`Vendors (EF/PC): ${vendorIds.length}`);

  // ── RETIRE first (active → draft) ──────────────────────────────────────────
  const retireCandidates = await pool.query(`
    SELECT p.id, COALESCE(p.display_name, p.name) AS name,
      CASE
        WHEN NOT ${HAS_ACTIVE_PRICED_SKU} THEN 'no active priced SKU'
        ELSE 'out of stock'
      END AS reason
    FROM products p
    WHERE p.vendor_id = ANY($1) AND p.status = 'active'
      AND (NOT ${HAS_ACTIVE_PRICED_SKU} OR ${KNOWN_OUT_OF_STOCK})
    ORDER BY reason, name
  `, [vendorIds]);

  const retired = retireCandidates.rows;
  console.log(`\nRETIRE (active → draft): ${retired.length}`);
  const byReason = {};
  for (const r of retired) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason)) console.log(`  ${n}  ${reason}`);
  for (const r of retired.slice(0, 25)) console.log(`  [${DRY_RUN ? 'DRY' : 'RETIRE'}] ${r.name} — ${r.reason}`);
  if (retired.length > 25) console.log(`  ... and ${retired.length - 25} more`);

  if (!DRY_RUN && retired.length > 0) {
    await pool.query(
      `UPDATE products SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
      [retired.map(r => r.id)]
    );
  }

  // ── ACTIVATE (draft → active) ──────────────────────────────────────────────
  const activateCandidates = await pool.query(`
    SELECT p.id, COALESCE(p.display_name, p.name) AS name
    FROM products p
    WHERE p.vendor_id = ANY($1) AND p.status = 'draft'
      AND p.category_id IS NOT NULL
      AND ${HAS_ACTIVE_PRICED_SKU}
      AND NOT ${KNOWN_OUT_OF_STOCK}
      AND NOT ${IS_MERGED_PENTZ_TWIN}
    ORDER BY name
  `, [vendorIds]);

  const activated = activateCandidates.rows;
  console.log(`\nACTIVATE (draft → active): ${activated.length}`);
  for (const a of activated.slice(0, 25)) console.log(`  [${DRY_RUN ? 'DRY' : 'ACTIVATE'}] ${a.name}`);
  if (activated.length > 25) console.log(`  ... and ${activated.length - 25} more`);

  if (!DRY_RUN && activated.length > 0) {
    await pool.query(
      `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
      [activated.map(a => a.id)]
    );
  }

  // ── Coverage + summary ─────────────────────────────────────────────────────
  const cov = await coverage(vendorIds);
  console.log(`\nImage coverage (active EF/PC SKUs): ${cov.with_img}/${cov.total} (${cov.pct}%)`);
  console.log(`\nSUMMARY: activated=${activated.length} retired=${retired.length} dryRun=${DRY_RUN}`);

  // Email the ops team only when the live run actually changed the catalog.
  if (!DRY_RUN && (activated.length > 0 || retired.length > 0)) {
    try {
      const { sendPipelineSummary } = await import('../services/emailService.js');
      await sendPipelineSummary({
        label: 'Engineered Floors',
        activated: activated.map(a => a.name),
        retired: retired.map(r => `${r.name} — ${r.reason}`),
        coverage: `${cov.with_img}/${cov.total} (${cov.pct}%)`,
      });
    } catch (err) {
      console.error('[ef-lifecycle] summary email failed:', err.message);
    }
  }

  if (DRY_RUN) console.log('\n*** DRY RUN — no changes written ***');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[ef-lifecycle] FATAL:', err.message);
    pool.end().finally(() => process.exit(1));
  });
