#!/usr/bin/env node
/**
 * One-time backfill script: generate URL slugs for all products.
 *
 * Usage:
 *   node backend/scripts/generate-product-slugs.cjs --dry-run   # preview only
 *   node backend/scripts/generate-product-slugs.cjs              # live update
 */
const { Pool } = require('pg');

const dryRun = process.argv.includes('--dry-run');

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/flooring_pim'
  });

  try {
    // Ensure slug column exists
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_slug_unique ON products (slug) WHERE slug IS NOT NULL`);

    // Fetch all products that need slugs
    const { rows: products } = await pool.query(`
      SELECT id, name, collection, display_name
      FROM products
      WHERE slug IS NULL
      ORDER BY created_at
    `);

    console.log(`Found ${products.length} products without slugs${dryRun ? ' (DRY RUN)' : ''}`);

    // Track used slugs (including existing ones)
    const { rows: existingSlugs } = await pool.query(`SELECT slug FROM products WHERE slug IS NOT NULL`);
    const usedSlugs = new Set(existingSlugs.map(r => r.slug));

    let updated = 0;
    let collisions = 0;

    for (const p of products) {
      const displayName = p.display_name || p.name;
      const base = slugify((p.collection ? p.collection + ' ' : '') + displayName);

      if (!base) {
        console.log(`  SKIP (empty slug): id=${p.id} name="${p.name}" collection="${p.collection}"`);
        continue;
      }

      let slug = base;
      let suffix = 2;
      while (usedSlugs.has(slug)) {
        slug = `${base}-${suffix}`;
        suffix++;
        collisions++;
      }

      usedSlugs.add(slug);

      if (dryRun) {
        console.log(`  ${slug} ← "${p.collection}" / "${displayName}"`);
      } else {
        await pool.query(`UPDATE products SET slug = $1 WHERE id = $2`, [slug, p.id]);
      }
      updated++;
    }

    console.log(`\n${dryRun ? 'Would update' : 'Updated'}: ${updated} products`);
    if (collisions > 0) console.log(`Collisions resolved: ${collisions}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
