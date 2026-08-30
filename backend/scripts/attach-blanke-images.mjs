#!/usr/bin/env node
/**
 * Emser sundries — attach Blanke brand-site images (2026-08-30)
 *
 * Emser's Transitions & Moldings (and related profile/underlayment sundries)
 * are Blanke Corp products (Aqua Keil, Cove, Corner Angle, Permat, ...).
 * Emser has no imagery for them, but blankecorp.com hosts per-line product
 * renders. This attaches the matching line image as a PRODUCT-level primary
 * for photoless products only.
 *
 * Matching: keyword → line slug, most-specific-first. Generic profile words
 * (cove, reducer, sill, corner angle, quarter circle, skirting) additionally
 * require a metal/PVC material token in the product name so ceramic tile trim
 * (Emser's own bullnose/cove base) can never match a Blanke render.
 *
 * Line images live in backend/data/blanke/line-images.json (harvested from
 * blankecorp.com line pages; Drupal ?itok URLs are stable hotlinks).
 *
 * Usage:
 *   node backend/scripts/attach-blanke-images.mjs --dry-run
 *   node backend/scripts/attach-blanke-images.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const LINES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/blanke/line-images.json'), 'utf8'));

// Most-specific-first. [regex, slug, requiresMaterial]
// requiresMaterial: only match when the name also names a profile material —
// keeps ceramic trim (cove base, quarter round bullnose) away from metal renders.
const RULES = [
  [/aqua\s*keil\s*wall/i, 'blanke-aqua-keil-wall', false],
  [/aqua\s*keil\s*glass/i, 'blanke-aqua-keil-glass-0', false],
  [/aqua\s*keil/i, 'blanke-aqua-keil', false],
  [/aqua\s*shield\s*corner/i, 'blanke-aqua-shield-corner', false],
  [/aqua\s*shield/i, 'blanke-aqua-shield', false],
  [/aqua\s*wm/i, 'blanke-aqua-wm', false],
  [/aqua\s*seal/i, 'blanke-aqua-seal', false],
  [/aqua\s*deco/i, 'blanke-aqua-deco', false],
  [/aqua\s*glass/i, 'blanke-aqua-glass', false],
  [/di[\s-]*secure/i, 'blanke-di-secure', false],
  [/permatop\s*bf/i, 'blanke-permatop-bf', false],
  [/permatop\s*sf/i, 'blanke-permatop-sf', false],
  [/permat\b/i, 'blanke-permat', false],
  [/secumat/i, 'blanke-secumat', false],
  [/triboard/i, 'blanke-triboard-0', false],
  [/flatbase/i, 'blanke-flatbase-and-accessories', false],
  [/floorex/i, 'blanke-floorex-0', false],
  [/eckbert/i, 'blanke-eckbert', false],
  [/ultrapol/i, 'blanke-ultrapol-0', false],
  [/diba.*(grate|cover)/i, 'blanke-diba-line-grate-covers', false],
  [/diba.*join/i, 'blanke-diba-line-joiner', false],
  [/teba\s*mat/i, 'blanke-teba-mat', false],
  [/drain\s*mat/i, 'blanke-drain-mat', false],
  [/gravel\s*(deck|edge)/i, 'blanke-balcony-gravel-deck-edge', false],
  [/balcony\s*edge\s*protector\s*plus/i, 'blanke-balcony-edge-protector-plus', false],
  [/balcony\s*edge\s*protector\s*pro\b/i, 'blanke-balcony-edge-protector-pro', false],
  [/de[\s-]profile/i, 'blanke-de-profile', false],
  [/new\s*york/i, 'blanke-new-york-edition', false],
  [/decoline/i, 'blanke-decoline', false],
  [/floor\s*accent/i, 'blanke-floor-accent-profile', false],
  [/corner\s*angle\s*plus/i, 'blanke-corner-angle-plus', true],
  [/corner\s*angle/i, 'blanke-corner-angle', true],
  [/corner\s*pro\b/i, 'blanke-corner-pro', true],
  [/f[\s-]profile/i, 'blanke-f-profile', true],
  [/quarter\s*circle/i, 'blanke-quarter-circle-tile-trim', true],
  [/sill\s*profile|window\s*sill/i, 'blanke-sill-profile', true],
  [/carpet\s*(trim|edge)/i, 'blanke-carpet-trim', true],
  [/cove\s*cover/i, 'blanke-cove-cover', true],
  [/\bcove\b/i, 'blanke-cove', true],
  [/t[\s-]*transition|ttransition/i, 'blanke-t-transition', true],
  [/self[\s-]*adhesive.*transition/i, 'blanke-self-adhesive-transition-profile', true],
  [/reducer/i, 'blanke-reducer-trim', true],
  [/skirting/i, 'blanke-skirting', true],
  [/anti[\s-]*skid.*hd|hd.*anti[\s-]*skid/i, 'blanke-hd-anti-skid-step-strip', false],
  [/anti[\s-]*skid/i, 'blanke-anti-skid-step-strip', false],
  [/stepline/i, 'blanke-stepline', false],
  [/deco\s*stair\s*nose/i, 'blanke-deco-stair-nose-profile', false],
  [/stair\s*nose|stairnose/i, 'blanke-classic-stair-nose', false],
  [/expansion\s*(joint|jnt).*(hd|heavy)|hd\s*expansion|heavy\s*duty\s*expansion/i, 'blanke-heavy-duty-expansion-joint', true],
  [/v[\s-]*screed|screed\s*expansion/i, 'blanke-v-screed-expansion-joint', false],
  [/expansion\s*(joint|jnt)/i, 'blanke-heavy-duty-expansion-joint', true],
];

const MATERIAL = /\b(alum(inum|inium)?|pvc|stainless|steel|brass|anod|powdercoat|metal|titanium)\b|\bst\.?\s*(steel|stl)\b/i;

function matchLine(name) {
  for (const [re, slug, needsMat] of RULES) {
    if (!re.test(name)) continue;
    if (needsMat && !MATERIAL.test(name)) continue;
    return slug;
  }
  return null;
}

function bestImage(slug) {
  const entry = LINES[slug];
  if (!entry) return null;
  return entry.productImages?.[0] || entry.gallery?.[0] || null;
}

async function main() {
  console.log(`=== Attach Blanke line images ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);
  const { rows } = await pool.query(`
    SELECT p.id, p.name, c.name category
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'EMS' AND p.status = 'active'
      AND c.name IN ('Transitions & Moldings','Stair Treads & Nosing','Surface Prep & Levelers',
                     'Trim & Accessories','Underlayment','Shower Systems','Floor Heating',
                     'Installation & Sundries','Functional Hardware')
      AND NOT EXISTS (SELECT 1 FROM media_assets m JOIN skus s2 ON s2.id = m.sku_id WHERE s2.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM media_assets m2 WHERE m2.product_id = p.id AND m2.sku_id IS NULL AND m2.asset_type = 'primary')
  `);
  console.log(`Photoless candidate products: ${rows.length}`);

  const bySlug = new Map();
  let matched = 0, unmatchedSample = [];
  const inserts = [];
  for (const r of rows) {
    const slug = matchLine(r.name);
    if (!slug) { if (unmatchedSample.length < 20) unmatchedSample.push(r.name); continue; }
    const url = bestImage(slug);
    if (!url) continue;
    matched++;
    bySlug.set(slug, (bySlug.get(slug) || 0) + 1);
    inserts.push({ productId: r.id, url });
  }

  console.log(`Matched to a Blanke line: ${matched}`);
  console.log('\nPer line:');
  for (const [slug, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${slug}`);
  console.log('\nUnmatched sample:');
  unmatchedSample.forEach(n => console.log(`  ✗ ${n}`));

  if (!DRY_RUN && inserts.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ins of inserts) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, NULL, 'primary', $2, $2, 0, 'blanke-brand-site')
        `, [ins.productId, ins.url]);
      }
      await client.query('COMMIT');
      console.log(`\nInserted ${inserts.length} product-level primaries.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
