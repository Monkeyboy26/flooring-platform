#!/usr/bin/env node

/**
 * Mannington Image Cross-Pollination
 *
 * Problem: ADURA sub-lines (Flex, Max, Rigid, Apex, Pro) share identical
 * product photos for the same color, but the image scraper only matched
 * images to whichever sub-line's SKU code appeared on mannington.com.
 * Result: Rigid SKUs at 7% image coverage despite the photos existing.
 *
 * Solution: For each (product, variant_name) color group, find a "donor"
 * SKU that has images and copy them to "recipient" SKUs that are missing
 * that asset_type. Uses ON CONFLICT DO NOTHING to skip existing assets.
 *
 * Usage:
 *   docker compose exec api node scripts/cross-pollinate-mannington-images.cjs [flags]
 *
 * Flags:
 *   --dry-run    Show what would be inserted without writing to DB
 *   --verbose    Print per-SKU detail
 */

const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  console.log('='.repeat(64));
  console.log(`  Mannington Image Cross-Pollination — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('='.repeat(64));

  // Step 1: Find all Mannington flooring SKUs grouped by (product_id, variant_name)
  // Include what media assets each SKU already has
  const { rows: skuRows } = await pool.query(`
    SELECT s.id AS sku_id,
           s.vendor_sku,
           s.variant_name,
           s.product_id,
           p.name AS product_name,
           p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.name = 'Mannington'
      AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
      AND s.variant_name IS NOT NULL
      AND s.status = 'active'
    ORDER BY p.name, s.variant_name, s.vendor_sku
  `);

  console.log(`\n  Found ${skuRows.length} flooring SKUs with variant names`);

  // Step 2: Load all existing media_assets for these SKUs
  const skuIds = skuRows.map(r => r.sku_id);
  const { rows: assetRows } = await pool.query(`
    SELECT sku_id, asset_type, sort_order, url, original_url, source
    FROM media_assets
    WHERE sku_id = ANY($1)
    ORDER BY sku_id, asset_type, sort_order
  `, [skuIds]);

  // Build lookup: sku_id → [{ asset_type, sort_order, url, original_url, source }]
  const assetsBySkuId = new Map();
  for (const a of assetRows) {
    if (!assetsBySkuId.has(a.sku_id)) assetsBySkuId.set(a.sku_id, []);
    assetsBySkuId.get(a.sku_id).push(a);
  }

  // Step 3: Group SKUs by (product_id, variant_name)
  const colorGroups = new Map(); // "product_id|variant_name" → [skuRow, ...]
  for (const row of skuRows) {
    const key = `${row.product_id}|${row.variant_name}`;
    if (!colorGroups.has(key)) colorGroups.set(key, []);
    colorGroups.get(key).push(row);
  }

  console.log(`  Color groups: ${colorGroups.size}`);

  // Step 4: For each group, find donor → recipient pairs
  const inserts = []; // { recipient_sku_id, product_id, asset_type, sort_order, url, original_url }
  let groupsWithDonor = 0;
  let groupsAllHave = 0;
  let groupsNoneHave = 0;

  for (const [key, skus] of colorGroups) {
    if (skus.length < 2) continue; // single SKU, nothing to cross-pollinate

    // Collect all asset_types present across the group
    const assetTypeSet = new Set();
    for (const sku of skus) {
      const assets = assetsBySkuId.get(sku.sku_id) || [];
      for (const a of assets) assetTypeSet.add(a.asset_type);
    }

    if (assetTypeSet.size === 0) {
      groupsNoneHave++;
      continue;
    }

    let groupHadDonation = false;

    // For each asset_type, find a donor and recipients
    for (const assetType of assetTypeSet) {
      // Find SKUs that have this asset_type
      const donors = [];
      const recipients = [];

      for (const sku of skus) {
        const assets = (assetsBySkuId.get(sku.sku_id) || [])
          .filter(a => a.asset_type === assetType);
        if (assets.length > 0) {
          donors.push({ sku, assets });
        } else {
          recipients.push(sku);
        }
      }

      if (donors.length === 0 || recipients.length === 0) continue;

      // Pick the donor with the most assets of this type (richest source)
      donors.sort((a, b) => b.assets.length - a.assets.length);
      const bestDonor = donors[0];

      groupHadDonation = true;

      for (const recipient of recipients) {
        // Check which sort_orders the recipient already uses (for any asset_type)
        const existingSortOrders = new Set(
          (assetsBySkuId.get(recipient.sku_id) || []).map(a => `${a.asset_type}:${a.sort_order}`)
        );

        for (const asset of bestDonor.assets) {
          const conflictKey = `${asset.asset_type}:${asset.sort_order}`;
          if (existingSortOrders.has(conflictKey)) continue; // already has this slot

          inserts.push({
            recipient_sku_id: recipient.sku_id,
            recipient_vendor_sku: recipient.vendor_sku,
            product_id: recipient.product_id,
            product_name: bestDonor.sku.product_name,
            donor_vendor_sku: bestDonor.sku.vendor_sku,
            asset_type: asset.asset_type,
            sort_order: asset.sort_order,
            url: asset.url,
            original_url: asset.original_url,
          });
        }
      }
    }

    if (groupHadDonation) groupsWithDonor++;
    else groupsAllHave++;
  }

  // Summary
  console.log(`\n  Groups with cross-pollination: ${groupsWithDonor}`);
  console.log(`  Groups where all SKUs already covered: ${groupsAllHave}`);
  console.log(`  Groups with no images at all: ${groupsNoneHave}`);

  // Break down inserts by asset_type
  const byType = {};
  for (const ins of inserts) {
    byType[ins.asset_type] = (byType[ins.asset_type] || 0) + 1;
  }
  console.log(`\n  Total images to copy: ${inserts.length}`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count}`);
  }

  if (VERBOSE) {
    console.log('\n  Detail:');
    for (const ins of inserts) {
      console.log(`    ${ins.product_name} / ${ins.asset_type} : ${ins.donor_vendor_sku} → ${ins.recipient_vendor_sku}`);
    }
  }

  // Step 5: Insert cross-pollinated images
  if (inserts.length === 0) {
    console.log('\n  Phase 1: Nothing to cross-pollinate.');
  } else if (DRY_RUN) {
    console.log('\n  Phase 1: DRY RUN — no changes written.');
  } else {

  console.log('\n  Inserting...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;

    for (const ins of inserts) {
      const result = await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, sort_order, url, original_url, source)
        VALUES ($1, $2, $3, $4, $5, $6, 'cross-pollinate')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING
      `, [
        ins.product_id,
        ins.recipient_sku_id,
        ins.asset_type,
        ins.sort_order,
        ins.url,
        ins.original_url,
      ]);

      if (result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n  Done: ${inserted} inserted, ${skipped} skipped (already existed)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('  ERROR — rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }
  } // end Phase 1 else

  // ===== Phase 2: Promote best available asset to primary =====
  // For SKUs that STILL lack a primary but have alternate/swatch/lifestyle,
  // duplicate the best candidate as a primary asset (sort_order 0).
  // Preference: alternate > swatch > lifestyle
  console.log('\n' + '='.repeat(64));
  console.log('  Phase 2: Promoting best asset to primary for remaining SKUs');
  console.log('='.repeat(64));

  const { rows: candidates } = await pool.query(`
    WITH missing_primary AS (
      SELECT s.id AS sku_id, s.product_id, s.vendor_sku, p.name AS product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name = 'Mannington'
        AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
        AND s.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
        )
    )
    SELECT DISTINCT ON (mp.sku_id)
           mp.sku_id, mp.product_id, mp.vendor_sku, mp.product_name,
           ma.asset_type AS source_type, ma.url, ma.original_url
    FROM missing_primary mp
    JOIN media_assets ma ON ma.sku_id = mp.sku_id
    WHERE ma.asset_type IN ('alternate', 'swatch', 'lifestyle')
    ORDER BY mp.sku_id,
             CASE ma.asset_type WHEN 'alternate' THEN 1 WHEN 'swatch' THEN 2 WHEN 'lifestyle' THEN 3 END,
             ma.sort_order
  `);

  // Breakdown
  const promotionsByType = {};
  for (const c of candidates) {
    promotionsByType[c.source_type] = (promotionsByType[c.source_type] || 0) + 1;
  }
  console.log(`\n  SKUs eligible for promotion: ${candidates.length}`);
  for (const [type, count] of Object.entries(promotionsByType).sort((a, b) => b[1] - a[1])) {
    console.log(`    from ${type}: ${count}`);
  }

  if (VERBOSE) {
    for (const c of candidates) {
      console.log(`    ${c.product_name} / ${c.vendor_sku}: ${c.source_type} → primary`);
    }
  }

  if (candidates.length > 0 && !DRY_RUN) {
    console.log('\n  Inserting promoted primaries...');
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      let promoted = 0;
      let promSkipped = 0;

      for (const c of candidates) {
        const result = await client2.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, sort_order, url, original_url, source)
          VALUES ($1, $2, 'primary', 0, $3, $4, 'promote')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING
        `, [c.product_id, c.sku_id, c.url, c.original_url]);

        if (result.rowCount > 0) promoted++;
        else promSkipped++;
      }

      await client2.query('COMMIT');
      console.log(`  Done: ${promoted} promoted, ${promSkipped} skipped`);
    } catch (err) {
      await client2.query('ROLLBACK');
      console.error('  ERROR — rolled back:', err.message);
      throw err;
    } finally {
      client2.release();
    }
  } else if (DRY_RUN && candidates.length > 0) {
    console.log('\n  DRY RUN — no promotions written.');
  }

  // Final coverage report
  const { rows: [after] } = await pool.query(`
    SELECT COUNT(DISTINCT s.id) as total_skus,
           COUNT(DISTINCT CASE WHEN ma.asset_type = 'primary' THEN s.id END) as with_primary
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE v.name = 'Mannington'
      AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
  `);
  const pct = (100 * after.with_primary / after.total_skus).toFixed(1);
  console.log(`\n  Flooring SKU primary image coverage: ${after.with_primary}/${after.total_skus} (${pct}%)`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
