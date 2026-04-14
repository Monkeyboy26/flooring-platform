#!/usr/bin/env node
/**
 * recategorize-daltile.cjs
 *
 * Moves ~180 miscategorized Daltile products into the correct categories:
 *   - Cove Base products → Wall Base
 *   - Bullnose/Jolly/Chair Rail/Liner/Pencil → Transitions & Moldings
 *   - Plain "Stepwise" tiles (anti-slip finish) → Porcelain Tile
 *   - LVP stair products → Stair Treads & Nosing
 *   - LVP transition products → Transitions & Moldings
 *
 * Usage:
 *   node backend/scripts/recategorize-daltile.cjs --dry-run   # Preview
 *   node backend/scripts/recategorize-daltile.cjs              # Execute
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ─────────────────────────────────────────────────────────────────────────────
// Target category UUIDs
// ─────────────────────────────────────────────────────────────────────────────

const CAT = {
  PORCELAIN_TILE:        '650e8400-e29b-41d4-a716-446655440012',
  TRANSITIONS_MOLDINGS:  '650e8400-e29b-41d4-a716-446655440114',
  WALL_BASE:             '650e8400-e29b-41d4-a716-446655440115',
  STAIR_TREADS:          '650e8400-e29b-41d4-a716-446655440117',
};

// ─────────────────────────────────────────────────────────────────────────────
// Categorization rules — evaluated in priority order, first match wins
// ─────────────────────────────────────────────────────────────────────────────

const RULES = [
  {
    id: 1,
    label: 'Cove Base → Wall Base',
    match: (p) => /\bCv Base\b/i.test(p.name),
    target: CAT.WALL_BASE,
  },
  {
    id: 2,
    label: 'Bullnose from Stair Treads → Transitions & Moldings',
    match: (p) =>
      p.category_id === CAT.STAIR_TREADS &&
      /\bBn\b/i.test(p.name) &&
      !/Cop|Stp|Stair|Tread|Nose/i.test(p.name),
    target: CAT.TRANSITIONS_MOLDINGS,
  },
  {
    id: 3,
    label: 'Stepwise tiles → Porcelain Tile',
    match: (p) =>
      p.category_id === CAT.STAIR_TREADS &&
      /Stepwise/i.test(p.name) &&
      !/\bBn\b|Cop|Stp|Stair|Tread|Nose/i.test(p.name),
    target: CAT.PORCELAIN_TILE,
  },
  {
    id: 4,
    label: 'Trim from Ceramic Tile → Transitions & Moldings',
    match: (p) =>
      p.cat_name === 'Ceramic Tile' &&
      /\b(Bn|Jolly|Chair Rail|Liner|Shelf Rail|Sink Rail|Pencil)\b/i.test(p.name),
    target: CAT.TRANSITIONS_MOLDINGS,
  },
  {
    id: 5,
    label: 'Trim from Porcelain Tile → Transitions & Moldings',
    match: (p) =>
      p.category_id === CAT.PORCELAIN_TILE &&
      /\b(Bn|Liner)\b/i.test(p.name),
    target: CAT.TRANSITIONS_MOLDINGS,
  },
  {
    id: 6,
    label: 'Stair products from LVP → Stair Treads & Nosing',
    match: (p) =>
      p.cat_name === 'LVP (Plank)' &&
      /Stair|Tread|Rndstrd/i.test(p.name),
    target: CAT.STAIR_TREADS,
  },
  {
    id: 7,
    label: 'Transition products from LVP → Transitions & Moldings',
    match: (p) =>
      p.cat_name === 'LVP (Plank)' &&
      /4-In-1|End Cap|Vslcap|Qrtr Round|Vqrnd|Slimt/i.test(p.name),
    target: CAT.TRANSITIONS_MOLDINGS,
  },
  {
    id: 8,
    label: 'Pencil molding from Mosaic Tile → Transitions & Moldings',
    match: (p) =>
      p.cat_name === 'Mosaic Tile' &&
      /Pencil/i.test(p.name) &&
      !/Penny/i.test(p.name),
    target: CAT.TRANSITIONS_MOLDINGS,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Daltile Product Recategorization${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  // Fetch all active Daltile products with their current category
  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.category_id, c.name AS cat_name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'DAL'
      AND p.is_active = true
    ORDER BY p.name
  `);

  console.log(`Found ${products.length} active Daltile products\n`);

  // Classify each product
  const moves = [];       // { product, rule, target }
  const byRule = {};      // rule.id → [product, ...]

  for (const p of products) {
    for (const rule of RULES) {
      if (rule.match(p) && p.category_id !== rule.target) {
        moves.push({ product: p, rule, target: rule.target });
        if (!byRule[rule.id]) byRule[rule.id] = [];
        byRule[rule.id].push(p);
        break; // first match wins
      }
    }
  }

  // Print summary grouped by rule
  const targetNames = {};
  const { rows: cats } = await pool.query(
    `SELECT id, name FROM categories WHERE id = ANY($1)`,
    [Object.values(CAT)]
  );
  for (const c of cats) targetNames[c.id] = c.name;

  for (const rule of RULES) {
    const group = byRule[rule.id] || [];
    console.log(`Rule ${rule.id}: ${rule.label} — ${group.length} products`);
    for (const p of group) {
      console.log(`  ${p.name}  [${p.cat_name || 'uncategorized'} → ${targetNames[rule.target]}]`);
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

  // Execute
  if (DRY_RUN) {
    console.log('Dry run — no changes made. Remove --dry-run to execute.\n');
  } else {
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
