// Orion (169) slab / deco-tile / terrazzo reclassification — 2026-09-02 session.
//
// Idempotent. Applies the owner-reviewed material map (also baked into
// backend/scrapers/orion.js so future scrapes stay correct) to the CURRENT DB,
// so it works regardless of Orion's live-URL churn and without a risky full
// re-scrape (which would zero the call-for-price slab retails).
//
//   docker compose exec -T api node scripts/reclassify-orion-slabs-2026-09-02.mjs
//   (prod) ssh ubuntu@32.188.96.3 -i roma-prod.pem
//          docker compose exec -T api node scripts/reclassify-orion-slabs-2026-09-02.mjs
//
// Moves each product to its real category leaf and fixes the material/application
// attributes. Deliberately does NOT touch sell_by / pricing (deferred — the slab
// per-sqft-vs-per-slab model is a separate pass):
//   • natural-stone slabs   → marble/quartzite/granite/quartz-countertops (+ material)
//   • L01–L08 (Talavera)    → backsplash-wall, material Ceramic, variant_type wall_tile
//   • Natural Terrazzo       → natural-stone, material Natural Stone
//   • genuine porcelain slabs stay in porcelain-slabs

import { pool } from '../db.js';
import {
  MATERIAL_CATEGORY, MEXICAN_DECO_TILE, CATEGORY_OVERRIDES,
  MATERIAL_BY_SLUG, APP_BY_SLUG, MATERIAL_OVERRIDES_BY_NAME, slabMaterialFor,
} from '../scrapers/orion.js';

// variant_type by target leaf (categorization only — sell_by/pricing untouched).
const VARIANT_TYPE_BY_SLUG = { 'backsplash-wall': 'wall_tile', 'wood-look-tile': 'floor_tile' };

const ORION = '94dd7078-a068-4ea0-b78b-b0565731e758';

async function main() {
  const client = await pool.connect();
  const summary = { moved: {}, material_set: 0, application_set: 0, variant_type_set: 0, unknown: [] };
  try {
    await client.query('BEGIN');

    // Category slug → id
    const cats = (await client.query('SELECT id, slug FROM categories')).rows;
    const catId = new Map(cats.map(c => [c.slug, c.id]));

    // attribute ids
    const attrs = (await client.query(
      `SELECT id, slug FROM attributes WHERE slug IN ('material','application')`)).rows;
    const attrId = new Map(attrs.map(a => [a.slug, a.id]));

    const upsertAttr = async (skuId, slug, value) => {
      if (!value || !attrId.get(slug)) return 0;
      const r = await client.query(
        `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
         ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
         WHERE sku_attributes.value IS DISTINCT FROM EXCLUDED.value`,
        [skuId, attrId.get(slug), value]);
      return r.rowCount;
    };

    // Build the work list: every Orion product currently in porcelain-slabs, plus
    // Natural Terrazzo (wherever it sits).
    const rows = (await client.query(
      `SELECT p.id, p.name, c.slug AS cur_slug
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.vendor_id = $1
         AND (c.slug = 'porcelain-slabs' OR lower(p.name) = 'natural terrazzo')`,
      [ORION])).rows;

    for (const p of rows) {
      const nameLower = p.name.toLowerCase().trim();
      let targetSlug;

      if (CATEGORY_OVERRIDES[nameLower]) {
        targetSlug = CATEGORY_OVERRIDES[nameLower];        // natural terrazzo, multifios, …
      } else if (MEXICAN_DECO_TILE.has(nameLower)) {
        targetSlug = 'backsplash-wall';                    // L01–L08 painted deco tile
      } else {
        const mat = slabMaterialFor(nameLower);
        if (!mat) { summary.unknown.push(p.name); continue; } // leave untouched, report
        targetSlug = MATERIAL_CATEGORY[mat] || 'porcelain-slabs';
      }
      const variantType = VARIANT_TYPE_BY_SLUG[targetSlug] || null;
      const materialVal = MATERIAL_OVERRIDES_BY_NAME[nameLower] || MATERIAL_BY_SLUG[targetSlug];
      const appVal = APP_BY_SLUG[targetSlug];

      // Move category if needed
      const targetCatId = catId.get(targetSlug);
      if (targetCatId && targetSlug !== p.cur_slug) {
        await client.query('UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [targetCatId, p.id]);
        summary.moved[targetSlug] = (summary.moved[targetSlug] || 0) + 1;
      }

      // Update attributes on every SKU of the product
      const skuIds = (await client.query('SELECT id FROM skus WHERE product_id = $1', [p.id])).rows.map(r => r.id);
      for (const skuId of skuIds) {
        summary.material_set += await upsertAttr(skuId, 'material', materialVal);
        summary.application_set += await upsertAttr(skuId, 'application', appVal);
        if (variantType) {
          const r = await client.query(
            `UPDATE skus SET variant_type = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND variant_type IS DISTINCT FROM $1`, [variantType, skuId]);
          summary.variant_type_set += r.rowCount;
        }
      }
    }

    await client.query('COMMIT');
    console.log('[reclassify-orion-slabs-2026-09-02] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[reclassify-orion-slabs-2026-09-02] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
