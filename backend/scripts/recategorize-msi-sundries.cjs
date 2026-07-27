#!/usr/bin/env node
/**
 * recategorize-msi-sundries.cjs
 *
 * MSI's install-accessory catalog was dumped wholesale into two buckets
 * (Adhesives & Sealants + the Installation & Sundries parent). This splits
 * it into the proper leaf categories, and fixes two porcelain ledger panels:
 *   - Tools (trowels, floats, spacers, saws, gloves, etc.) → Tools & Trowels
 *   - Levelers, patch, primers, waterproofing, backer board → Surface Prep & Levelers
 *   - Grout, caulk, mortar, mastic, adhesives              → Adhesives & Sealants
 *   - Peel & stick wallpaper (Wpft)                        → Wall Panels
 *   - Underlayment                                          → Underlayment
 *   - Drain frame / wax bowl ring                           → Trim & Accessories
 *   - Nora porcelain ledger panels                           → Stacked Stone
 *
 * Writes a backup of prior category assignments to
 * backend/data/msi-recategorize-backup-<date>.json before updating.
 *
 * Usage:
 *   node backend/scripts/recategorize-msi-sundries.cjs --dry-run   # Preview
 *   node backend/scripts/recategorize-msi-sundries.cjs             # Execute
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

const CAT = {
  ADHESIVES_SEALANTS: '650e8400-e29b-41d4-a716-446655440111',
  UNDERLAYMENT:       '650e8400-e29b-41d4-a716-446655440112',
  SURFACE_PREP:       '650e8400-e29b-41d4-a716-446655440113',
  TOOLS_TROWELS:      '650e8400-e29b-41d4-a716-446655440118',
  TRIM_ACCESSORIES:   '650e8400-e29b-41d4-a716-446655440119',
  INSTALL_SUNDRIES:   '650e8400-e29b-41d4-a716-446655440110',
  WALL_PANELS:        '650e8400-e29b-41d4-a716-446655440120',
  STACKED_STONE:      '650e8400-e29b-41d4-a716-446655440061',
  PORCELAIN_TILE:     '650e8400-e29b-41d4-a716-446655440012',
};

// Sundry buckets we redistribute from
const SOURCE_CATS = [CAT.ADHESIVES_SEALANTS, CAT.INSTALL_SUNDRIES];

// Evaluated in priority order — first match wins
const RULES = [
  {
    id: 1,
    label: 'Porcelain ledger panels → Stacked Stone',
    match: (p) => p.category_id === CAT.PORCELAIN_TILE && /\bledger\b/i.test(p.name),
    target: CAT.STACKED_STONE,
  },
  {
    id: 2,
    label: 'Peel & stick wallpaper → Wall Panels',
    match: (p) => /\bwpft\b|wallpaper/i.test(p.name) && !/display/i.test(p.name),
    target: CAT.WALL_PANELS,
  },
  {
    id: 3,
    label: 'Underlayment → Underlayment',
    match: (p) => /underlayment/i.test(p.name),
    target: CAT.UNDERLAYMENT,
  },
  {
    id: 4,
    label: 'Levelers / patch / primers / waterproofing / backer → Surface Prep & Levelers',
    match: (p) => /self.?lvl|self.?level|level set|skim coat|\bpatch\b|floor mud|primer|hydraflex|liqui.?dam|backer|gypsum|encapsulator|board tape/i.test(p.name),
    target: CAT.SURFACE_PREP,
  },
  {
    id: 5,
    label: 'Tools & install supplies → Tools & Trowels',
    match: (p) => /trowel|float|nipper|glove|knee pad|\bsaws?\b|blade|scraper|mallet|knife|knives|scoring wheel|tacker|staple|caulking gun|sponge|cheesecloth|towel|wipe|chalk|tape measure|box level|spacer|puller|rubbing stone|snips|plumb|probilt|levolution|masking tape|inseam tape/i.test(p.name),
    target: CAT.TOOLS_TROWELS,
  },
  {
    id: 6,
    label: 'Drain frame / wax bowl ring → Trim & Accessories',
    match: (p) => /drain frame|wax bowl/i.test(p.name),
    target: CAT.TRIM_ACCESSORIES,
  },
  {
    id: 7,
    label: 'Grout / caulk / mortar / adhesives → Adhesives & Sealants',
    match: (p) => /grout|caulk|mortar|mastic|adhesive|\badh\b|sealant|sealer|ult6|accucolor|fusion|millennium|permaflex|permalastic|signature|type1|flexera/i.test(p.name),
    target: CAT.ADHESIVES_SEALANTS,
  },
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  MSI Sundries Recategorization${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.category_id, c.name AS cat_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1
      AND (p.category_id = ANY($2) OR (p.category_id = $3 AND p.name ~* '\\mledger\\M'))
    ORDER BY p.name
  `, [MSI_VENDOR_ID, SOURCE_CATS, CAT.PORCELAIN_TILE]);

  console.log(`Found ${products.length} MSI products in scope\n`);

  const moves = [];
  const byRule = {};
  for (const p of products) {
    for (const rule of RULES) {
      if (rule.match(p)) {
        if (p.category_id !== rule.target) {
          moves.push({ product: p, rule, target: rule.target });
          (byRule[rule.id] = byRule[rule.id] || []).push(p);
        }
        break; // first match wins even if it's a no-op move
      }
    }
  }

  const { rows: cats } = await pool.query(
    `SELECT id, name FROM categories WHERE id = ANY($1)`,
    [Object.values(CAT)]
  );
  const targetNames = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  for (const rule of RULES) {
    const group = byRule[rule.id] || [];
    console.log(`Rule ${rule.id}: ${rule.label} — ${group.length} products`);
    for (const p of group) {
      console.log(`  ${p.name}  [${p.cat_name || 'uncategorized'} → ${targetNames[rule.target]}]`);
    }
    if (group.length) console.log();
  }

  const unmatched = products.filter((p) => !RULES.some((r) => r.match(p)));
  console.log(`Unmatched (stay put): ${unmatched.length}`);
  for (const p of unmatched) console.log(`  ${p.name}  [${p.cat_name}]`);

  console.log(`\n${'─'.repeat(60)}`);
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
      `msi-recategorize-backup-${new Date().toISOString().slice(0, 10)}.json`
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
