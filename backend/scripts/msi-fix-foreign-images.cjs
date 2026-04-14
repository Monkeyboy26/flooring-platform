#!/usr/bin/env node
/**
 * msi-fix-foreign-images.cjs
 *
 * Fixes 237 products that have local upload images from wrong source products.
 * The overhaul's media reparenting moved ALL source images to target products
 * without color matching. This script traces each foreign image back to its
 * source product and either:
 *   A) Leaves it if the source matches the current product (same color)
 *   B) Moves it to the correct active product (different color in same collection)
 *   C) Deletes it if no correct target exists (wrong product entirely)
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
const VERBOSE = process.argv.includes('--verbose');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

function normalize(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Generic/short words that shouldn't drive matching alone
const GENERIC_WORDS = new Set([
  'black', 'white', 'gray', 'grey', 'beige', 'brown', 'gold', 'blue', 'green',
  'red', 'cream', 'ivory', 'ash', 'oak', 'natural', 'blend', 'classic',
  'light', 'dark', 'warm', 'cool', 'matte', 'polished', 'honed', 'mosaic',
  'tile', 'stone', 'marble', 'pattern', 'subway', 'hexagon', 'trim',
  'dove', 'silver', 'pearl', 'fog', 'taupe', 'sand', 'rust', 'blanca',
]);

// Non-flooring product categories that should never match flooring
const NON_FLOORING_WORDS = new Set([
  'grout', 'adhesive', 'sealant', 'sealer', 'caulk', 'mortar', 'faucet',
  'sink', 'vanity', 'mirror', 'soap', 'towel', 'drain', 'underlayment',
]);

function isNonFlooring(name) {
  const n = normalize(name);
  return [...NON_FLOORING_WORDS].some(w => n.includes(w));
}

// Check if source name is distinctive enough (not just generic color words)
function isDistinctive(name) {
  const words = normalize(name).split(' ').filter(w => w.length > 2);
  return words.some(w => !GENERIC_WORDS.has(w));
}

// Check if two collections are the same or closely related
function collectionsMatch(coll1, coll2) {
  if (!coll1 || !coll2) return false;
  const c1 = normalize(coll1);
  const c2 = normalize(coll2);
  if (c1 === c2) return true;
  // One contains the other (e.g., "Ansello" vs "Ansello Grey")
  if (c1.includes(c2) || c2.includes(c1)) return true;
  return false;
}

// Score how well a source product matches an active product (higher = better)
// Conservative: requires collection match for most cases
function matchScore(sourceName, sourceColl, activeName, activeColl) {
  const sn = normalize(sourceName);
  const sc = normalize(sourceColl);
  const an = normalize(activeName);
  const ac = normalize(activeColl);

  // Don't match flooring to non-flooring (grout, adhesive, etc.)
  if (isNonFlooring(activeName) !== isNonFlooring(sourceName)) return 0;

  // Exact name match → best (regardless of collection)
  if (sn === an) return 100;

  // If source name is not distinctive (e.g., just "Beige", "Gold", "Black"),
  // REQUIRE collection match for any score above 0
  if (!isDistinctive(sourceName)) {
    if (!collectionsMatch(sourceColl, activeColl)) return 0;
    // With collection match + generic name contained
    if (an.includes(sn)) return 75;
    return 30;
  }

  // Source name fully contained in active name (with length guard)
  // Require at least 8 chars to avoid false positives on short names
  if (an.includes(sn) && sn.length >= 8) return 90;
  if (sn.includes(an) && an.length >= 8) return 85;

  // For shorter but distinctive names, require collection match
  if (an.includes(sn) && sn.length >= 4 && collectionsMatch(sourceColl, activeColl)) return 85;
  if (sn.includes(an) && an.length >= 4 && collectionsMatch(sourceColl, activeColl)) return 80;

  // Same collection + first distinctive word matches
  if (collectionsMatch(sourceColl, activeColl)) {
    const sWords = sn.split(' ').filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
    const aWords = an.split(' ').filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
    const overlap = sWords.filter(w => aWords.includes(w)).length;
    if (overlap > 0 && sWords.length > 0) {
      return 60 + (overlap / Math.max(sWords.length, aWords.length)) * 20;
    }
    return 30; // Same collection, no word overlap
  }

  // Cross-collection: only if source name is long and distinctive
  if (sn.length >= 12 && an.includes(sn)) return 70;
  if (sn.length >= 12 && sn.includes(an) && an.length >= 8) return 65;

  return 0;
}

async function main() {
  console.log(`\n=== MSI Foreign Image Fix (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  const client = await pool.connect();
  try {
    // Step 1: Load all foreign images
    const { rows: foreignImages } = await client.query(`
      SELECT ma.id as media_id, ma.product_id as current_pid, ma.url, ma.asset_type,
        p.name as current_name, p.collection as current_coll,
        SUBSTRING(ma.url FROM '/uploads/products/([^/]+)/') as source_uuid
      FROM media_assets ma
      JOIN products p ON ma.product_id = p.id
      WHERE p.vendor_id = $1
        AND p.is_active = true
        AND ma.url LIKE '/uploads/products/%'
        AND ma.url NOT LIKE '/uploads/products/' || p.id::text || '%'
      ORDER BY p.name
    `, [VENDOR_ID]);

    console.log(`  Foreign images found: ${foreignImages.length}`);
    console.log(`  Affected products: ${new Set(foreignImages.map(r => r.current_pid)).size}\n`);

    // Step 2: Load all source products (deactivated originals)
    const sourceUUIDs = [...new Set(foreignImages.map(r => r.source_uuid).filter(Boolean))];
    const { rows: sourceProducts } = await client.query(`
      SELECT id, name, collection, is_active
      FROM products
      WHERE id = ANY($1::uuid[])
    `, [sourceUUIDs]);

    const sourceMap = new Map();
    for (const sp of sourceProducts) {
      sourceMap.set(sp.id, sp);
    }
    console.log(`  Source products found: ${sourceMap.size} / ${sourceUUIDs.length} UUIDs\n`);

    // Step 3: Load all active MSI products as potential targets
    const { rows: activeProducts } = await client.query(`
      SELECT id, name, collection
      FROM products
      WHERE vendor_id = $1 AND is_active = true
      ORDER BY name
    `, [VENDOR_ID]);

    console.log(`  Active products (potential targets): ${activeProducts.length}\n`);

    // Step 4: For each foreign image, determine the best action
    // Group by source_uuid + current_pid for efficiency
    const groups = new Map(); // key: source_uuid|||current_pid
    for (const img of foreignImages) {
      const key = `${img.source_uuid}|||${img.current_pid}`;
      if (!groups.has(key)) {
        groups.set(key, {
          source_uuid: img.source_uuid,
          current_pid: img.current_pid,
          current_name: img.current_name,
          current_coll: img.current_coll,
          images: []
        });
      }
      groups.get(key).images.push(img);
    }

    let kept = 0, moved = 0, deleted = 0;
    const actions = []; // { type: 'move'|'delete', media_ids: [], target_pid?, reason }

    for (const [key, group] of groups) {
      const source = sourceMap.get(group.source_uuid);
      if (!source) {
        // Source product not found — can't determine correct target, delete
        actions.push({
          type: 'delete',
          media_ids: group.images.map(i => i.media_id),
          reason: `Source UUID ${group.source_uuid} not found in products table`,
          current_name: group.current_name,
          source_name: '(unknown)',
        });
        deleted += group.images.length;
        continue;
      }

      // Check if source matches current product (same color = correct placement)
      const scoreVsCurrent = matchScore(source.name, source.collection, group.current_name, group.current_coll);

      if (scoreVsCurrent >= 70) {
        // Images are actually on the right product — source and current match well
        kept += group.images.length;
        if (VERBOSE) {
          console.log(`  KEEP: "${source.name}" images on "${group.current_name}" (score: ${scoreVsCurrent})`);
        }
        continue;
      }

      // Find the best matching active product for this source
      let bestTarget = null;
      let bestScore = 0;

      for (const ap of activeProducts) {
        if (ap.id === group.current_pid) continue; // Skip current
        const score = matchScore(source.name, source.collection, ap.name, ap.collection);
        if (score > bestScore) {
          bestScore = score;
          bestTarget = ap;
        }
      }

      // For short source names without collections, require stronger matches
      const sNorm = normalize(source.name);
      const needsHighConfidence = (!source.collection && sNorm.length < 10) || !isDistinctive(source.name);
      const moveThreshold = needsHighConfidence ? 90 : 60;

      if (bestTarget && bestScore >= moveThreshold) {
        // Found a better target — move images there
        actions.push({
          type: 'move',
          media_ids: group.images.map(i => i.media_id),
          target_pid: bestTarget.id,
          reason: `"${source.name}" → "${bestTarget.name}" (score: ${bestScore})`,
          current_name: group.current_name,
          source_name: source.name,
        });
        moved += group.images.length;
      } else if (!needsHighConfidence && bestScore > scoreVsCurrent && bestScore >= 40) {
        // Marginal match but better than current — still move (only for high-confidence sources)
        actions.push({
          type: 'move',
          media_ids: group.images.map(i => i.media_id),
          target_pid: bestTarget.id,
          reason: `"${source.name}" → "${bestTarget.name}" (marginal score: ${bestScore} vs current: ${scoreVsCurrent})`,
          current_name: group.current_name,
          source_name: source.name,
        });
        moved += group.images.length;
      } else {
        // No good match anywhere — delete (better no image than wrong image)
        actions.push({
          type: 'delete',
          media_ids: group.images.map(i => i.media_id),
          reason: `No match for "${source.name}" (best: ${bestTarget?.name || 'none'} score: ${bestScore}, current score: ${scoreVsCurrent})`,
          current_name: group.current_name,
          source_name: source.name,
        });
        deleted += group.images.length;
      }
    }

    // Print summary before executing
    console.log(`\n  === Action Summary ===`);
    console.log(`  Keep (correct placement): ${kept} images`);
    console.log(`  Move (to correct product): ${moved} images`);
    console.log(`  Delete (no match):         ${deleted} images`);
    console.log(`  Total:                     ${kept + moved + deleted} images\n`);

    if (VERBOSE || DRY_RUN) {
      console.log(`  --- Moves ---`);
      for (const a of actions.filter(a => a.type === 'move')) {
        console.log(`    [${a.media_ids.length} imgs] "${a.current_name}" → ${a.reason}`);
      }
      console.log(`\n  --- Deletes ---`);
      for (const a of actions.filter(a => a.type === 'delete')) {
        console.log(`    [${a.media_ids.length} imgs] from "${a.current_name}": ${a.reason}`);
      }
    }

    if (DRY_RUN) {
      console.log(`\n  DRY RUN — no changes made.\n`);
      return;
    }

    // Execute actions
    await client.query('BEGIN');

    for (const action of actions) {
      if (action.type === 'move') {
        // Move images one at a time, adjusting sort_order to avoid conflicts
        for (const mediaId of action.media_ids) {
          // Get current asset_type for this image
          const { rows: [img] } = await client.query(
            `SELECT asset_type FROM media_assets WHERE id = $1`, [mediaId]
          );
          if (!img) continue;
          // Find next available sort_order on target product for this asset_type
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), 0) as max_sort
             FROM media_assets
             WHERE product_id = $1 AND asset_type = $2`,
            [action.target_pid, img.asset_type]
          );
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [action.target_pid, max_sort + 1, mediaId]
          );
        }
      } else if (action.type === 'delete') {
        await client.query(
          `DELETE FROM media_assets WHERE id = ANY($1::uuid[])`,
          [action.media_ids]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`\n  Changes committed successfully.\n`);

    // Verify
    const { rows: [{ remaining }] } = await client.query(`
      SELECT COUNT(*) as remaining
      FROM media_assets ma
      JOIN products p ON ma.product_id = p.id
      WHERE p.vendor_id = $1
        AND p.is_active = true
        AND ma.url LIKE '/uploads/products/%'
        AND ma.url NOT LIKE '/uploads/products/' || p.id::text || '%'
    `, [VENDOR_ID]);
    console.log(`  Remaining foreign images: ${remaining}\n`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
