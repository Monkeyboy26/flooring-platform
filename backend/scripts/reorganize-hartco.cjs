#!/usr/bin/env node
/**
 * Hartco Data Architecture Overhaul
 *
 * Fixes the broken Hartco/AHF product grouping caused by 3 independent import
 * sources (832 EDI, XLS price lists, enricher) with no coordination.
 *
 * What it does:
 *   1. Classifies every AHF/Hartco SKU by prefix → canonical collection
 *   2. Creates clean product records (one per collection+species+width combo)
 *   3. Reassigns SKUs to the correct products
 *   4. Moves media_assets to follow their SKUs
 *   5. Deletes orphaned (empty) products
 *   6. Backfills CDN images for floor SKUs missing them
 *
 * Usage:
 *   node backend/scripts/reorganize-hartco.cjs --dry-run   # Preview changes
 *   node backend/scripts/reorganize-hartco.cjs              # Execute
 */

const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const CDN_BASE = 'https://www.hartco.com/cdn/swatch/';

// ---------------------------------------------------------------------------
// SKU Prefix → Collection Mapping
// Order matters: longer/more-specific prefixes checked first
// ---------------------------------------------------------------------------
const PREFIX_RULES = [
  // === Engineered Hardwood ===
  // TimberBrushed Gold (White Oak, 7.5")
  { prefixes: ['EAKTB', 'EAHTB'], collection: 'TimberBrushed Gold', category: 'hardwood', construction: 'Engineered Hardwood' },
  // TimberBrushed Silver (White Oak, 6.5")
  { prefixes: ['EKLP'], collection: 'TimberBrushed Silver', category: 'hardwood', construction: 'Engineered Hardwood' },
  // TimberBrushed (White Oak, 7.5" — standard engineered)
  { prefixes: ['EKTB'], collection: 'TimberBrushed', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Coastal Highway
  { prefixes: ['ESB7', 'EKBH'], collection: 'Coastal Highway', category: 'hardwood', construction: 'Engineered Hardwood' },
  // HydroBlok
  { prefixes: ['EHHB', 'EKHB'], collection: 'HydroBlok', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Dutton Pass
  { prefixes: ['EKDP', 'EDP'], collection: 'Dutton Pass', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Beaumont
  { prefixes: ['EBM'], collection: 'Beaumont', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Dogwood Pro
  { prefixes: ['EKDT', 'EDW'], collection: 'Dogwood Pro', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Necessity
  { prefixes: ['ENC', 'EKNC', 'EHPC'], collection: 'Necessity', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Prime Harvest Engineered
  { prefixes: ['EPH', 'EKPH', 'EAK'], collection: 'Prime Harvest', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Appalachian Ridge Engineered
  { prefixes: ['EKAR'], collection: 'Appalachian Ridge', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Nature Walk Engineered
  { prefixes: ['EKNW'], collection: 'Nature Walk', category: 'hardwood', construction: 'Engineered Hardwood' },
  // Sensory Forest Engineered
  { prefixes: ['EKSF'], collection: 'Sensory Forest', category: 'hardwood', construction: 'Engineered Hardwood' },

  // === Solid Hardwood ===
  // American Scrape
  { prefixes: ['SAS5', 'SAS3'], collection: 'American Scrape', category: 'hardwood', construction: 'Solid Hardwood' },
  // Appalachian Ridge Solid — numeric prefixes removed (00730* collides with adhesive/wallbase SKUs)
  // Ascot
  { prefixes: ['ASO', '5188'], collection: 'Ascot', category: 'hardwood', construction: 'Solid Hardwood' },
  // TimberBrushed Solid (Red Oak)
  { prefixes: ['SKTB'], collection: 'TimberBrushed', category: 'hardwood', construction: 'Solid Hardwood' },
  // Prime Harvest Solid
  { prefixes: ['APH', 'APK', 'APM', 'APF'], collection: 'Prime Harvest', category: 'hardwood', construction: 'Solid Hardwood' },
  // Nature Walk Solid
  { prefixes: ['SNW', '1NS2'], collection: 'Nature Walk', category: 'hardwood', construction: 'Solid Hardwood' },
  // Sensory Forest Solid
  { prefixes: ['SSF'], collection: 'Sensory Forest', category: 'hardwood', construction: 'Solid Hardwood' },
  // Yorkshire
  { prefixes: ['YS'], collection: 'Yorkshire', category: 'hardwood', construction: 'Solid Hardwood' },
  // Paragon
  { prefixes: ['PAR', 'PARA'], collection: 'Paragon', category: 'hardwood', construction: 'Solid Hardwood' },
  // Generic solid — Dundee, Waltham, etc (numeric prefix)
  { prefixes: ['4210', '4225', '4510', '4722', '4211', '422', '5888'], collection: 'Prime Harvest', category: 'hardwood', construction: 'Solid Hardwood' },

  // === Rigid Core / SPC ===
  // Everguard
  { prefixes: ['EKEP', 'RKEG'], collection: 'Everguard', category: 'luxury-vinyl', construction: 'Rigid Core' },
  // Pikes Peak SPC
  { prefixes: ['RK7E', 'RK7L', 'BRLP70'], collection: 'Pikes Peak SPC', category: 'luxury-vinyl', construction: 'SPC' },
  // Denali SPC
  { prefixes: ['RK7P', 'RP7'], collection: 'Denali SPC', category: 'luxury-vinyl', construction: 'SPC' },
  // Everest SPC
  { prefixes: ['RK9', 'BRLR91'], collection: 'Everest SPC', category: 'luxury-vinyl', construction: 'SPC' },

  // === TimberTru ===
  // Back Home
  { prefixes: ['LFR'], collection: 'Back Home', category: 'luxury-vinyl', construction: 'TimberTru' },
];

// Non-Hartco AHF brands — leave these untouched
const NON_HARTCO_KEYWORDS = [
  'nod to nature', 'concepts of landscape', 'iliad', 'medinpure',
  'robbins', 'bruce', 'armstrong',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(sku) {
  if (!sku) return '';
  let s = sku.toUpperCase().replace(/-/g, '');
  if (s.startsWith('AHF')) s = s.slice(3);
  return s;
}

function isAccessorySku(bareSku, variantType) {
  if (variantType === 'accessory') return true;
  // Common trim SKU patterns: start with T, or contain TMOLD, REDUCER, etc.
  const upper = bareSku.toUpperCase();
  if (/^T[A-Z0-9]{4,}/.test(upper) && !/^TB|^TI/.test(upper)) return true;
  return false;
}

function classifySku(bareSku) {
  const upper = bareSku.toUpperCase();
  for (const rule of PREFIX_RULES) {
    for (const prefix of rule.prefixes) {
      if (upper.startsWith(prefix)) {
        return {
          collection: rule.collection,
          category: rule.category,
          construction: rule.construction,
        };
      }
    }
  }
  return null;
}

function isNonHartco(productName, collection) {
  const combined = `${productName || ''} ${collection || ''}`.toLowerCase();
  return NON_HARTCO_KEYWORDS.some(kw => combined.includes(kw));
}

function checkCdn(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
    }, res => {
      res.resume();
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || '';
        if (loc.includes('placeholder')) return resolve(false);
        const fullUrl = loc.startsWith('http') ? loc : `https://www.hartco.com${loc}`;
        https.get(fullUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
        }, res2 => {
          res2.resume();
          resolve(res2.statusCode === 200 || res2.statusCode === 206);
        }).on('error', () => resolve(false));
      } else {
        resolve(res.statusCode === 200 || res.statusCode === 206);
      }
    });
    req.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Hartco Data Architecture Overhaul ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // ── Step 1: Look up vendor ──
  const vendorResult = await pool.query("SELECT id FROM vendors WHERE code = 'TW'");
  if (!vendorResult.rows.length) {
    console.error('Vendor TW not found');
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor: TW (${vendorId})`);

  // Pre-fetch category IDs
  const catResult = await pool.query('SELECT id, slug FROM categories');
  const catMap = {};
  for (const row of catResult.rows) catMap[row.slug] = row.id;

  // ── Step 2: Query all AHF/Hartco SKUs ──
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type,
           s.sell_by, s.product_id,
           p.collection as p_collection, p.name as p_name, p.id as pid,
           p.category_id as p_category_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND (p.collection ILIKE '%AHF%' OR p.collection ILIKE '%hartco%'
           OR s.vendor_sku LIKE 'AHF%')
    ORDER BY s.vendor_sku
  `, [vendorId]);

  console.log(`Found ${skuResult.rows.length} AHF/Hartco SKUs to classify\n`);

  // ── Step 3: Classify each SKU ──
  const classified = [];    // { row, bareSku, match, isAccessory }
  const unclassified = [];  // SKUs that don't match any prefix rule
  const nonHartco = [];     // Non-Hartco AHF products (skip)

  for (const row of skuResult.rows) {
    // Skip non-Hartco AHF brands
    if (isNonHartco(row.p_name, row.p_collection)) {
      nonHartco.push(row);
      continue;
    }

    const bareSku = normalize(row.vendor_sku);
    const match = classifySku(bareSku);
    const isAcc = isAccessorySku(bareSku, row.variant_type);

    if (match) {
      classified.push({ row, bareSku, match, isAccessory: isAcc });
    } else {
      unclassified.push({ row, bareSku });
    }
  }

  console.log(`Classified: ${classified.length}`);
  console.log(`Unclassified: ${unclassified.length}`);
  console.log(`Non-Hartco (skipped): ${nonHartco.length}`);

  if (unclassified.length > 0) {
    console.log('\nSample unclassified SKUs (first 20):');
    for (const { row, bareSku } of unclassified.slice(0, 20)) {
      console.log(`  ${row.vendor_sku} → ${bareSku}  (product: "${row.p_name}", collection: "${row.p_collection}")`);
    }
  }

  // ── Step 4: Group classified SKUs → canonical products ──
  // Key: "collection|||construction|||isAccessory"
  // Floor products: one product per collection + construction combo
  // Accessory products: one product per collection (all accessories together)
  const productGroups = new Map();

  for (const item of classified) {
    const accFlag = item.isAccessory ? 'acc' : 'floor';
    const key = `${item.match.collection}|||${item.match.construction}|||${accFlag}`;

    if (!productGroups.has(key)) {
      productGroups.set(key, {
        collection: item.match.collection,
        construction: item.match.construction,
        category: item.match.category,
        isAccessory: item.isAccessory,
        skus: [],
      });
    }
    productGroups.get(key).skus.push(item);
  }

  console.log(`\nCanonical product groups: ${productGroups.size}`);

  // ── Step 5: Create/update products and reassign SKUs ──
  const stats = {
    products_created: 0,
    products_updated: 0,
    skus_moved: 0,
    skus_unchanged: 0,
    media_moved: 0,
    orphans_deleted: 0,
    images_added: 0,
  };

  // Track old product IDs to check for orphans later
  const oldProductIds = new Set();
  for (const item of classified) {
    oldProductIds.add(item.row.product_id);
  }

  const newProductIds = new Set();

  for (const [key, group] of productGroups) {
    const { collection, construction, category, isAccessory } = group;
    const categoryId = catMap[category] || null;

    // Build product name
    let productName;
    if (isAccessory) {
      productName = `Hartco ${collection} Accessories`;
    } else {
      productName = `Hartco ${collection} ${construction}`;
    }

    // Build descriptions
    const descShort = isAccessory
      ? `Trim & Accessories | for Hartco ${collection}`
      : `${construction} | by Hartco | ${collection} Collection`;
    const descLong = isAccessory
      ? `Trim and accessory products for the Hartco ${collection} collection.`
      : `${construction} flooring by Hartco. Part of the ${collection} collection.`;

    // Use 'Hartco' as the collection field (brand-level, like other vendors)
    // but append SPC for SPC products to differentiate in storefront
    let dbCollection = 'Hartco';
    if (['Pikes Peak SPC', 'Denali SPC', 'Everest SPC'].includes(collection)) {
      dbCollection = `Hartco ${collection}`;
    }

    // Upsert product
    let productId;
    if (!DRY_RUN) {
      const existing = await pool.query(
        'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
        [vendorId, dbCollection, productName]
      );

      if (existing.rows.length > 0) {
        productId = existing.rows[0].id;
        await pool.query(`
          UPDATE products SET category_id = COALESCE($1, category_id), status = 'active',
            description_short = COALESCE($2, description_short),
            description_long = COALESCE($3, description_long),
            updated_at = NOW()
          WHERE id = $4
        `, [categoryId, descShort, descLong, productId]);
        stats.products_updated++;
      } else {
        const pResult = await pool.query(`
          INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
          VALUES ($1, $2, $3, $4, 'active', $5, $6)
          RETURNING id
        `, [vendorId, productName, dbCollection, categoryId, descShort, descLong]);
        productId = pResult.rows[0].id;
        stats.products_created++;
      }
      newProductIds.add(productId);
    }

    console.log(`\n${isAccessory ? 'ACC' : 'FLR'} ${productName} (${dbCollection}) — ${group.skus.length} SKUs`);

    // Reassign SKUs
    for (const item of group.skus) {
      const { row } = item;
      const needsMove = DRY_RUN ? true : (row.product_id !== productId);

      if (needsMove && !DRY_RUN) {
        await pool.query('UPDATE skus SET product_id = $1, updated_at = NOW() WHERE id = $2', [productId, row.id]);

        // Move SKU-level media assets
        const mediaResult = await pool.query(
          'UPDATE media_assets SET product_id = $1 WHERE sku_id = $2 AND product_id != $1 RETURNING id',
          [productId, row.id]
        );
        stats.media_moved += mediaResult.rowCount;

        // Update variant_type for accessories
        if (item.isAccessory && row.variant_type !== 'accessory') {
          await pool.query("UPDATE skus SET variant_type = 'accessory', sell_by = 'unit' WHERE id = $1", [row.id]);
        }

        stats.skus_moved++;
      } else if (!needsMove) {
        stats.skus_unchanged++;
      }

      if (DRY_RUN) {
        const moveLabel = row.product_id === 'N/A' ? 'NEW' : 'MOVE';
        console.log(`    ${moveLabel} ${row.vendor_sku} (${row.variant_name || 'unnamed'}) from "${row.p_name}"`);
      }
    }
  }

  // ── Step 6: Delete orphaned products ──
  console.log('\n── Checking for orphaned products ──');

  for (const oldPid of oldProductIds) {
    if (newProductIds.has(oldPid)) continue;

    // Check if this product still has any SKUs
    const skuCount = await pool.query('SELECT COUNT(*) FROM skus WHERE product_id = $1', [oldPid]);
    if (parseInt(skuCount.rows[0].count) === 0) {
      // Get product info for logging
      const pInfo = await pool.query('SELECT name, collection FROM products WHERE id = $1', [oldPid]);
      if (pInfo.rows.length > 0) {
        const { name, collection } = pInfo.rows[0];
        console.log(`  DELETE orphan: "${name}" (${collection})`);

        if (!DRY_RUN) {
          // Delete media assets first (FK constraint)
          await pool.query('DELETE FROM media_assets WHERE product_id = $1', [oldPid]);
          await pool.query('DELETE FROM products WHERE id = $1', [oldPid]);
        }
        stats.orphans_deleted++;
      }
    }
  }

  // ── Step 7: Backfill CDN images ──
  console.log('\n── Backfilling CDN images ──');

  const missingImgResult = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name,
           p.id as product_id, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1
      AND p.collection LIKE 'Hartco%'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND ma.id IS NULL
    ORDER BY s.vendor_sku
  `, [vendorId]);

  console.log(`Floor SKUs without images: ${missingImgResult.rows.length}`);

  const CONCURRENCY = 8;
  let cdnHits = 0, missed = 0;

  for (let i = 0; i < missingImgResult.rows.length; i += CONCURRENCY) {
    const batch = missingImgResult.rows.slice(i, i + CONCURRENCY);
    const checks = await Promise.all(batch.map(async row => {
      const norm = normalize(row.vendor_sku);
      const cdnUrl = `${CDN_BASE}${norm}.jpg`;
      const ok = await checkCdn(cdnUrl);
      return { row, url: ok ? cdnUrl : null };
    }));

    for (const { row, url } of checks) {
      if (url) {
        cdnHits++;
        console.log(`  + ${row.vendor_sku} → ${url}`);
        if (!DRY_RUN) {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1, $2, 'primary', $3, $3, 0, 'scraper')
            ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
            DO UPDATE SET url = $3, original_url = $3
          `, [row.product_id, row.sku_id, url]);
          stats.images_added++;
        }
      } else {
        missed++;
      }
    }
  }

  console.log(`CDN hits: ${cdnHits}, No match: ${missed}`);

  // ── Summary ──
  console.log('\n=== Summary ===');
  console.log(`Products created:  ${stats.products_created}`);
  console.log(`Products updated:  ${stats.products_updated}`);
  console.log(`SKUs moved:        ${stats.skus_moved}`);
  console.log(`SKUs unchanged:    ${stats.skus_unchanged}`);
  console.log(`Media moved:       ${stats.media_moved}`);
  console.log(`Orphans deleted:   ${stats.orphans_deleted}`);
  console.log(`Images added:      ${stats.images_added}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No database changes were made.');
  } else {
    // Refresh search vectors for affected products
    console.log('\nRefreshing search vectors...');
    for (const pid of newProductIds) {
      await pool.query('SELECT refresh_search_vectors($1)', [pid]);
    }
    console.log('Done.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
