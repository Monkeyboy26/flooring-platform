// SEO Phase 3 — build per-city local landing pages.
//
// Mints one landing_pages row (type='local') per service-area city from
// backend/lib/serviceAreas.js. These render at /flooring-installation/{city} via
// seoRenderer.renderLocalPage (HomeAndConstructionBusiness + Service + FAQPage +
// areaServed JSON-LD, scoped to the city). Curated (one per real service city), so
// all are is_indexable=true — no product-count gating like facets.
//
//   node scripts/seo/build-local-pages.mjs [--dry-run]
//   docker compose exec -T api node scripts/seo/build-local-pages.mjs
//
// IDEMPOTENT: upsert by slug. Re-running refreshes the title; stored AI content
// (meta/intro/footer from generate-local-content.mjs) is left untouched.

import { pool } from '../../db.js';
import { SERVICE_CITIES } from '../../lib/serviceAreas.js';

const DRY_RUN = process.argv.includes('--dry-run');

console.log(`${SERVICE_CITIES.length} service cities${DRY_RUN ? ' (DRY RUN)' : ''}`);

let created = 0, updated = 0;
for (const c of SERVICE_CITIES) {
  const title = `Flooring Installation in ${c.city}, CA`;
  const filter = { city: c.city, county: c.county };
  if (DRY_RUN) {
    console.log(`  /flooring-installation/${c.slug}  (${c.city}, ${c.county})`);
    continue;
  }
  const res = await pool.query(`
    INSERT INTO landing_pages (type, slug, title, h1, filter_json, is_indexable, product_count, updated_at)
    VALUES ('local', $1, $2, $2, $3::jsonb, true, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1, filter_json = EXCLUDED.filter_json,
      is_indexable = true, updated_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS inserted
  `, [c.slug, title, JSON.stringify(filter)]);
  if (res.rows[0].inserted) created++; else updated++;
}

console.log(`\nDone: ${created} created, ${updated} updated (${SERVICE_CITIES.length} cities, all indexable)`);
await pool.end();
