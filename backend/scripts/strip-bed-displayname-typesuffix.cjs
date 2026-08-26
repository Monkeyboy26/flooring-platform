#!/usr/bin/env node
/**
 * strip-bed-displayname-typesuffix.cjs
 *
 * Bedrosians product `display_name`s bake in a category-type suffix (e.g.
 * "Ice White Ceramic Tile") that was generated from the product's category AT
 * THE TIME. When a product is later recategorized (e.g. a wall tile moved to
 * Backsplash & Wall), the baked suffix goes stale — the storefront shows the old
 * "Ceramic Tile" instead of deriving "Wall Tile" from the current category.
 *
 * The storefront (appendTypeSuffix) and documents (composeItemName) both derive
 * the type from the live category, so the suffix should NOT be stored. This strips
 * any trailing type-suffix so the type is always category-driven and self-correcting.
 *
 * Usage: node backend/scripts/strip-bed-displayname-typesuffix.cjs [--dry-run]
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});
const DRY = process.argv.includes('--dry-run');

// Every value from the storefront's _CATEGORY_SUFFIX_MAP — the type labels that
// may have been appended. Longest first so "Natural Stone Tile" strips before "Tile".
const SUFFIXES = [
  'Natural Stone Tile', 'Wood Look Tile', 'Large Format Tile', 'Commercial Tile',
  'Decorative Tile', 'Backsplash Tile', 'Fluted Tile', 'Porcelain Tile', 'Ceramic Tile',
  'Mosaic Tile', 'Pool Tile', 'Wall Tile', 'Carpet Tile',
  'Engineered Hardwood', 'Solid Hardwood', 'Waterproof Wood', 'Hardwood',
  'Porcelain Slab', 'Quartz Countertop', 'Granite Countertop', 'Quartzite Countertop',
  'Marble Countertop', 'Soapstone Countertop', 'Prefabricated Countertop', 'Countertop',
  'Luxury Vinyl Plank', 'Luxury Vinyl Tile', 'Luxury Vinyl', 'SPC Vinyl', 'WPC Vinyl',
  'Sheet Vinyl', 'Laminate', 'Carpet', 'Rubber Flooring', 'Artificial Turf',
  'Stacked Stone', 'Wall Base', 'Molding', 'Stair Tread', 'Paver', 'Underlayment',
].sort((a, b) => b.length - a.length);

function strip(dn) {
  let s = dn;
  // Strip one trailing suffix (repeat once in case of doubles like "... Tile Tile")
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const suf of SUFFIXES) {
      const re = new RegExp('\\s+' + suf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
      if (re.test(s)) { s = s.replace(re, '').trim(); changed = true; break; }
    }
    if (!changed) break;
  }
  return s;
}

async function main() {
  const rows = (await pool.query(`
    SELECT p.id, p.display_name FROM products p JOIN vendors v ON v.id=p.vendor_id
    WHERE v.name='Bedrosians Tile' AND p.display_name IS NOT NULL AND p.display_name <> ''`)).rows;
  const updates = [];
  for (const r of rows) {
    const stripped = strip(r.display_name);
    if (stripped && stripped !== r.display_name) updates.push([r.id, stripped, r.display_name]);
  }
  console.log(`Display names: ${rows.length} | stripping suffix from: ${updates.length}`);
  if (DRY) {
    updates.slice(0, 20).forEach(([, s, o]) => console.log(`  "${o}"  →  "${s}"`));
    await pool.end(); return;
  }
  for (const [id, stripped] of updates) {
    await pool.query('UPDATE products SET display_name=$2 WHERE id=$1', [id, stripped]);
  }
  console.log(`Done. Updated ${updates.length} display_names.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
