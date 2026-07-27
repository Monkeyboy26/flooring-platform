#!/usr/bin/env node
/**
 * recategorize-msi-wood-fluted.cjs
 *
 * Follow-up to recategorize-msi-sundries.cjs. Uses the EDI style attribute
 * (PID 38, stored as sku_attributes 'style') plus a small curated collection
 * list to split MSI look-alike categories:
 *   - style ~ Fluted (porcelain + marble slat/ribbo/fluto tile) → Fluted Tile
 *   - Acoustic wood slat wall panels (misfiled as hardwood)     → Wall Panels
 *   - style = Wood porcelain planks                             → Wood Look Tile
 *   - Country River / Palma / Upscape (wood-look, no style attr) → Wood Look Tile
 *
 * Writes a backup of prior category assignments to
 * backend/data/msi-wood-fluted-backup-<date>.json before updating.
 *
 * Usage:
 *   node backend/scripts/recategorize-msi-wood-fluted.cjs --dry-run   # Preview
 *   node backend/scripts/recategorize-msi-wood-fluted.cjs             # Execute
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const MSI_VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

const SLUGS = {
  sources: ['porcelain-tile', 'ceramic-tile', 'natural-stone', 'engineered-hardwood'],
  woodLook: 'wood-look-tile',
  fluted: 'fluted-tile',
  wallPanels: 'wall-panels',
};

// Wood-look collections whose EDI records lack the style attribute
const WOOD_LOOK_COLLECTIONS = /^(country river|palma|upscape)\b/i;

// Evaluated in priority order — first match wins
const RULES = [
  {
    id: 1,
    label: 'Acoustic wood slat panels → Wall Panels',
    match: (p) => /acoustic/i.test(p.name) && /slat|panel/i.test(p.name),
    target: 'wallPanels',
  },
  {
    id: 2,
    label: 'Fluted/slat tile (EDI style ~ Fluted) → Fluted Tile',
    match: (p) => /fluted/i.test(p.styles || ''),
    target: 'fluted',
  },
  {
    id: 3,
    label: 'Wood-look porcelain (EDI style = Wood) → Wood Look Tile',
    match: (p) => /\bwood\b/i.test(p.styles || '') && p.cat_slug !== 'natural-stone',
    target: 'woodLook',
  },
  {
    id: 4,
    label: 'Wood-look collections without style attr → Wood Look Tile',
    match: (p) => WOOD_LOOK_COLLECTIONS.test(p.name) && p.cat_slug === 'porcelain-tile',
    target: 'woodLook',
  },
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  MSI Wood-Look / Fluted Recategorization${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows: cats } = await pool.query(`SELECT id, slug, name FROM categories`);
  const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c]));
  for (const key of ['woodLook', 'fluted', 'wallPanels']) {
    if (!bySlug[SLUGS[key]]) throw new Error(`Missing category slug: ${SLUGS[key]}`);
  }

  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id, c.slug AS cat_slug, c.name AS cat_name,
      (SELECT string_agg(DISTINCT sa.value, ',')
       FROM skus s
       JOIN sku_attributes sa ON sa.sku_id = s.id
       JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'style'
       WHERE s.product_id = p.id) AS styles
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND c.slug = ANY($2)
    ORDER BY p.name
  `, [MSI_VENDOR_ID, SLUGS.sources]);

  console.log(`Found ${products.length} MSI products in scope\n`);

  const moves = [];
  const byRule = {};
  for (const p of products) {
    for (const rule of RULES) {
      if (rule.match(p)) {
        const targetId = bySlug[SLUGS[rule.target]].id;
        if (p.category_id !== targetId) {
          moves.push({ product: p, rule, target: targetId });
          (byRule[rule.id] = byRule[rule.id] || []).push(p);
        }
        break; // first match wins
      }
    }
  }

  for (const rule of RULES) {
    const group = byRule[rule.id] || [];
    console.log(`Rule ${rule.id}: ${rule.label} — ${group.length} products`);
    for (const p of group) {
      console.log(`  ${p.name}  [${p.cat_name} → ${bySlug[SLUGS[rule.target]].name}] (styles: ${p.styles || 'none'})`);
    }
    if (group.length) console.log();
  }

  console.log(`${'─'.repeat(60)}`);
  console.log(`Total moves: ${moves.length}\n`);

  if (moves.length === 0) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log('Dry run — no changes made. Remove --dry-run to execute.\n');
  } else {
    const backupPath = path.join(
      __dirname, '..', 'data',
      `msi-wood-fluted-backup-${new Date().toISOString().slice(0, 10)}.json`
    );
    fs.writeFileSync(backupPath, JSON.stringify(
      moves.map((m) => ({
        product_id: m.product.id,
        name: m.product.name,
        old_category_id: m.product.category_id,
        new_category_id: m.target,
      })), null, 2
    ));
    console.log(`Backup written: ${backupPath}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { product, target } of moves) {
        await client.query(
          `UPDATE products SET category_id = $1, updated_at = NOW() WHERE id = $2`,
          [target, product.id]
        );
      }
      await client.query('COMMIT');
      console.log(`✓ ${moves.length} products recategorized successfully.\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error — rolled back:', err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
