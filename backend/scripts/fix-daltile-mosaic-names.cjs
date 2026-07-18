#!/usr/bin/env node
/**
 * fix-daltile-mosaic-names.cjs
 *
 * Backfills the mosaic pattern into Daltile variant names. Coveo omits
 * shape/designpattern for most mosaic sheets, so SKUs like D014STJ22MT ended
 * up as "2X2, Matte" — nothing says it's a straight-joint mosaic sheet.
 * The pattern is derived from the SKU's item code (see PATTERN_LABELS in
 * daltile-image-match.cjs) and inserted after the size:
 *   "2X2, Matte" → "2X2, Straight Joint Mosaic, Matte"
 *
 * Rows whose variant_name already names a pattern (ledger panels say
 * "Stacked", picket/chevron rows carry Coveo's shape) are left untouched.
 *
 * Usage:
 *   node backend/scripts/fix-daltile-mosaic-names.cjs --dry-run
 *   node backend/scripts/fix-daltile-mosaic-names.cjs
 */

const { Pool } = require('pg');
const { patternFromVendorSku } = require('../scrapers/daltile-image-match.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const PATTERN_WORDS = /mosaic|joint|cube|herringbone|chevron|penny|hex|picket|stacked|wave|arch/i;

function insertPattern(variantName, label) {
  if (!variantName) return label;
  const parts = variantName.split(', ');
  // After the leading size part when there is one, otherwise first
  const at = /\d/.test(parts[0]) ? 1 : 0;
  parts.splice(at, 0, label);
  return parts.join(', ');
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE MOSAIC NAME BACKFILL ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.vendor_sku ~ '(STJ|STK|HERR|BRKJ|CHEV|HEXMS|PNYRD|3DC|PKT|MS[0-9]|MSMT|MSGL|MS1P|WAVE|ARCH)'
  `);

  const updates = [];
  for (const r of rows) {
    if (PATTERN_WORDS.test(r.variant_name || '')) continue;
    const label = patternFromVendorSku(r.vendor_sku);
    if (!label) continue;
    updates.push({ ...r, newName: insertPattern(r.variant_name, label) });
  }

  console.log(`Mosaic-coded SKUs: ${rows.length}, missing pattern: ${updates.length}\n`);
  console.log('Sample (first 10):');
  for (const u of updates.slice(0, 10)) {
    console.log(`  ${u.vendor_sku} (${u.product_name})`);
    console.log(`    "${u.variant_name}" → "${u.newName}"`);
  }

  if (DRY_RUN) {
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  if (updates.length === 0) {
    console.log('\nNothing to fix.');
    await pool.end();
    return;
  }

  console.log(`\nApplying ${updates.length} updates...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        `UPDATE skus SET variant_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [u.id, u.newName]
      );
    }
    await client.query('COMMIT');
    console.log(`Committed ${updates.length} updates.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
