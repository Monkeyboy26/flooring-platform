import pg from 'pg';
import { upsertMediaAsset } from './base.js';

/**
 * Daltile Installation Sub-Brand Enrichment Orchestrator.
 *
 * Enriches 3,707 products (20,054 SKUs) across 8 sub-brands that came through
 * Daltile's 832 EDI with truncated names, no descriptions, junk attributes,
 * and retail_price == cost (no markup).
 *
 * Architecture: orchestrator loads products from DB, dispatches to per-brand
 * crawl modules, then applies UPDATE queries (not upsertProduct, since the
 * name is part of the conflict key and we need to change it).
 *
 * Usage:
 *   docker compose exec api node scrapers/dal-enrich.js [brand]
 *   brand: schluter | mapei | noble | cbp | colorfast | bostik | all (default)
 */

const { Pool } = pg;

// Brand modules — each exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
const BRAND_MODULES = {
  'Schluter Systems LP':           () => import('./dal-enrich-schluter.js'),
  'Mapei Corporation':             () => import('./dal-enrich-mapei.js'),
  'Noble Company INC':             () => import('./dal-enrich-noble.js'),
  'Custom Building Products INC':  () => import('./dal-enrich-cbp.js'),
  'Color Fast Industries INC':     () => import('./dal-enrich-colorfast.js'),
};

// CLI brand name → collection name mapping
const BRAND_ALIASES = {
  schluter:   'Schluter Systems LP',
  mapei:      'Mapei Corporation',
  noble:      'Noble Company INC',
  cbp:        'Custom Building Products INC',
  colorfast:  'Color Fast Industries INC',
  bostik:     'Bostik INC',
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase() || 'all';

  const pool = new Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
  });

  try {
    console.log('=== Daltile Sub-Brand Enrichment ===\n');

    // Step 1: Attribute cleanup (always runs first)
    await cleanupAttributes(pool);

    // Step 2: Determine which brands to process
    let collections;
    if (arg === 'all') {
      collections = [...Object.keys(BRAND_MODULES), 'Bostik INC'];
    } else {
      const collection = BRAND_ALIASES[arg];
      if (!collection) {
        console.error(`Unknown brand: "${arg}". Valid: ${Object.keys(BRAND_ALIASES).join(', ')}, all`);
        process.exit(1);
      }
      collections = [collection];
    }

    // Step 3: Process each brand
    for (const collection of collections) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Processing: ${collection}`);
      console.log('─'.repeat(60));

      if (collection === 'Bostik INC') {
        await enrichBostik(pool);
        continue;
      }

      const moduleLoader = BRAND_MODULES[collection];
      if (!moduleLoader) {
        console.log(`  No module for ${collection} — skipping`);
        continue;
      }

      try {
        await enrichBrand(pool, collection, moduleLoader);
      } catch (err) {
        console.error(`  ERROR processing ${collection}: ${err.message}`);
      }
    }

    // Step 4: Refresh search vectors for all affected collections
    console.log('\n' + '─'.repeat(60));
    console.log('Refreshing search vectors...');
    await refreshSearchVectors(pool, collections);
    console.log('Done.\n');

  } finally {
    await pool.end();
  }
}

// ─── Attribute Cleanup ───────────────────────────────────────────────────────

/**
 * Step 1: Clean up junk attributes from 832 EDI data.
 * - Strip trailing item codes from colors: "Warm Gray 59301" → "Warm Gray"
 * - Delete placeholder sizes: "0x0EZ"
 */
async function cleanupAttributes(pool) {
  console.log('Step 1: Attribute cleanup...');

  // Get the vendor_id for DAL
  const vendor = await pool.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
  if (!vendor.rows.length) {
    console.log('  No DAL vendor found — skipping cleanup');
    return;
  }
  const vendorId = vendor.rows[0].id;

  // Strip trailing numeric codes from color values (e.g., "Warm Gray 59301" → "Warm Gray")
  const colorClean = await pool.query(`
    UPDATE sku_attributes sa
    SET value = regexp_replace(sa.value, '\\s+\\d{4,}$', '')
    FROM attributes a, skus s, products p
    WHERE sa.attribute_id = a.id
      AND a.slug = 'color'
      AND sa.sku_id = s.id
      AND s.product_id = p.id
      AND p.vendor_id = $1
      AND sa.value ~ '\\s+\\d{4,}$'
  `, [vendorId]);
  console.log(`  Colors cleaned: ${colorClean.rowCount}`);

  // Delete placeholder "0x0EZ" size attributes
  const sizeClean = await pool.query(`
    DELETE FROM sku_attributes sa
    USING attributes a, skus s, products p
    WHERE sa.attribute_id = a.id
      AND a.slug = 'size'
      AND sa.sku_id = s.id
      AND s.product_id = p.id
      AND p.vendor_id = $1
      AND sa.value = '0x0EZ'
  `, [vendorId]);
  console.log(`  Placeholder sizes deleted: ${sizeClean.rowCount}`);
}

// ─── Brand Enrichment ────────────────────────────────────────────────────────

/**
 * Enrich all products for a single brand.
 * 1. Load products from DB
 * 2. Call brand module's crawl() to get enrichment data
 * 3. Match and apply updates
 */
async function enrichBrand(pool, collection, moduleLoader) {
  // Load products for this collection
  const products = await loadProducts(pool, collection);
  console.log(`  Loaded ${products.length} products from DB`);

  if (products.length === 0) return;

  // Load the brand module and crawl
  const mod = await moduleLoader();
  console.log('  Crawling manufacturer website...');
  const enrichmentMap = await mod.crawl();
  console.log(`  Crawled ${enrichmentMap.size} products from website`);

  // Match and update
  let stats = { matched: 0, nameUpdated: 0, descUpdated: 0, catUpdated: 0, imgUpdated: 0, skipped: 0 };

  for (const prod of products) {
    try {
      const result = await matchAndUpdate(pool, prod, enrichmentMap, collection);
      if (result.matched) {
        stats.matched++;
        if (result.nameUpdated) stats.nameUpdated++;
        if (result.descUpdated) stats.descUpdated++;
        if (result.catUpdated) stats.catUpdated++;
        stats.imgUpdated += result.imagesAdded || 0;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.skipped++;
      // Only log first few errors to avoid spam
      if (stats.skipped <= 5) {
        console.error(`    Error on "${prod.name}": ${err.message}`);
      }
    }

    // Progress
    const total = stats.matched + stats.skipped;
    if (total % 100 === 0 && total > 0) {
      console.log(`    Progress: ${total}/${products.length} — matched: ${stats.matched}`);
    }
  }

  console.log(`  Results for ${collection}:`);
  console.log(`    Products matched:    ${stats.matched}/${products.length}`);
  console.log(`    Names updated:       ${stats.nameUpdated}`);
  console.log(`    Descriptions added:  ${stats.descUpdated}`);
  console.log(`    Categories set:      ${stats.catUpdated}`);
  console.log(`    Images added:        ${stats.imgUpdated}`);
  console.log(`    Unmatched:           ${stats.skipped}`);
}

// ─── DB Loading ──────────────────────────────────────────────────────────────

async function loadProducts(pool, collection) {
  const result = await pool.query(`
    SELECT p.id, p.name, p.collection, p.vendor_id, p.category_id,
           p.description_short, p.description_long
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL'
      AND p.collection = $1
    ORDER BY p.name
  `, [collection]);
  return result.rows;
}

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

// ─── Matching & Updates ──────────────────────────────────────────────────────

/**
 * Match a DB product to enrichment data and apply updates.
 * Uses the brand module's normalize key to look up enrichment data.
 */
async function matchAndUpdate(pool, product, enrichmentMap, collection) {
  // Try to find a match in the enrichment map
  const match = findMatch(product, enrichmentMap, collection);
  if (!match) return { matched: false };

  const result = { matched: true, nameUpdated: false, descUpdated: false, catUpdated: false, imagesAdded: 0 };

  // Check for name collision before updating
  if (match.fullName && match.fullName !== product.name) {
    const collision = await pool.query(
      `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4`,
      [product.vendor_id, product.collection, match.fullName, product.id]
    );

    if (collision.rows.length === 0) {
      await pool.query(
        `UPDATE products SET name = $2, updated_at = NOW() WHERE id = $1`,
        [product.id, match.fullName]
      );
      result.nameUpdated = true;
    }
  }

  // Update descriptions (only if currently empty or just a truncated duplicate)
  if (match.descShort || match.descLong) {
    const needsDesc = !product.description_long || product.description_long === product.description_short;
    if (needsDesc) {
      await pool.query(
        `UPDATE products SET
           description_short = COALESCE($2, description_short),
           description_long = COALESCE($3, description_long),
           updated_at = NOW()
         WHERE id = $1`,
        [product.id, match.descShort || null, match.descLong || null]
      );
      result.descUpdated = true;
    }
  }

  // Update category (only if not already set)
  if (match.category && !product.category_id) {
    await pool.query(
      `UPDATE products SET category_id = $2, updated_at = NOW() WHERE id = $1`,
      [product.id, match.category]
    );
    result.catUpdated = true;
  }

  // Add images (only if product doesn't have images yet)
  if (match.images && match.images.length > 0) {
    const existing = await pool.query(
      `SELECT id FROM media_assets WHERE product_id = $1 LIMIT 1`,
      [product.id]
    );
    if (existing.rows.length === 0) {
      for (let i = 0; i < Math.min(match.images.length, 6); i++) {
        const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
        await upsertMediaAsset(pool, {
          product_id: product.id,
          sku_id: null,
          asset_type: assetType,
          url: match.images[i],
          original_url: match.images[i],
          sort_order: i,
        });
        result.imagesAdded++;
      }
    }
  }

  return result;
}

/**
 * Find the best match for a product in the enrichment map.
 * Each brand module provides data keyed by normalized product line name.
 * We extract the product line from the DB name and try various match strategies.
 */
function findMatch(product, enrichmentMap, collection) {
  const name = product.name;

  // Extract brand prefix and product line name based on collection
  const prefixMap = {
    'Schluter Systems LP': /^Sch\s+/i,
    'Mapei Corporation': /^Map\s+/i,
    'Noble Company INC': /^Nob\s+/i,
    'Custom Building Products INC': /^Cbp\s+/i,
    'Color Fast Industries INC': /^Cf\s+/i,
    'Bostik INC': /^Bos\s+/i,
  };

  const prefix = prefixMap[collection];
  if (!prefix) return null;

  let baseName = name.replace(prefix, '').trim();

  // Strip trailing quantity/unit for matching
  baseName = baseName
    .replace(/\s+\d+"?\s*x\s*\d+"?.*$/i, '')              // dimensions (NxN)
    .replace(/\s+\d+'?\s*x\s*\d+'?.*$/i, '')              // dimensions (N'xN')
    .replace(/\s+\d+(\.\d+)?\s*(lb|lbs|gal|oz|pc|pcs|roll|sqft|qt|gm|ft|lf|sf|each|ct|tube|bag|pail|bucket|kit|pt|fl|mil)\b.*$/i, '')
    .replace(/\s+\d+sf\s+.*$/i, '')                        // sf suffix
    .replace(/\s+\d+\/\d+"?.*$/i, '')                      // fractions (3/8" Alum...)
    .replace(/\s+\d+'-?\d*"?\s*[x×]\s*\d+.*$/i, '')       // feet dimensions (3'3"x16'5"...)
    .replace(/\s+=\s*\d+.*$/i, '')                         // equals area (= 323sf...)
    .replace(/\s+\d+-\d+\/\d+"?.*$/i, '')                  // mixed fractions (2-1/8")
    .trim();
  // Strip trailing numbers repeatedly (e.g., "Kerdi-Band 5 33" → "Kerdi-Band")
  while (/\s+\d+(\.\d+)?\s*$/.test(baseName)) {
    baseName = baseName.replace(/\s+\d+(\.\d+)?\s*$/, '').trim();
  }
  // Strip trailing material/type descriptors that appear after the product line name
  // (e.g., "Trep-B Alum" → "Trep-B", "Reno-Ramp Wide Reducer Alum" → "Reno-Ramp")
  baseName = baseName
    .replace(/\s+(Alum|Aluminum|Stainless|Steel|Chrome|Brass|Bronze|Pvc|Rubber)\b.*$/i, '')
    .replace(/\s+(Wide|Narrow)\s+(Reducer|Tread).*$/i, '')
    .replace(/\s+(Reducer|Tread|Roll|Sheet|Membrane|Thermostat|End Cap|Straight|Semi-Circ).*$/i, '')
    .replace(/\s+(Rplcmt|Replacement)\b.*$/i, '')
    .trim();

  const key = normalize(baseName);

  // Try exact match
  if (enrichmentMap.has(key)) return enrichmentMap.get(key);

  // Try with slight variations
  const keyNoAmpersand = key.replace(/&/g, '').replace(/\s+/g, ' ').trim();
  if (enrichmentMap.has(keyNoAmpersand)) return enrichmentMap.get(keyNoAmpersand);

  // Try containment — prefer the longest matching key to avoid "kerdi" beating "kerdi band"
  let bestContainment = null;
  let bestContainmentLen = 0;

  for (const [mapKey, data] of enrichmentMap) {
    if (key.includes(mapKey) && mapKey.length > bestContainmentLen) {
      bestContainmentLen = mapKey.length;
      bestContainment = data;
    }
    if (mapKey.includes(key) && key.length > bestContainmentLen) {
      bestContainmentLen = key.length;
      bestContainment = data;
    }
  }

  if (bestContainment) return bestContainment;

  // Try word overlap (Jaccard >= 0.5)
  const keyWords = new Set(key.split(' ').filter(w => w.length >= 2));
  let bestScore = 0;
  let bestMatch = null;

  for (const [mapKey, data] of enrichmentMap) {
    const mapWords = new Set(mapKey.split(' ').filter(w => w.length >= 2));
    const intersection = [...keyWords].filter(w => mapWords.has(w));
    const union = new Set([...keyWords, ...mapWords]);
    const jaccard = union.size > 0 ? intersection.length / union.size : 0;

    if (jaccard > bestScore && jaccard >= 0.5) {
      bestScore = jaccard;
      bestMatch = data;
    }
  }

  return bestMatch;
}

function normalize(name) {
  return name.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Bostik (Inline — Only 2 Products) ──────────────────────────────────────

async function enrichBostik(pool) {
  const products = await loadProducts(pool, 'Bostik INC');
  console.log(`  Loaded ${products.length} Bostik products`);

  if (products.length === 0) return;

  // Hardcoded enrichment for the 2 Bostik products
  // These came through Daltile EDI as truncated names
  const catMap = await loadCategoryMap(pool);
  const adhesivesCat = catMap['adhesives-sealants'] || null;

  let updated = 0;
  for (const prod of products) {
    const baseName = prod.name.replace(/^Bos\s+/i, '').trim();

    // Try to build a proper name from the truncated EDI name
    const fullName = `Bostik ${titleCase(baseName)}`;
    const descShort = `Bostik ${titleCase(baseName)} — professional-grade installation product.`;

    // Update name and description
    const collision = await pool.query(
      `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4`,
      [prod.vendor_id, prod.collection, fullName, prod.id]
    );

    if (collision.rows.length === 0 && fullName !== prod.name) {
      await pool.query(
        `UPDATE products SET name = $2, description_short = $3,
           category_id = COALESCE($4, category_id), updated_at = NOW()
         WHERE id = $1`,
        [prod.id, fullName, descShort, adhesivesCat]
      );
      updated++;
    }
  }

  console.log(`  Bostik: ${updated}/${products.length} products updated`);
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Search Vector Refresh ───────────────────────────────────────────────────

async function refreshSearchVectors(pool, collections) {
  // Refresh search vectors for all products in affected collections
  // Matches the refresh_search_vectors() function in schema.sql
  for (const collection of collections) {
    const result = await pool.query(`
      UPDATE products p SET search_vector =
        setweight(to_tsvector('english', unaccent(coalesce(p.name, ''))), 'A') ||
        setweight(to_tsvector('english', unaccent(coalesce(p.collection, ''))), 'A') ||
        setweight(to_tsvector('english', unaccent(coalesce(v.name, ''))), 'B') ||
        setweight(to_tsvector('english', unaccent(coalesce(
          (SELECT c.name FROM categories c WHERE c.id = p.category_id), ''))), 'B') ||
        setweight(to_tsvector('english', unaccent(coalesce(p.description_short, ''))), 'C') ||
        setweight(to_tsvector('english', unaccent(coalesce(
          (SELECT string_agg(DISTINCT sa.value, ' ')
           FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
           WHERE s.product_id = p.id AND s.status = 'active'), ''))), 'D')
      FROM vendors v
      WHERE v.id = p.vendor_id
        AND p.collection = $1
    `, [collection]);
    console.log(`  ${collection}: ${result.rowCount} search vectors refreshed`);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
