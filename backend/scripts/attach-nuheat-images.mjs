#!/usr/bin/env node
/**
 * Emser sundries — attach Nuheat / STRATA_HEAT brand images (2026-08-30)
 *
 * Emser's Floor Heating category is nVent Nuheat product (mats, custom mats,
 * cable, mesh, thermostats, repair kits) plus Laticrete STRATA_HEAT wire and
 * thermostats. Emser has no imagery; family images harvested from
 * nuheat.com line pages and laticrete.com product pages (cdnmdm feature
 * images) into backend/data/nuheat/line-images.json. Attached as
 * PRODUCT-level primaries for photoless products only.
 *
 * Deliberately skipped: "Nuheat Relay" (no confident image on either site).
 *
 * Usage:
 *   node backend/scripts/attach-nuheat-images.mjs --dry-run
 *   node backend/scripts/attach-nuheat-images.mjs
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

const LINES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/nuheat/line-images.json'), 'utf8'));

// Most-specific-first. Scope is the Floor Heating category only, so keywords
// can be loose within it.
const RULES = [
  [/strata\s*heat.*wifi|strataheat.*wifi/i, 'strata-heat-wifi-thermostat'],
  [/strata\s*heat.*(tstat|therm)|strataheat.*(tstat|therm)/i, 'strata-heat-smart-thermostat'],
  [/strata\s*heat|strataheat/i, 'strata-heat-wire'],
  [/mat\s*repair/i, 'nuheat-mat-repair-kit'],
  [/(lead|cable|wire)\s*.*repair|repair.*(lead|cable|wire)/i, 'nuheat-cable-repair-kit'],
  [/custom\s*mat|extended\s*lead/i, 'nuheat-custom-mat'],
  [/peel\s*stick\s*memb/i, 'nuheat-peel-stick-membrane'],
  [/membrane\s*(sheet|roll)|memb\s*sheet/i, 'nuheat-membrane'],
  [/nuheat\s*mesh/i, 'nuheat-mesh'],
  [/nuheat\s*cable/i, 'nuheat-cable'],
  [/nuheat\s*mat/i, 'nuheat-standard-mat'],
  [/signature|wifi\s*(tstat|therm)/i, 'nuheat-signature-thermostat'],
  [/tstat|therm/i, 'nuheat-home-thermostat'],
];

function matchLine(name) {
  if (/\brelay\b/i.test(name)) return null;
  for (const [re, slug] of RULES) {
    if (re.test(name)) return slug;
  }
  return null;
}

async function main() {
  console.log(`=== Attach Nuheat/STRATA_HEAT line images ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);
  const { rows } = await pool.query(`
    SELECT p.id, p.name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'EMS' AND p.status = 'active' AND c.name = 'Floor Heating'
      AND NOT EXISTS (SELECT 1 FROM media_assets m JOIN skus s2 ON s2.id = m.sku_id WHERE s2.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM media_assets m2 WHERE m2.product_id = p.id AND m2.sku_id IS NULL AND m2.asset_type = 'primary')
  `);
  console.log(`Photoless candidate products: ${rows.length}`);

  const bySlug = new Map();
  let matched = 0;
  const unmatched = [];
  const inserts = [];
  for (const r of rows) {
    const slug = matchLine(r.name);
    if (!slug) { unmatched.push(r.name); continue; }
    const url = LINES[slug]?.image;
    if (!url) continue;
    matched++;
    bySlug.set(slug, (bySlug.get(slug) || 0) + 1);
    inserts.push({ productId: r.id, url });
  }

  console.log(`Matched: ${matched}`);
  console.log('\nPer line:');
  for (const [slug, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${slug}`);
  console.log(`\nUnmatched (${unmatched.length}):`);
  unmatched.slice(0, 20).forEach(n => console.log(`  ✗ ${n}`));

  if (!DRY_RUN && inserts.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ins of inserts) {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, NULL, 'primary', $2, $2, 0, 'nuheat-brand-site')
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
