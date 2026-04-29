#!/usr/bin/env node
/**
 * emser-fix-image-types.cjs
 *
 * One-time cleanup script to fix misclassified Emser images in media_assets.
 *
 * What it does:
 *   1. Reclassify 'alternate' images that have room scene / lifestyle keywords → 'lifestyle'
 *   2. Reclassify 'lifestyle' images with _f1 / _f2 in filename → 'primary' / 'alternate'
 *   3. Re-sort images per SKU: primary=0, alternates=1,2,..., lifestyles=0,1,2,...
 *   4. Remove product-level duplicates where the same URL exists at SKU level
 *
 * Usage:
 *   node backend/scripts/emser-fix-image-types.cjs --dry-run
 *   node backend/scripts/emser-fix-image-types.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Classify an Emser image URL by filename pattern.
 * Returns 'primary', 'alternate', or 'lifestyle'.
 */
function classifyEmserImage(url) {
  const filename = (url || '').split('/').pop().toLowerCase();

  if (/_scan_f\d/.test(filename)) return 'primary';
  if (/_f1[_.]|_f1$/.test(filename)) return 'primary';
  if (/_f\d+/.test(filename)) return 'alternate';
  if (/_roomscene[_.]|_roomscene\d/.test(filename)) return 'lifestyle';
  if (/_rs\d/.test(filename)) return 'lifestyle';
  if (/_expanse[_.]|_vignette[_.]|_expanse\d|_vignette\d/.test(filename)) return 'lifestyle';

  // Fallback: generic lifestyle keywords
  if (/room|scene|lifestyle|installed|roomscene|application|vignette/.test(filename)) {
    return 'lifestyle';
  }

  return 'alternate';
}

async function main() {
  console.log(`Emser image type fix — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Get Emser vendor ID
  const vr = await pool.query("SELECT id FROM vendors WHERE code = 'EMSER'");
  if (!vr.rows.length) { console.error('Vendor EMSER not found'); process.exit(1); }
  const vendorId = vr.rows[0].id;

  // ── Step 1 & 2: Reclassify mistyped images ──────────────────────────────
  const allImages = await pool.query(`
    SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, ma.sort_order
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
      AND ma.asset_type IN ('primary', 'alternate', 'lifestyle')
    ORDER BY ma.product_id, ma.sku_id NULLS LAST, ma.sort_order
  `, [vendorId]);

  console.log(`Found ${allImages.rows.length} Emser images total`);

  // ── Steps 1-3 combined: reclassify + re-sort per group ──────────────────
  // Merged into one pass because changing asset_type and sort_order independently
  // can violate the unique constraint (product_id, sku_id, asset_type, sort_order).
  // We move all images in a group to temp offsets, then set correct type + sort.

  // Group by (product_id, sku_id)
  const groups = new Map();
  for (const row of allImages.rows) {
    const key = `${row.product_id}:${row.sku_id || 'null'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let reclassified = 0;
  let sortFixed = 0;
  const reclassBreakdown = {};

  for (const [, imgs] of groups) {
    // Classify all images
    for (const img of imgs) {
      img._correctType = classifyEmserImage(img.url);
    }

    // Deduplicate primaries: only the first stays primary, rest become alternate
    let foundPrimary = false;
    for (const img of imgs) {
      if (img._correctType === 'primary') {
        if (foundPrimary) {
          img._correctType = 'alternate';
        } else {
          foundPrimary = true;
        }
      }
    }

    // If no primary exists, promote the best product-shot candidate
    if (!foundPrimary && imgs.length > 0) {
      const nonLifestyle = imgs.filter(i => i._correctType !== 'lifestyle');
      const candidates = nonLifestyle.length > 0 ? nonLifestyle : imgs;
      // Score: prefer _hr (high-res product), sku-code in filename, shorter names (less descriptive = swatch)
      // Penalize: room, scene, floor, installed, hexagon+plain (combo shots)
      const best = candidates.reduce((a, b) => {
        const scoreImg = (img) => {
          const fn = (img.url || '').split('/').pop().toLowerCase();
          let s = 0;
          if (/_hr[_.]/.test(fn)) s += 10;           // high-res product shot
          if (/product|swatch|chip|closeup/.test(fn)) s += 10;
          if (/f\d{2}[a-z]{4}/.test(fn)) s += 5;    // starts with sku code pattern
          if (fn.length < 40) s += 3;                // shorter = more likely a swatch
          if (/room|scene|floor|installed|chronicle/.test(fn)) s -= 10;
          if (/and\s/.test(fn)) s -= 5;              // "X and Y" = combo shot
          return s;
        };
        return scoreImg(b) > scoreImg(a) ? b : a;
      });
      best._correctType = 'primary';
      foundPrimary = true;
    }

    // Compute correct sort orders
    let altSort = 1;
    let lifeSort = 0;
    let hasChanges = false;

    for (const img of imgs) {
      if (img._correctType === 'primary') {
        img._correctSort = 0;
      } else if (img._correctType === 'lifestyle') {
        img._correctSort = lifeSort++;
      } else {
        img._correctSort = altSort++;
      }

      const typeChanged = img._correctType !== img.asset_type;
      const sortChanged = img._correctSort !== img.sort_order;

      if (typeChanged) {
        reclassified++;
        const key = `${img.asset_type} → ${img._correctType}`;
        reclassBreakdown[key] = (reclassBreakdown[key] || 0) + 1;
      }
      if (sortChanged) sortFixed++;
      if (typeChanged || sortChanged) hasChanges = true;
    }

    if (hasChanges && !DRY_RUN) {
      // Move ALL images in this group to temp offsets to avoid unique conflicts
      for (let j = 0; j < imgs.length; j++) {
        await pool.query(
          'UPDATE media_assets SET asset_type = $1, sort_order = $2 WHERE id = $3',
          ['alternate', 10000 + j, imgs[j].id]
        );
      }
      // Set correct type + sort for all images in the group
      for (const img of imgs) {
        await pool.query(
          'UPDATE media_assets SET asset_type = $1, sort_order = $2 WHERE id = $3',
          [img._correctType, img._correctSort, img.id]
        );
      }
    }
  }

  console.log(`\nStep 1-2: ${reclassified} images reclassified`);
  for (const [key, count] of Object.entries(reclassBreakdown)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`\nStep 3: ${sortFixed} sort orders fixed`);

  // ── Step 4: Remove product-level duplicates ─────────────────────────────
  // Find product-level images (sku_id IS NULL) where the same URL also exists
  // at SKU level (sku_id IS NOT NULL) for the same product
  const dupes = await pool.query(`
    SELECT pl.id, pl.product_id, pl.url, pl.asset_type
    FROM media_assets pl
    JOIN products p ON p.id = pl.product_id
    WHERE p.vendor_id = $1
      AND pl.sku_id IS NULL
      AND pl.asset_type IN ('primary', 'alternate', 'lifestyle')
      AND EXISTS (
        SELECT 1 FROM media_assets sl
        WHERE sl.product_id = pl.product_id
          AND sl.sku_id IS NOT NULL
          AND sl.url = pl.url
      )
  `, [vendorId]);

  console.log(`\nStep 4: ${dupes.rows.length} product-level duplicates found (same URL exists at SKU level)`);
  if (dupes.rows.length > 0 && !DRY_RUN) {
    const dupeIds = dupes.rows.map(r => r.id);
    await pool.query('DELETE FROM media_assets WHERE id = ANY($1)', [dupeIds]);
    console.log(`  Deleted ${dupeIds.length} duplicate rows`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary${DRY_RUN ? ' (DRY RUN — no changes made)' : ''}:`);
  console.log(`  Reclassified:          ${reclassified}`);
  console.log(`  Sort orders fixed:     ${sortFixed}`);
  console.log(`  Product-level dupes:   ${dupes.rows.length}`);
  console.log(`${'='.repeat(60)}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
