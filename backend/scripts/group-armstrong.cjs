#!/usr/bin/env node
/**
 * group-armstrong.cjs
 *
 * Groups ~214 Armstrong products (under Tri-West vendor) into discoverable
 * "Armstrong - ..." collections. Currently each product has a unique collection
 * name by size/spec (e.g., "Alterna 12x24", "Biome 6x48 W/d10"), making them
 * impossible to browse on the collections page. This script:
 *
 *   1. Prefixes all Armstrong collections with "Armstrong - "
 *   2. Cleans technical codes (W/d10, x.100, Db, Srf, NxN dimensions)
 *   3. Fixes mangled product names from EDI import (e.g., "- Quarts")
 *   4. Merges products that resolve to the same (collection, name) after cleaning
 *
 * Run:
 *   docker exec flooring-api node scripts/group-armstrong.cjs --dry-run
 *   docker exec flooring-api node scripts/group-armstrong.cjs
 *
 * Safe to run multiple times (idempotent).
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

// ─────────────────────────────────────────────────────────────────────────────
// Cleaning helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean a raw collection or product name into a base product-line name.
 * Strips "Armstrong - " prefix, "Armstrong Flooring, Inc." generic collection,
 * technical codes, dimension strings, and packaging suffixes.
 *
 * Examples:
 *   "Armstrong Flooring, Inc."          → "" (generic — triggers name-based derivation)
 *   "Armstrong - Biome 6x48 W/d10"     → "Biome"
 *   "Exchange 6x36x.100"               → "Exchange"
 *   "Safety Zone Db 1/8 12x12"         → "Safety Zone 1/8"
 *   "Once N Done - Quarts"              → "Once N Done"
 *   "Alterna 12x24"                     → "Alterna"
 *   "Parallel Usa 20mil 6x48 W/d10"    → "Parallel Usa 20mil"
 *   "Imperial Texture 1/8"              → "Imperial Texture 1/8"
 *   "Natural Creations W/d10-low Gloss" → "Natural Creations - Low Gloss"
 *   "Clear Thin Spread - 4 Gallon"      → "Clear Thin Spread"
 *   "Duo 18 X18 - Mixer 2"             → "Duo"
 *   "Multicolor Dry Back 12x12"         → "Multicolor - Dry Back"
 */
function cleanBaseName(raw) {
  if (!raw) return '';
  let s = raw;

  // Strip generic vendor collection names (these are useless for grouping)
  s = s.replace(/^Armstrong\s+Flooring,?\s*Inc\.?$/i, '');
  s = s.replace(/^Armstrong\s+Flooring,?\s*Inc\.?\s*[-–]\s*/i, '');

  // Strip "Armstrong - " prefix if present
  s = s.replace(/^Armstrong\s*-\s*/i, '');

  // Strip W/dNN wear-layer codes (e.g., W/d10, W/d8)
  s = s.replace(/\s*W\/d\d+/gi, '');

  // Strip NNmil wear-layer codes (e.g., 20mil, 10mil) — standalone word only
  s = s.replace(/\s+\d+mil\b/gi, '');

  // Strip Db (direct bond) — only as standalone word
  s = s.replace(/\s+Db\b/gi, '');

  // Strip Srf (surface) — only as standalone word
  s = s.replace(/\s+Srf\b/gi, '');

  // Strip NxN / N.NxN / NxNx.NNN dimension strings (e.g., 6x48, 12x24, 6.5x48, 6x36x.100)
  // Does NOT strip fractions like 1/8 (no "x" separator)
  s = s.replace(/\s*\b\d+\.?\d*\s*x\s*\d+(?:x\.?\d+)?\b/gi, '');

  // Strip stray x.NNN thickness codes not caught by dimension regex
  s = s.replace(/x\.\d+/gi, '');

  // Strip packaging/form suffixes with optional quantity:
  //   "- Quarts", "-half Gallon", "4 Gallon", "1/2 Gallon", "2-gallon",
  //   "- Half Gallons", "-quarts", "1.65 Gallon"
  s = s.replace(/\s*-?\s*(?:\d+[\d.\/]*[-\s]*)?\s*(?:Quarts?|Half\s*Gallons?|Gallons?)\s*$/i, '');

  // Strip "- Mixer N" suffixes from EDI names (e.g., "Duo 18 X18 - Mixer 2")
  s = s.replace(/\s*-\s*Mixer\s*\d*$/i, '');

  // Normalize known sub-type suffixes that vary in dash-spacing/case.
  // "-low Gloss" / "- Low Gloss" / "-low gloss" all → " - Low Gloss"
  // This avoids splitting compound words like "Multi-purpose" or "T-molding"
  s = s.replace(/\s*-\s*low\s+gloss\b/gi, ' - Low Gloss');
  s = s.replace(/\s*-\s*dry\s+back\b/gi, ' - Dry Back');

  // Strip trailing dashes, periods, and whitespace
  s = s.replace(/[\s.\-]+$/, '');

  // Collapse whitespace and trim
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Check if a collection is the generic "Armstrong Flooring, Inc." placeholder
 * that provides no grouping information.
 */
function isGenericCollection(collection) {
  if (!collection) return true;
  return /^Armstrong\s+Flooring,?\s*Inc\.?$/i.test(collection.trim());
}

/**
 * Check if a product name is mangled from bad EDI parsing.
 * Mangled names are fragments like "- Quarts", "-half Gallon", "Exchangex.100".
 */
function isNameMangled(name) {
  if (!name) return true;
  const trimmed = name.trim();
  if (/^-/.test(trimmed)) return true;         // starts with dash
  if (/x\.\d+/.test(trimmed)) return true;     // dimension leak like "x.100"
  if (trimmed.length <= 2) return true;         // very short fragment
  return false;
}

/**
 * Compute the cleaned product name.
 * Derives from collection field if the current name is mangled.
 */
function computeCleanedName(currentName, collection) {
  if (isNameMangled(currentName)) {
    const fromColl = cleanBaseName(collection);
    return fromColl || currentName.trim();
  }
  const cleaned = cleanBaseName(currentName);
  return cleaned || currentName.trim();
}

/**
 * Compute the cleaned collection name.
 * When the raw collection is generic ("Armstrong Flooring, Inc."),
 * derive the collection from the product name instead.
 */
function computeCleanedCollection(name, collection) {
  // Try cleaning the collection first
  const fromColl = cleanBaseName(collection);
  if (fromColl) return `Armstrong - ${fromColl}`;

  // Collection is generic — derive from product name
  const fromName = cleanBaseName(name);
  if (fromName) return `Armstrong - ${fromName}`;

  // Last resort: keep as-is
  return collection;
}

/**
 * Extract additional attributes from product names during grouping.
 * Returns an object of attribute slug → value pairs.
 */
function extractAttributes(name) {
  const attrs = {};
  if (!name) return attrs;

  // Wear layer: W/d10 → "10 mil", W/d8 → "8 mil"
  const wearMatch = name.match(/W\/d(\d+)/i);
  if (wearMatch) attrs.wear_layer = `${wearMatch[1]} mil`;

  // NNmil standalone: 20mil → "20 mil"
  const milMatch = name.match(/\b(\d+)mil\b/i);
  if (milMatch && !attrs.wear_layer) attrs.wear_layer = `${milMatch[1]} mil`;

  // Thickness: x.NNN → e.g., 0.100"
  const thickMatch = name.match(/x\.(\d+)/i);
  if (thickMatch) attrs.thickness = `0.${thickMatch[1]}"`;

  // Dimensions: NxN or N.NxN or NxNxN (e.g., 6x48, 12x24, 6.5x48, 18x18)
  const dimMatch = name.match(/\b(\d+\.?\d*)\s*x\s*(\d+)(?:x\.?\d+)?\b/i);
  if (dimMatch) attrs.dimensions = `${dimMatch[1]}"x${dimMatch[2]}"`;

  // Installation method: Db = direct bond, Srf = surface
  if (/\bDb\b/.test(name)) attrs.installation_method = 'Direct Bond';
  if (/\bSrf\b/.test(name)) attrs.installation_method = 'Surface';

  return attrs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Group Armstrong Products ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const client = await pool.connect();

  try {
    // ── Find brand attribute ID ──────────────────────────────────────────
    const brandAttrRes = await client.query(
      `SELECT id FROM attributes WHERE slug = 'brand' LIMIT 1`
    );
    if (!brandAttrRes.rows.length) {
      console.error('Brand attribute not found. Aborting.');
      return;
    }
    const brandAttrId = brandAttrRes.rows[0].id;

    // ── Load all Armstrong products ──────────────────────────────────────
    // Match by brand attribute, "Armstrong - " prefix, or generic "Armstrong Flooring, Inc."
    // Exclude AHF products (handled by cleanup-ahf.cjs).
    const allProducts = await client.query(`
      SELECT DISTINCT p.id, p.name, p.collection, p.vendor_id
      FROM products p
      WHERE (
        EXISTS (
          SELECT 1 FROM skus s
          JOIN sku_attributes sa ON sa.sku_id = s.id
          WHERE s.product_id = p.id
            AND sa.attribute_id = $1
            AND sa.value ILIKE '%Armstrong%'
        )
        OR p.collection LIKE 'Armstrong -%'
        OR p.collection LIKE 'Armstrong-%'
        OR p.collection ILIKE 'Armstrong Flooring%'
      )
      AND p.collection NOT LIKE 'AHF%'
      AND p.status != 'archived'
      ORDER BY p.name, p.collection
    `, [brandAttrId]);

    if (allProducts.rows.length === 0) {
      console.log('No Armstrong products found. Nothing to do.');
      return;
    }

    const vendorId = allProducts.rows[0].vendor_id;
    console.log(`Found ${allProducts.rows.length} Armstrong products`);
    console.log(`Vendor ID: ${vendorId}\n`);

    // ── Compute cleaned collection + name for each product ───────────────
    const updates = [];
    const attrsByProduct = new Map(); // product_id → { wear_layer, thickness, ... }
    for (const row of allProducts.rows) {
      const cleanedCollection = computeCleanedCollection(row.name, row.collection);
      const cleanedName = computeCleanedName(row.name, row.collection);

      // Extract attributes from raw name before cleaning
      const attrs = extractAttributes(row.name);
      if (Object.keys(attrs).length > 0) {
        attrsByProduct.set(row.id, attrs);
      }

      updates.push({
        id: row.id,
        vendorId: row.vendor_id,
        oldName: row.name,
        oldCollection: row.collection,
        newName: cleanedName,
        newCollection: cleanedCollection,
      });
    }

    // ── Group by target (collection, name) ───────────────────────────────
    const groups = new Map();
    for (const u of updates) {
      const key = `${u.newCollection}\0${u.newName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          collection: u.newCollection,
          name: u.newName,
          members: [],
        });
      }
      groups.get(key).members.push(u);
    }

    console.log(`Unique product groups after cleaning: ${groups.size}`);
    console.log(`(down from ${allProducts.rows.length} products)\n`);

    // Report merges
    const mergeGroups = [...groups.values()].filter(g => g.members.length > 1);
    if (mergeGroups.length > 0) {
      console.log(`Groups requiring merge (${mergeGroups.length}):`);
      for (const g of mergeGroups) {
        console.log(`\n  ${g.collection} / "${g.name}" <- ${g.members.length} products:`);
        for (const m of g.members) {
          console.log(`    old: "${m.oldCollection}" / "${m.oldName}"`);
        }
      }
    } else {
      console.log('No merges needed.');
    }

    // Report name fixes
    const nameFixes = updates.filter(u => u.newName !== u.oldName);
    if (nameFixes.length > 0) {
      console.log(`\nName fixes (${nameFixes.length}):`);
      for (const f of nameFixes) {
        console.log(`  "${f.oldName}" -> "${f.newName}"  (from "${f.oldCollection}")`);
      }
    }

    // Report collection renames
    const collRenames = updates.filter(u => u.newCollection !== u.oldCollection);
    console.log(`\nCollection renames: ${collRenames.length} of ${updates.length}`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No database changes made. Remove --dry-run to execute.\n');
      await pool.end();
      return;
    }

    // ── Pre-load SKU → original product mapping for attribute extraction ──
    const allProductIds = allProducts.rows.map(r => r.id);
    const { rows: allSkuRows } = allProductIds.length > 0 ? await client.query(`
      SELECT s.id AS sku_id, s.product_id FROM skus s
      WHERE s.product_id = ANY($1::uuid[])
    `, [allProductIds]) : { rows: [] };
    const skuOriginalProduct = new Map(); // sku_id → original product_id
    for (const row of allSkuRows) {
      skuOriginalProduct.set(row.sku_id, row.product_id);
    }

    // ── Execute in transaction ───────────────────────────────────────────
    console.log('\n-- Executing changes --\n');
    await client.query('BEGIN');

    let productsKept = 0;
    let productsDeleted = 0;
    let productsArchived = 0;
    let skusMoved = 0;
    let mediaMigrated = 0;

    for (const group of groups.values()) {
      const { collection, name, members } = group;

      // Sort by UUID for consistent keeper selection
      members.sort((a, b) => a.id.localeCompare(b.id));
      const keeper = members[0];
      const others = members.slice(1);

      // Move SKUs from other products to keeper
      if (others.length > 0) {
        const otherIds = others.map(m => m.id);

        const moveRes = await client.query(
          `UPDATE skus SET product_id = $1 WHERE product_id = ANY($2::uuid[])`,
          [keeper.id, otherIds]
        );
        skusMoved += moveRes.rowCount;
        console.log(`  ${collection}: moved ${moveRes.rowCount} SKUs from ${otherIds.length} products`);

        // Migrate media_assets from merged products to keeper
        for (const otherId of otherIds) {
          // SKU-level assets — safe to move directly
          const skuMedia = await client.query(
            `UPDATE media_assets SET product_id = $1
             WHERE product_id = $2 AND sku_id IS NOT NULL`,
            [keeper.id, otherId]
          );

          // Product-level assets — delete duplicates first, then move rest
          await client.query(`
            DELETE FROM media_assets WHERE product_id = $2 AND sku_id IS NULL
              AND EXISTS (
                SELECT 1 FROM media_assets ma2
                WHERE ma2.product_id = $1 AND ma2.sku_id IS NULL
                  AND ma2.asset_type = media_assets.asset_type
                  AND ma2.sort_order = media_assets.sort_order
              )
          `, [keeper.id, otherId]);

          const prodMedia = await client.query(
            `UPDATE media_assets SET product_id = $1
             WHERE product_id = $2 AND sku_id IS NULL`,
            [keeper.id, otherId]
          );
          mediaMigrated += skuMedia.rowCount + prodMedia.rowCount;
        }

        // Delete or archive orphaned products
        for (const otherId of otherIds) {
          // Check for order/quote references before deleting
          const orderRefs = await client.query(
            `SELECT COUNT(*) FROM order_items WHERE product_id = $1`,
            [otherId]
          );
          const quoteRefs = await client.query(
            `SELECT COUNT(*) FROM quote_items WHERE product_id = $1`,
            [otherId]
          );
          const hasRefs =
            parseInt(orderRefs.rows[0].count) > 0 ||
            parseInt(quoteRefs.rows[0].count) > 0;

          if (hasRefs) {
            await client.query(
              `UPDATE products SET status = 'archived', is_active = false,
               updated_at = NOW() WHERE id = $1`,
              [otherId]
            );
            productsArchived++;
          } else {
            // Remove FK children then delete product
            await client.query(
              `DELETE FROM media_assets WHERE product_id = $1`, [otherId]
            );
            await client.query(
              `DELETE FROM wishlists WHERE product_id = $1`, [otherId]
            );
            await client.query(
              `DELETE FROM product_reviews WHERE product_id = $1`, [otherId]
            );
            await client.query(
              `DELETE FROM installation_inquiries WHERE product_id = $1`,
              [otherId]
            );
            await client.query(
              `DELETE FROM products WHERE id = $1`, [otherId]
            );
            productsDeleted++;
          }
        }
      }

      // Update keeper's collection and name to cleaned values
      await client.query(`
        UPDATE products SET
          collection = $1,
          name = $2,
          updated_at = NOW()
        WHERE id = $3
      `, [collection, name, keeper.id]);
      productsKept++;
    }

    await client.query('COMMIT');

    // ── Phase 2: Extract attributes from original product names ──────────
    // Use the pre-merge attrsByProduct map (built from ORIGINAL product names
    // before they were cleaned) combined with the SKU→original-product mapping
    console.log('\n-- Extracting attributes from original product names --\n');
    let attrsAdded = 0;

    // Look up attribute IDs (create if needed)
    const attrSlugs = ['wear_layer', 'thickness', 'dimensions', 'installation_method'];
    const attrIds = {};
    for (const slug of attrSlugs) {
      const { rows } = await client.query(
        `SELECT id FROM attributes WHERE slug = $1 LIMIT 1`, [slug]
      );
      if (rows.length) {
        attrIds[slug] = rows[0].id;
      } else {
        const label = slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const { rows: [created] } = await client.query(
          `INSERT INTO attributes (name, slug, is_filterable)
           VALUES ($1, $2, true)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [label, slug]
        );
        attrIds[slug] = created.id;
        console.log(`  Created attribute: ${slug} (${created.id})`);
      }
    }

    // For each SKU, look up its ORIGINAL product_id → extracted attrs
    for (const [skuId, originalProductId] of skuOriginalProduct) {
      const attrs = attrsByProduct.get(originalProductId);
      if (!attrs) continue;

      for (const [slug, value] of Object.entries(attrs)) {
        if (!attrIds[slug]) continue;
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [skuId, attrIds[slug], value]);
        attrsAdded++;
      }
    }

    console.log(`  Attributes added/updated: ${attrsAdded}`);

    // ── Summary ──────────────────────────────────────────────────────────
    console.log('\n========== SUMMARY ==========');
    console.log(`Products kept:     ${productsKept}`);
    console.log(`Products merged:   ${productsDeleted + productsArchived}`);
    console.log(`  - deleted:       ${productsDeleted}`);
    console.log(`  - archived:      ${productsArchived}`);
    console.log(`SKUs moved:        ${skusMoved}`);
    console.log(`Media migrated:    ${mediaMigrated}`);
    console.log(`Attrs extracted:   ${attrsAdded}`);

    // ── Verification ─────────────────────────────────────────────────────
    const verify = await client.query(`
      SELECT p.collection, p.name, COUNT(s.id) AS skus
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.collection LIKE 'Armstrong%'
      GROUP BY p.id, p.collection, p.name
      ORDER BY p.collection
    `);

    console.log(`\n-- Verification: ${verify.rows.length} Armstrong products --\n`);
    let maxCol = 0, maxName = 0;
    for (const r of verify.rows) {
      if (r.collection.length > maxCol) maxCol = r.collection.length;
      if (r.name.length > maxName) maxName = r.name.length;
    }
    const colW = Math.min(maxCol, 50);
    const nameW = Math.min(maxName, 35);
    console.log(
      `${'Collection'.padEnd(colW)}  ${'Name'.padEnd(nameW)}  SKUs`
    );
    console.log('-'.repeat(colW + nameW + 8));
    for (const row of verify.rows) {
      console.log(
        `${row.collection.padEnd(colW)}  ${row.name.padEnd(nameW)}  ${row.skus}`
      );
    }

    const totalSkus = verify.rows.reduce(
      (sum, r) => sum + parseInt(r.skus), 0
    );
    console.log(`\nTotal Armstrong SKUs: ${totalSkus}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR — transaction rolled back:', err.message);
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
