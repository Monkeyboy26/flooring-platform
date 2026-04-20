#!/usr/bin/env node
/**
 * Clean Daltile Superguard from Display Names
 *
 * Strips "Superguardx Technology" / "Superguard Technology" from:
 *   - products.display_name
 *   - products.name
 *
 * These are finish descriptors, not part of the product name.
 * The finish is already captured as a `finish` sku_attribute.
 *
 * Usage:
 *   node backend/scripts/cleanup-daltile-superguard.cjs --dry-run   # Preview
 *   node backend/scripts/cleanup-daltile-superguard.cjs              # Execute
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Pattern matches "Superguard Technology" and "Superguardx Technology" (case-insensitive)
const SUPERGUARD_RE = /\s*Superguardx?\s*Technology\s*/gi;

function cleanName(name) {
  if (!name) return name;
  return name.replace(SUPERGUARD_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

async function main() {
  const client = await pool.connect();
  console.log(`\n=== Daltile Superguard Cleanup (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    // Get DAL vendor ID
    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
    if (!vendorRes.rows.length) { console.error('DAL vendor not found'); return; }
    const dalVendorId = vendorRes.rows[0].id;

    // ─── Fix display_name ──────────────────────────────────────────────
    console.log('--- Step 1: Fix display_name ---');

    const displayRes = await client.query(`
      SELECT id, display_name FROM products
      WHERE vendor_id = $1 AND status = 'active'
        AND display_name ~* 'Superguardx?\\s*Technology'
    `, [dalVendorId]);

    let displayFixed = 0;
    for (const row of displayRes.rows) {
      const cleaned = cleanName(row.display_name);
      if (cleaned === row.display_name) continue;

      if (DRY_RUN && displayFixed < 20) {
        console.log(`  display_name: "${row.display_name}" → "${cleaned}"`);
      }

      if (!DRY_RUN) {
        await client.query(`UPDATE products SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [cleaned, row.id]);
      }
      displayFixed++;
    }
    console.log(`Display names fixed: ${displayFixed}\n`);

    // ─── Fix product name ──────────────────────────────────────────────
    console.log('--- Step 2: Fix product name ---');

    const nameRes = await client.query(`
      SELECT id, name FROM products
      WHERE vendor_id = $1 AND status = 'active'
        AND name ~* 'Superguardx?\\s*Technology'
    `, [dalVendorId]);

    let namesFixed = 0;
    let namesMerged = 0;
    for (const row of nameRes.rows) {
      const cleaned = cleanName(row.name);
      if (cleaned === row.name) continue;

      // Check if the cleaned name already exists (unique constraint: vendor_id + collection + name)
      const existing = await client.query(`
        SELECT id FROM products
        WHERE vendor_id = $1 AND name = $2 AND id != $3 AND status = 'active'
        LIMIT 1
      `, [dalVendorId, cleaned, row.id]);

      if (existing.rows.length > 0) {
        // Merge: move SKUs and media to the existing product, then deactivate this one
        const targetId = existing.rows[0].id;
        await client.query(`UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE product_id = $2`, [targetId, row.id]);

        // Move media, ignoring duplicates
        const media = await client.query(`SELECT id FROM media_assets WHERE product_id = $1`, [row.id]);
        for (const m of media.rows) {
          try {
            await client.query(`UPDATE media_assets SET product_id = $1 WHERE id = $2`, [targetId, m.id]);
          } catch (e) {
            if (e.code === '23505') {
              await client.query(`DELETE FROM media_assets WHERE id = $1`, [m.id]);
            } else throw e;
          }
        }

        await client.query(`UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
        if (DRY_RUN && namesMerged < 10) {
          console.log(`  MERGE: "${row.name}" → existing "${cleaned}"`);
        }
        namesMerged++;
      } else {
        if (DRY_RUN && namesFixed < 20) {
          console.log(`  name: "${row.name}" → "${cleaned}"`);
        }

        if (!DRY_RUN) {
          await client.query(`UPDATE products SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [cleaned, row.id]);
        }
        namesFixed++;
      }
    }
    console.log(`Product names fixed: ${namesFixed}`);
    console.log(`Product names merged (duplicate): ${namesMerged}\n`);

    // ─── Summary ──────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log('=== DRY RUN — Rolling back ===');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('=== Changes committed ===');
    }

    console.log(`\nSummary:`);
    console.log(`  Display names fixed: ${displayFixed}`);
    console.log(`  Product names fixed: ${namesFixed}`);
    console.log(`  Product names merged: ${namesMerged}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
