// SEO Phase 4 — build pillar buying-guide pages.
//
// Mints curated landing_pages rows (type='guide') for high-intent informational
// queries that link INTO the money pages (categories). Rendered at /guides/{slug}
// via seoRenderer.renderGuidePage (Article + FAQPage + BreadcrumbList JSON-LD).
// generate-guide-content.mjs fills the long-form body + FAQ.
//
//   node scripts/seo/build-guides.mjs [--dry-run]
//   docker compose exec -T api node scripts/seo/build-guides.mjs
//
// IDEMPOTENT: upsert by slug; refreshes title/filter_json, leaves stored AI content.
// filter_json = { kind, related:[categorySlug], angle }. kind='calculator' flags the
// one interactive cost-estimator page (the SPA renders a widget on it).

import { pool } from '../../db.js';

const GUIDES = [
  { slug: 'how-to-choose-porcelain-tile', title: 'How to Choose Porcelain Tile: A Complete Buying Guide', related: ['porcelain-tile', 'ceramic-tile'], angle: 'PEI rating, water absorption, rectified vs non-rectified, finish, size, indoor/outdoor, cost vs ceramic.' },
  { slug: 'lvp-vs-laminate', title: 'LVP vs Laminate Flooring: Which Should You Choose?', related: ['lvp-plank', 'laminate'], angle: 'waterproofing, durability, feel, cost, installation, best rooms, resale.' },
  { slug: 'engineered-vs-solid-hardwood', title: 'Engineered vs Solid Hardwood: Which Is Right for You?', related: ['engineered-hardwood'], angle: 'construction, moisture/subfloor tolerance, refinishing, cost, where each works.' },
  { slug: 'best-waterproof-flooring', title: 'The Best Waterproof Flooring for Any Room', related: ['lvp-plank', 'porcelain-tile'], angle: 'waterproof vs water-resistant, LVP, porcelain tile, kitchens/baths/basements.' },
  { slug: 'how-to-measure-a-room-for-flooring', title: 'How to Measure a Room for Flooring (Step by Step)', related: ['porcelain-tile', 'lvp-plank', 'engineered-hardwood'], angle: 'measuring sqft, waste factor by material/pattern, cartons/boxes, diagonal/herringbone allowance.' },
  { slug: 'tile-sizes-explained', title: 'Tile Sizes Explained: How to Pick the Right One', related: ['porcelain-tile', 'mosaic-tile'], angle: 'common sizes, large-format, how size affects grout lines and room feel, layout.' },
  { slug: 'choosing-bathroom-floor-tile', title: 'Choosing Bathroom Floor Tile: What to Know', related: ['porcelain-tile', 'natural-stone', 'mosaic-tile'], angle: 'slip resistance (DCOF), porcelain vs stone, small-format for shower floors, maintenance.' },
  { slug: 'kitchen-backsplash-tile-guide', title: 'Kitchen Backsplash Tile Guide: Materials, Layouts & Ideas', related: ['backsplash-wall', 'mosaic-tile', 'ceramic-tile'], angle: 'materials, mosaic vs subway, layout patterns, coverage/measuring, grout.' },
  { slug: 'quartz-vs-natural-stone-countertops', title: 'Quartz vs Natural Stone Countertops: A Comparison', related: ['quartz-countertops', 'natural-stone'], angle: 'durability, maintenance/sealing, heat/scratch, look, cost.' },
  { slug: 'best-flooring-for-pets', title: 'The Best Flooring for Pets and High-Traffic Homes', related: ['lvp-plank', 'porcelain-tile'], angle: 'scratch/stain resistance, waterproof, traction, easy cleaning.' },
  { slug: 'hardwood-flooring-finishes-explained', title: 'Hardwood Flooring Finishes Explained', related: ['engineered-hardwood'], angle: 'matte vs satin vs gloss, wire-brushed, oil vs urethane, durability and look.' },
  { slug: 'carpet-buying-guide', title: 'Carpet Buying Guide: Fibers, Pile & Padding', related: ['broadloom-carpet'], angle: 'fiber types, pile height/density, padding, durability ratings, best rooms.' },
  { slug: 'mosaic-tile-guide', title: 'Mosaic Tile Guide: Uses, Patterns & Installation', related: ['mosaic-tile', 'backsplash-wall'], angle: 'sheet-mounted mosaics, materials, accent walls/floors/showers, measuring sheets.' },
  { slug: 'flooring-cost-calculator', title: 'Flooring Cost Calculator: Estimate Your Project', related: ['porcelain-tile', 'lvp-plank', 'engineered-hardwood', 'laminate', 'broadloom-carpet'], angle: 'what drives flooring cost (material, install, subfloor, waste), typical ranges by material, how to budget. This page also hosts an interactive estimator.', kind: 'calculator' },
];

const DRY_RUN = process.argv.includes('--dry-run');
console.log(`${GUIDES.length} guides${DRY_RUN ? ' (DRY RUN)' : ''}`);

let created = 0, updated = 0;
for (const g of GUIDES) {
  const filter = { kind: g.kind || 'guide', related: g.related, angle: g.angle };
  if (DRY_RUN) { console.log(`  /guides/${g.slug}  (${g.kind || 'guide'})  → ${g.title}`); continue; }
  const res = await pool.query(`
    INSERT INTO landing_pages (type, slug, title, h1, filter_json, is_indexable, product_count, updated_at)
    VALUES ('guide', $1, $2, $2, $3::jsonb, true, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1,
      filter_json = landing_pages.filter_json || $3::jsonb,
      is_indexable = true, updated_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS inserted
  `, [g.slug, g.title, JSON.stringify(filter)]);
  if (res.rows[0].inserted) created++; else updated++;
}
console.log(`\nDone: ${created} created, ${updated} updated (${GUIDES.length} guides, all indexable)`);
await pool.end();
