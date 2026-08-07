/**
 * Reprice all Orion Flooring SKUs to flat 1.6x keystone on dealer cost
 * (July 2026 price list costs via import-orion-costs-jul2026.mjs).
 *
 * Only SKUs with cost > 0 are repriced; zero-cost SKUs keep their current
 * retail (mostly slabs/vinyl dropped from the vendor list — no reliable cost).
 * Old retail values are backed up to backend/data/ before applying.
 *
 * Usage: node backend/scripts/reprice-orion-keystone.mjs [--dry-run]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';
const DRY_RUN = process.argv.includes('--dry-run');
const MULTIPLIER = 1.6;

async function main() {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, p.name AS product_name, sa.value AS size,
      pr.cost, pr.retail_price
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN attributes a ON a.slug = 'size'
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = a.id
    WHERE p.vendor_id = $1 AND pr.cost > 0
    ORDER BY p.name
  `, [VENDOR_ID]);

  const changes = [];
  for (const r of rows) {
    const cost = parseFloat(r.cost);
    const oldRetail = parseFloat(r.retail_price);
    const newRetail = Math.round(cost * MULTIPLIER * 100) / 100;
    if (newRetail === oldRetail) continue;
    changes.push({
      sku_id: r.sku_id,
      product_name: r.product_name,
      size: r.size,
      cost,
      old_retail: oldRetail,
      new_retail: newRetail,
    });
  }

  console.log(`${rows.length} Orion SKUs with cost > 0, ${changes.length} to reprice${DRY_RUN ? ' (DRY RUN)' : ''}\n`);
  for (const c of changes) {
    console.log(`  ${c.product_name} (${c.size || '—'}): cost $${c.cost} → retail $${c.old_retail} ⇒ $${c.new_retail}`);
  }

  if (!DRY_RUN && changes.length) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, '..', 'data', `orion-reprice-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    for (const c of changes) {
      await pool.query('UPDATE pricing SET retail_price = $2 WHERE sku_id = $1', [c.sku_id, c.new_retail]);
    }
    console.log(`APPLIED — repriced ${changes.length} Orion SKUs to flat ${MULTIPLIER}x keystone.`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
