// Tile-family leaf validator — the "wrong leaf" net that netCategory can't be.
//
// netCategory (lib/categoryClassifier.js) runs at product-upsert time, when no
// SKUs/attributes/packaging exist yet, so it can only fill NULL/parent
// categories. This validator runs AFTER a scrape (and nightly), when the
// structural evidence is in the DB, and re-derives every active tile-family
// product's leaf via classifyTileLeaf():
//
//   strong contradiction  -> auto-correct (category_source='classifier'),
//                            unless the product is pinned (category_source='manual')
//   weak contradiction    -> category_needs_review=true, leave in place
//   evidence confirms     -> clear a stale category_needs_review flag
//
// The same evidence query + resolver back the tile-leaf-mismatch quality rule
// (rules.js) and scripts/validate-tile-leaves.mjs — detection == prevention.

import { classifyTileLeaf, loadCategoryCache, SHEET_AREA_MIN, SHEET_AREA_MAX } from '../lib/categoryClassifier.js';

// One aggregate row per active tile-family product with the per-SKU rollups
// classifyTileLeaf needs. sheet_area_skus = unit-sold, per_unit-priced SKUs
// whose piece area sits in the mesh-sheet window; unit+per_sqft SKUs are the
// per-piece stone model (large pieces, not sheets) and are counted separately.
export async function gatherTileEvidence(pool, { vendorId = null } = {}) {
  const { rows } = await pool.query(`
    SELECT p.id AS product_id, p.name, p.collection, p.category_source,
           p.category_needs_review, c.slug AS current_leaf,
           v.id AS vendor_id, v.code AS vendor_code,
           COUNT(s.id)::int AS total_skus,
           COUNT(*) FILTER (WHERE s.sell_by = 'unit')::int AS unit_skus,
           COUNT(*) FILTER (WHERE s.sell_by = 'box')::int AS box_skus,
           COUNT(*) FILTER (
             WHERE s.sell_by = 'unit'
               AND COALESCE(pr.price_basis, 'per_unit') = 'per_unit'
               AND COALESCE(
                     pk.sqft_per_box / NULLIF(pk.pieces_per_box, 0),
                     CASE WHEN COALESCE(pk.pieces_per_box, 1) <= 1 THEN pk.sqft_per_box END
                   ) BETWEEN $2 AND $3
           )::int AS sheet_area_skus,
           COUNT(*) FILTER (WHERE s.sell_by = 'unit' AND pr.price_basis = 'per_sqft')::int AS per_sqft_unit_skus,
           ARRAY_AGG(DISTINCT s.variant_name) FILTER (WHERE s.variant_name IS NOT NULL) AS variant_names,
           ARRAY_AGG(mat.value) FILTER (WHERE mat.value IS NOT NULL) AS materials,
           ARRAY_AGG(lk.value)  FILTER (WHERE lk.value  IS NOT NULL) AS looks
    FROM products p
    JOIN categories c   ON c.id = p.category_id
    JOIN categories par ON par.id = c.parent_id AND par.slug = 'tile'
    JOIN vendors v      ON v.id = p.vendor_id
    JOIN skus s         ON s.product_id = p.id AND s.status = 'active' AND s.is_sample IS NOT TRUE
    LEFT JOIN pricing pr   ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    LEFT JOIN LATERAL (
      SELECT sa.value FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'material'
      WHERE sa.sku_id = s.id LIMIT 1
    ) mat ON true
    LEFT JOIN LATERAL (
      SELECT sa.value FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'look'
      WHERE sa.sku_id = s.id LIMIT 1
    ) lk ON true
    WHERE p.status = 'active' AND ($1::uuid IS NULL OR v.id = $1)
    GROUP BY p.id, c.slug, v.id, v.code
  `, [vendorId, SHEET_AREA_MIN, SHEET_AREA_MAX]);
  return rows;
}

export function resolveRow(row) {
  return classifyTileLeaf({
    name: row.name,
    collection: row.collection,
    currentLeaf: row.current_leaf,
    materials: row.materials || [],
    looks: row.looks || [],
    variantNames: row.variant_names || [],
    totalSkus: row.total_skus,
    unitSkus: row.unit_skus,
    boxSkus: row.box_skus,
    sheetAreaSkus: row.sheet_area_skus,
    perSqftUnitSkus: row.per_sqft_unit_skus,
  });
}

// apply=false is a pure dry run (nothing written). Returns
// { checked, moved, flagged, cleared } where moved/flagged carry
// { product_id, vendor_code, name, from, to, confidence, reasons, pinned }.
export async function validateTileLeaves(pool, { vendorId = null, apply = false } = {}) {
  const rows = await gatherTileEvidence(pool, { vendorId });
  const { slugToId } = await loadCategoryCache(pool);
  const moved = [], flagged = [], cleared = [];

  for (const row of rows) {
    const res = resolveRow(row);
    const base = {
      product_id: row.product_id, vendor_code: row.vendor_code, name: row.name,
      from: row.current_leaf, to: res.slug, confidence: res.confidence,
      reasons: res.reasons, pinned: row.category_source === 'manual',
    };

    if (res.confidence === 'strong' && res.slug !== row.current_leaf) {
      if (base.pinned) {
        // Never touch a manual decision — the quality rule surfaces the conflict.
        flagged.push(base);
        continue;
      }
      const targetId = slugToId.get(res.slug);
      if (!targetId) { flagged.push({ ...base, reasons: [...res.reasons, `unknown leaf ${res.slug}`] }); continue; }
      if (apply) {
        await pool.query(
          `UPDATE products SET category_id = $1, category_source = 'classifier',
                  category_needs_review = false, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND category_source <> 'manual'`,
          [targetId, row.product_id]
        );
      }
      moved.push(base);
    } else if (res.confidence === 'weak' && res.slug !== row.current_leaf) {
      // Weak contradictions are NOT written to category_needs_review — they
      // surface only as tile-leaf-mismatch violations, whose waive status
      // persists by fingerprint (needs_review has no waive and would become
      // standing noise for known-correct edge cases).
      flagged.push(base);
    } else if (res.confidence === null && row.category_needs_review && res.reasons.length) {
      // Evidence positively confirms the current leaf — clear the stale flag.
      if (apply) {
        await pool.query(
          `UPDATE products SET category_needs_review = false, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [row.product_id]
        );
      }
      cleared.push({ ...base, to: row.current_leaf });
    }
  }

  return { checked: rows.length, moved, flagged, cleared };
}
