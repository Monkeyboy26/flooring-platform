#!/usr/bin/env node
/**
 * fix-layout-primaries.cjs
 *
 * Fixes primary images that are multi-tile layout/arrangement shots
 * (showing tiles laid out in a pattern rather than a single product close-up).
 *
 * Targets:
 *   - Emser Tile: URLs containing 'layout' (256 images, ~178 swappable)
 *   - Daltile: URLs containing 'LivePanel' (144 images, room scenes, 0 swappable)
 *
 * For each layout primary found:
 *   - If a non-layout alternate exists → 3-step swap
 *   - If no suitable alternate → reclassify primary to lifestyle
 *
 * Usage:
 *   node backend/scripts/fix-layout-primaries.cjs --dry-run
 *   node backend/scripts/fix-layout-primaries.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Patterns that indicate multi-tile layout / room scene shots
const LAYOUT_PATTERNS = [
  'layout',
  'livepanel',
];

// These patterns should NOT be in the replacement alternate
const BAD_ALT_PATTERNS = [
  'layout', 'livepanel', 'roomset', 'room_scene',
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor',
  'ambiance', 'vignette', 'hero', 'banner',
  'amb0', 'amb1', '_amb_', '-amb-', 'amb_',
  'crop_upscale', 'gallery', 'roomview', 'insitu', 'in-situ',
  'ambiente', 'bagno', 'cucina', 'soggiorno',
  'posa', 'esterno', 'ambientazione',
];

function isLayoutUrl(url) {
  const lower = url.toLowerCase();
  return LAYOUT_PATTERNS.some(p => lower.includes(p));
}

function isBadAlternate(url, productName) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  const prodLow = (productName || '').toLowerCase();
  return BAD_ALT_PATTERNS.some(kw => filename.includes(kw) && !prodLow.includes(kw));
}

async function main() {
  const client = await pool.connect();
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  try {
    // Find all SKU-level primary images with layout patterns
    const { rows: primaries } = await client.query(`
      SELECT ma.id, ma.product_id, ma.sku_id, ma.url, ma.sort_order,
             p.name as pname, p.collection, v.name as vendor
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE ma.asset_type = 'primary'
        AND ma.sort_order = 0
        AND ma.sku_id IS NOT NULL
        AND (LOWER(ma.url) LIKE '%layout%' OR LOWER(ma.url) LIKE '%livepanel%')
      ORDER BY v.name, p.collection, p.name
    `);

    console.log(`Found ${primaries.length} layout/livepanel primaries\n`);

    if (primaries.length === 0) {
      console.log('Nothing to fix!');
      return;
    }

    // Group by vendor
    const byVendor = {};
    for (const r of primaries) {
      byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
    }
    console.log('By vendor:');
    for (const [v, c] of Object.entries(byVendor).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}: ${c}`);
    }
    console.log('');

    let swapped = 0, reclassified = 0;

    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    for (const row of primaries) {
      const label = `[${row.vendor}] ${row.pname}/${row.collection}`;

      // Find non-layout, non-lifestyle alternate
      const { rows: alternates } = await client.query(`
        SELECT id, url, sort_order FROM media_assets
        WHERE product_id = $1 AND sku_id = $2
          AND asset_type = 'alternate' AND sort_order >= 0
        ORDER BY sort_order LIMIT 10
      `, [row.product_id, row.sku_id]);

      const goodAlt = alternates.find(a =>
        !isLayoutUrl(a.url) && !isBadAlternate(a.url, row.pname)
      );

      if (goodAlt) {
        const tempSort = -(10000 + swapped);
        const safeSort = 20 + swapped;

        if (!DRY_RUN) {
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [tempSort, row.id]
          );
          await client.query(
            `UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`,
            [goodAlt.id]
          );
          await client.query(
            `UPDATE media_assets SET sort_order = $1 WHERE id = $2`,
            [safeSort, row.id]
          );
        }

        console.log(`SWAP  ${label}`);
        console.log(`      old: ${row.url.split('/').pop().substring(0, 60)}`);
        console.log(`      new: ${goodAlt.url.split('/').pop().substring(0, 60)}`);
        swapped++;
      } else {
        // No good alternate — reclassify
        const maxSortRes = await client.query(`
          SELECT COALESCE(MAX(sort_order), 0) + 1 as next_sort
          FROM media_assets WHERE product_id = $1 AND sku_id = $2
            AND asset_type = 'lifestyle' AND sort_order >= 0
        `, [row.product_id, row.sku_id]);
        const nextSort = Math.max(parseInt(maxSortRes.rows[0].next_sort), 30);

        if (!DRY_RUN) {
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [nextSort, row.id]
          );
        }

        console.log(`RECL  ${label}`);
        console.log(`      ${row.url.split('/').pop().substring(0, 60)} → lifestyle (sort ${nextSort})`);
        reclassified++;
      }
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log(`\nCOMMITTED.`);
    }

    console.log(`\nSummary:`);
    console.log(`  Swapped:      ${swapped}`);
    console.log(`  Reclassified: ${reclassified}`);
    console.log(`  Total fixed:  ${swapped + reclassified}`);
    if (DRY_RUN) console.log(`\n(Dry run - no changes made. Remove --dry-run to apply.)`);

  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
