// SEO Phase 2 — build programmatic facet landing pages.
//
// Mints one landing_pages row per (leaf category × facet-attribute value) that has
// enough products — e.g. "White Porcelain Tile", "24x48 Marble-Look Tile". These are
// the long-tail money pages. Driven by REAL catalog counts, not URL combinatorics.
//
//   node scripts/seo/build-landing-pages.mjs [--create-min N] [--index-min N]
//       [--attrs color,size,look,finish,material] [--dry-run]
//
// Run inside the api container:
//   docker compose exec -T api node scripts/seo/build-landing-pages.mjs
//
// INDEXATION GATING (the guardrail against mass thin pages):
//   • A page is CREATED when it has >= CREATE_MIN products (so it exists as an
//     internal-link target and renders), and
//   • marked is_indexable ONLY when it has >= INDEX_MIN in-stock products.
//   Non-indexable pages render but emit robots=noindex,follow (crawlable, not indexed).
// RE-RUNNING THIS IS THE NIGHTLY RECOMPUTE: counts refresh, pages that fell below the
// floor are de-indexed (product_count=0, is_indexable=false) so the sitemap stays honest.
//
// URL scheme: /shop/{slug}  (single segment — distinct from /shop/{cat}/{prod} products
// and /shop/sku/{id} legacy). filter_json is the browse query the storefront/seoRenderer
// replays: {"category":"porcelain-tile","attributes":{"color":"White"}}.
//
// SCOPE: category×attribute facets only (color/size/look/finish/material — the bulk of
// long-tail). Standalone material, brand, room, and guide page types are follow-ups
// (same table, different `type`); see docs/SEO-PLAN.md Phase 2.

import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const CREATE_MIN = parseInt(arg('--create-min', '3'), 10);
const INDEX_MIN = parseInt(arg('--index-min', '8'), 10);
const ATTRS = arg('--attrs', 'color,size,look,finish,material').split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = process.argv.includes('--dry-run');

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Size values are dimensional and slugify badly by default ("12 x 24" → "12-x-24",
// '4" x 4"' → "4-x-4"). Normalize sizes to a compact form first so the slug reads like
// the real dimension: strip inch/quote marks, collapse the x-separator, keep fractions
// as a single dash. Non-size facets use plain slugify.
function facetSlug(attrSlug, value) {
  let v = String(value);
  if (attrSlug === 'size') {
    v = v.replace(/["'”″′’]/g, '')        // drop inch/quote marks
         .replace(/\s*(?:[x×X]|by)\s*/g, 'x')  // "12 x 24" / "12 by 24" → "12x24"
         .replace(/\s*\/\s*/g, '-');       // fraction slash → single dash: "1/2" → "1-2"
  }
  return slugify(v);
}

// Distinct (category × attribute value) combos with a live product count. Counts
// DISTINCT active, non-sample products that have an active in-stock-or-unknown SKU
// carrying that attribute value in that category.
const { rows } = await pool.query(`
  SELECT c.slug AS category_slug, c.name AS category_name,
         a.slug AS attr_slug, a.name AS attr_name, sa.value,
         COUNT(DISTINCT p.id) AS product_count
  FROM products p
  JOIN categories c ON c.id = p.category_id AND c.is_active = true
  JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
    AND COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')
  JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.value <> ''
  JOIN attributes a ON a.id = sa.attribute_id AND a.slug = ANY($1)
  WHERE p.status = 'active'
  GROUP BY c.slug, c.name, a.slug, a.name, sa.value
  HAVING COUNT(DISTINCT p.id) >= $2
  ORDER BY product_count DESC
`, [ATTRS, CREATE_MIN]);

console.log(`${rows.length} facet combos ≥ ${CREATE_MIN} products (attrs: ${ATTRS.join(', ')})${DRY_RUN ? ', DRY RUN' : ''}`);

let created = 0, updated = 0, indexable = 0, collisions = 0, tautological = 0;
const seenSlugs = [];

for (const r of rows) {
  const valueSlug = facetSlug(r.attr_slug, r.value);
  const catSlug = r.category_slug;
  // Skip tautological facets where the attribute value just restates the category
  // ("Porcelain" in porcelain-tile, "Quartz" in quartz-countertops) — those target
  // nonsense phrases ("porcelain porcelain tile") and duplicate the category page.
  if (catSlug === valueSlug || catSlug.startsWith(valueSlug + '-') ||
      valueSlug.startsWith(catSlug + '-') || catSlug.split('-').includes(valueSlug)) {
    tautological++; continue;
  }
  // "White Porcelain Tile", "24x48 Porcelain Tile" — value then category name.
  const title = `${r.value} ${r.category_name}`.replace(/\s+/g, ' ').trim();
  const slug = `${valueSlug}-${catSlug}`;
  if (seenSlugs.includes(slug)) { collisions++; continue; } // two values slugify identically → skip the smaller
  seenSlugs.push(slug);

  const count = parseInt(r.product_count, 10);
  const isIndexable = count >= INDEX_MIN;
  if (isIndexable) indexable++;
  const filter = { category: r.category_slug, attributes: { [r.attr_slug]: r.value } };

  if (DRY_RUN) {
    console.log(`  ${isIndexable ? 'IDX' : '   '} /shop/${slug}  (${count})  → ${JSON.stringify(filter)}`);
    continue;
  }

  const res = await pool.query(`
    INSERT INTO landing_pages (type, slug, title, h1, filter_json, is_indexable, product_count, updated_at)
    VALUES ('facet', $1, $2, $2, $3::jsonb, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1, filter_json = EXCLUDED.filter_json,
      is_indexable = EXCLUDED.is_indexable, product_count = EXCLUDED.product_count,
      updated_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS inserted
  `, [slug, title, JSON.stringify(filter), isIndexable, count]);
  if (res.rows[0].inserted) created++; else updated++;
}

// Reconcile: any facet page NOT seen this run has lost all its products → de-index it
// (don't delete — keep the row so its URL 200s/redirects instead of 404-ing a link).
let deindexed = 0;
if (!DRY_RUN && seenSlugs.length) {
  const rec = await pool.query(
    `UPDATE landing_pages SET is_indexable = false, product_count = 0, updated_at = CURRENT_TIMESTAMP
     WHERE type = 'facet' AND is_indexable = true AND slug <> ALL($1)`,
    [seenSlugs]
  );
  deindexed = rec.rowCount;
}

console.log(`\nDone: ${created} created, ${updated} updated, ${indexable} indexable (≥${INDEX_MIN}), ${tautological} tautological skipped, ${collisions} slug collisions skipped, ${deindexed} de-indexed (dropped below floor)`);
await pool.end();
