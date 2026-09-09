// Local service pages (wave 1) — mint per-city material + remodel landing_pages rows.
//
//   local_material : /flooring-installation/{city}/{material}   (PRIORITY_CITIES × MATERIALS)
//   remodel (hub)  : /remodeling/{city}                         (PRIORITY_CITIES)
//   remodel (room) : /remodeling/{city}/{room}                  (PRIORITY_CITIES × REMODEL_ROOMS)
//
//   node scripts/seo/build-local-service-pages.mjs [--dry-run]
//   docker compose exec -T api node scripts/seo/build-local-service-pages.mjs
//
// IDEMPOTENT: upsert by slug. Refreshes title/h1/filter_json; leaves stored AI content
// (meta/intro/content/footer from generate-local-service-content.mjs) untouched. Curated
// (priority cities only), so every row is is_indexable=true — no product-count gating.

import { pool } from '../../db.js';
import { PRIORITY_CITIES, MATERIALS, REMODEL_ROOMS } from '../../lib/localServices.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Build the full row list: {type, slug, title, filter}.
const rows = [];
for (const c of PRIORITY_CITIES) {
  for (const m of MATERIALS) {
    rows.push({
      type: 'local_material',
      slug: `${c.slug}-${m.slug}`,
      title: `${m.name} Installation in ${c.city}, CA`,
      filter: { city: c.city, county: c.county, citySlug: c.slug, materialSlug: m.slug, material: { slug: m.slug, name: m.name } },
      url: `/flooring-installation/${c.slug}/${m.slug}`,
    });
  }
  // Remodel hub.
  rows.push({
    type: 'remodel',
    slug: `remodeling-${c.slug}`,
    title: `Kitchen & Bath Remodeling in ${c.city}, CA`,
    filter: { city: c.city, county: c.county, citySlug: c.slug, room: null },
    url: `/remodeling/${c.slug}`,
  });
  for (const r of REMODEL_ROOMS) {
    rows.push({
      type: 'remodel',
      slug: `remodeling-${c.slug}-${r.slug}`,
      title: `${r.name} in ${c.city}, CA`,
      filter: { city: c.city, county: c.county, citySlug: c.slug, room: { slug: r.slug, name: r.name } },
      url: `/remodeling/${c.slug}/${r.slug}`,
    });
  }
}

console.log(`${rows.length} local service pages across ${PRIORITY_CITIES.length} priority cities${DRY_RUN ? ' (DRY RUN)' : ''}`);
if (DRY_RUN) {
  for (const r of rows) console.log(`  ${r.url}  [${r.type}]`);
  await pool.end();
  process.exit(0);
}

let created = 0, updated = 0;
for (const r of rows) {
  const res = await pool.query(`
    INSERT INTO landing_pages (type, slug, title, h1, filter_json, is_indexable, product_count, updated_at)
    VALUES ($1, $2, $3, $3, $4::jsonb, true, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (slug) DO UPDATE SET
      type = EXCLUDED.type, title = EXCLUDED.title, h1 = EXCLUDED.h1,
      filter_json = EXCLUDED.filter_json, is_indexable = true, updated_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS inserted
  `, [r.type, r.slug, r.title, JSON.stringify(r.filter)]);
  if (res.rows[0].inserted) created++; else updated++;
}

console.log(`\nDone: ${created} created, ${updated} updated (${rows.length} rows, all indexable)`);
await pool.end();
