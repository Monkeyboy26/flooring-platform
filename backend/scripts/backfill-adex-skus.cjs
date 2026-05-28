/**
 * Backfill missing ADEX SKUs from the product map.
 *
 * The Excel import creates SKUs for items in the price list. However, the ADEX
 * website has additional products (End Caps, Frame Corners, Bullnoses, Hex tiles)
 * that weren't in the Excel. This script finds those missing codes and creates
 * SKUs by:
 *   1. Matching to existing products by name (same product, different color)
 *   2. Copying pricing/packaging from a sibling SKU of the same product
 *   3. Setting appropriate attributes (color, size, finish, material, collection)
 *
 * Usage:
 *   docker compose exec api node scripts/backfill-adex-skus.cjs [--dry-run]
 */

const pg = require('pg');
const fs = require('fs');
const path = require('path');

const PRODUCT_MAP_PATH = path.join(__dirname, '..', 'data', 'adex-product-map.json');
const RETAIL_MARKUP = 2.5;

const FINISHES = ['Glossy', 'Matte', 'Satin', 'Polished', 'Honed', 'Textured', 'Crackle', 'Metallic'];

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

function titleCase(str) {
  if (!str) return '';
  return str.replace(/\b\w/g, c => c.toUpperCase()).replace(/\bX\b/g, 'x');
}

/**
 * Parse color and finish from subserie name.
 * "Cloud Glossy" → { color: "Cloud", finish: "Glossy" }
 * "Cadet Gray" → { color: "Cadet Gray", finish: null }
 */
function parseColorFinish(subserieName) {
  if (!subserieName) return { color: null, finish: null };
  const name = subserieName.trim();
  for (const f of FINISHES) {
    if (name.toLowerCase().endsWith(' ' + f.toLowerCase())) {
      const colorPart = name.slice(0, -(f.length + 1)).trim();
      return { color: colorPart, finish: f };
    }
  }
  return { color: name, finish: null };
}

/**
 * Parse size from product map dimensions string.
 * '2.8"x5.8"' → '2.8x5.8'
 * '3 x 6' → '3x6'
 */
function parseSize(dimensions) {
  if (!dimensions) return null;
  const m = dimensions.match(/([\d.]+(?:\s*\/\s*\d+)?)[""″]?\s*[xX×]\s*([\d.]+(?:\s*\/\s*\d+)?)/);
  if (m) return m[1].replace(/\s/g, '') + 'x' + m[2].replace(/\s/g, '');
  return null;
}

/**
 * Normalize a product name for matching.
 * Strips quotes, extra spaces, normalizes case.
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .replace(/[""″'']/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build a matching key from a product map entry name to find the parent product in DB.
 * "Rail Molding End Cap" → look for product "Rail Molding"
 * "Chair Molding Frame Corner" → look for product "Chair Molding"
 * "Base Board End Cap" → look for product "Base Board (glazed Top Edge)" or similar
 */
function getParentProductName(mapName) {
  if (!mapName) return null;
  // Strip accessory suffixes to find parent
  const stripped = mapName
    .replace(/\s+End\s+Cap$/i, '')
    .replace(/\s+Frame\s+Corner$/i, '')
    .replace(/\s+Corner$/i, '')
    .trim();
  return stripped !== mapName ? stripped : null;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (dryRun) console.log('DRY RUN — no DB writes\n');

  // Load product map
  let productMap;
  try {
    productMap = JSON.parse(fs.readFileSync(PRODUCT_MAP_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to load product map from ${PRODUCT_MAP_PATH}`);
    console.error('Run: node scripts/build-adex-product-map.cjs');
    process.exit(1);
  }

  // Get vendor ID
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ADEX'");
  if (!vendorRes.rows.length) { console.error('ADEX vendor not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;

  // Pre-fetch attribute IDs
  const attrRes = await pool.query(
    "SELECT id, slug FROM attributes WHERE slug = ANY($1)",
    [['color', 'size', 'finish', 'material', 'collection']]
  );
  const attrIds = {};
  for (const row of attrRes.rows) attrIds[row.slug] = row.id;

  // Load all existing ADEX vendor_sku codes (active only)
  const existingRes = await pool.query(`
    SELECT s.vendor_sku FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND s.status = 'active'
  `);
  const existingCodes = new Set(existingRes.rows.map(r => r.vendor_sku));
  console.log(`Existing ADEX SKUs in DB: ${existingCodes.size}`);

  // Load all existing ADEX products (for matching by name + collection)
  const productsRes = await pool.query(`
    SELECT p.id, LOWER(p.name) as name, LOWER(p.collection) as collection, p.category_id
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND p.status = 'active'
  `);
  // Build lookup: "collection|name" → product
  const productLookup = {};
  for (const p of productsRes.rows) {
    const key = `${p.collection}|${p.name}`;
    productLookup[key] = p;
  }

  // For each missing code, try to find a sibling SKU to copy pricing from
  // sibling = same product, different color
  const siblingCache = {};  // product_id → { pricing, packaging }
  async function getSiblingData(productId) {
    if (siblingCache[productId]) return siblingCache[productId];
    const res = await pool.query(`
      SELECT s.sell_by, s.variant_type,
        pr.cost, pr.retail_price, pr.price_basis,
        pk.sqft_per_box, pk.pieces_per_box, pk.boxes_per_pallet, pk.sqft_per_pallet, pk.weight_per_box_lbs
      FROM skus s
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE s.product_id = $1 AND s.status = 'active'
      LIMIT 1
    `, [productId]);
    const data = res.rows[0] || null;
    siblingCache[productId] = data;
    return data;
  }

  // Collect all missing entries
  const missing = [];
  for (const [collName, collData] of Object.entries(productMap.collections)) {
    for (const [colorName, colorData] of Object.entries(collData.colors || {})) {
      for (const product of (colorData.products || [])) {
        const code = product.code;
        if (!code || existingCodes.has(code)) continue;
        missing.push({
          code,
          mapName: product.name,
          dimensions: product.dimensions,
          collection: collName,
          subserie: colorName,
          category: product.category,
        });
      }
    }
  }
  console.log(`Missing SKUs to backfill: ${missing.length}\n`);

  const stats = { created: 0, skipped: 0, noMatch: 0, newProducts: 0 };
  const noMatchList = [];

  for (const entry of missing) {
    const { color, finish } = parseColorFinish(entry.subserie);
    const size = parseSize(entry.dimensions);
    const collLower = entry.collection.toLowerCase();
    const mapNameLower = normalizeName(entry.mapName);

    // Determine the product name and variant info
    // The product map "name" is something like "Field Tile", "Rail Molding End Cap", etc.
    // In the DB, accessories got merged into parent products with variant_type='accessory'
    let isAccessory = false;
    let variantType = null;
    let accessoryLabel = null;
    if (/end\s+cap/i.test(entry.mapName)) {
      isAccessory = true;
      variantType = 'accessory';
      accessoryLabel = 'End Cap';
    } else if (/frame\s+corner/i.test(entry.mapName)) {
      isAccessory = true;
      variantType = 'accessory';
      accessoryLabel = 'Frame Corner';
    } else if (/\bcorner\b/i.test(entry.mapName) && !/frame/i.test(entry.mapName)) {
      isAccessory = true;
      variantType = 'accessory';
      accessoryLabel = entry.mapName.match(/\b(\w+\s+Corner)\b/i)?.[1] || 'Corner';
    } else if (/\bbeak\b/i.test(entry.mapName)) {
      isAccessory = true;
      variantType = 'accessory';
      accessoryLabel = 'Beak';
    }

    // Try to find the matching product in DB
    let productId = null;
    let matchedProduct = null;

    // Strategy 1: Direct name match (collection + product name from map)
    // Product names in DB use titleCase of the base description from Excel
    // Product map names are like "Field Tile", "Rail Molding", etc.
    const directKey = `${collLower}|${mapNameLower}`;
    if (productLookup[directKey]) {
      matchedProduct = productLookup[directKey];
      productId = matchedProduct.id;
    }

    // Strategy 2: For accessories, find the parent product
    if (!productId && isAccessory) {
      const parentName = getParentProductName(entry.mapName);
      if (parentName) {
        const parentKey = `${collLower}|${normalizeName(parentName)}`;
        if (productLookup[parentKey]) {
          matchedProduct = productLookup[parentKey];
          productId = matchedProduct.id;
        }
      }
    }

    // Strategy 3: Fuzzy match — try adding size to product name
    if (!productId && size) {
      // DB product names often include size: "Field Tile 3 x 6" or "Chair Molding 1.4 x 6"
      const sizeFormatted = size.replace('x', ' x ');
      const withSize = `${collLower}|${mapNameLower} ${sizeFormatted}`;
      if (productLookup[withSize]) {
        matchedProduct = productLookup[withSize];
        productId = matchedProduct.id;
      }
    }

    // Strategy 4: For accessories with size, try parent + size
    if (!productId && isAccessory && size) {
      const parentName = getParentProductName(entry.mapName);
      if (parentName) {
        const sizeFormatted = size.replace('x', ' x ');
        const parentWithSize = `${collLower}|${normalizeName(parentName)} ${sizeFormatted}`;
        if (productLookup[parentWithSize]) {
          matchedProduct = productLookup[parentWithSize];
          productId = matchedProduct.id;
        }
        // Also try with "x" instead of " x "
        const parentWithSize2 = `${collLower}|${normalizeName(parentName + ' ' + size)}`;
        if (!productId && productLookup[parentWithSize2]) {
          matchedProduct = productLookup[parentWithSize2];
          productId = matchedProduct.id;
        }
      }
    }

    // Strategy 5: Scan all products in same collection for partial match
    if (!productId) {
      const searchName = isAccessory ? normalizeName(getParentProductName(entry.mapName) || entry.mapName) : mapNameLower;
      for (const [key, prod] of Object.entries(productLookup)) {
        if (!key.startsWith(collLower + '|')) continue;
        const prodName = key.split('|')[1];
        // Check if the DB product name contains the map name (or vice versa)
        if (prodName.includes(searchName) || searchName.includes(prodName)) {
          // If size matches too, prefer that
          if (size) {
            const sizeFormatted = size.replace('x', ' x ');
            if (prodName.includes(sizeFormatted)) {
              matchedProduct = prod;
              productId = prod.id;
              break;
            }
          }
          // Use first match if no size-specific match yet
          if (!productId) {
            matchedProduct = prod;
            productId = prod.id;
          }
        }
      }
    }

    // Strategy 6: For products not found at all, create a new product
    if (!productId) {
      // Determine product name and category
      const prodBaseName = isAccessory
        ? getParentProductName(entry.mapName) || entry.mapName
        : entry.mapName;

      // Build a product name with size if available
      let productName = titleCase(prodBaseName);
      if (size) {
        const sizeFormatted = size.replace('x', ' x ');
        productName += ' ' + sizeFormatted;
      }

      // Determine category
      const PORCELAIN_COLLECTIONS = new Set(['floor']);
      let categoryId;
      if (collLower === 'mosaic') categoryId = '650e8400-e29b-41d4-a716-446655440014';
      else if (PORCELAIN_COLLECTIONS.has(collLower)) categoryId = '650e8400-e29b-41d4-a716-446655440012';
      else categoryId = '650e8400-e29b-41d4-a716-446655440013';

      const collectionTitled = titleCase(entry.collection);

      if (!dryRun) {
        const res = await pool.query(`
          INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
          VALUES ($1, $2, $3, $4, 'active', $5)
          ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
            status = 'active', updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `, [vendorId, productName, collectionTitled, categoryId,
            `ADEX ${collectionTitled} ${productName}`]);
        productId = res.rows[0].id;
        // Add to lookup for future matches
        productLookup[`${collLower}|${normalizeName(productName)}`] = { id: productId, name: normalizeName(productName), collection: collLower, category_id: categoryId };
      }
      stats.newProducts++;
      console.log(`  NEW PRODUCT: ${titleCase(entry.collection)} / ${productName}`);
    }

    if (!productId && dryRun) {
      // In dry-run, just log what would be created
      noMatchList.push(`  ${entry.code}: ${entry.mapName} (${entry.subserie}, ${entry.collection})`);
      stats.noMatch++;
      continue;
    }

    // Get sibling data for pricing/packaging
    const sibling = productId ? await getSiblingData(productId) : null;
    const sellBy = sibling?.sell_by || 'unit';
    const effectiveVariantType = variantType || sibling?.variant_type || null;

    // Build variant name
    let variantName = color || '';
    if (accessoryLabel) {
      variantName = accessoryLabel + (variantName ? ' - ' + variantName : '');
    }
    if (finish) {
      // For non-accessory variants, include finish in variant name
      if (!accessoryLabel) {
        variantName += (variantName ? ' ' : '') + finish;
      }
    }
    if (!variantName) variantName = entry.code;

    const internalSku = 'ADEX-' + entry.code;

    if (dryRun) {
      console.log(`  ${entry.code}: ${variantName} → ${matchedProduct?.name || 'NEW'} (${entry.collection}) [${effectiveVariantType || sellBy}]`);
      stats.created++;
      continue;
    }

    // Create SKU
    const skuRes = await pool.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (internal_sku) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        vendor_sku = EXCLUDED.vendor_sku,
        variant_name = EXCLUDED.variant_name,
        sell_by = EXCLUDED.sell_by,
        variant_type = EXCLUDED.variant_type,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [productId, entry.code, internalSku, variantName, sellBy, effectiveVariantType]);
    const skuId = skuRes.rows[0].id;

    // Copy pricing from sibling
    if (sibling?.cost && sibling?.retail_price) {
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
      `, [skuId, sibling.cost, sibling.retail_price, sibling.price_basis || 'per_unit']);
    }

    // Copy packaging from sibling
    if (sibling?.pieces_per_box || sibling?.sqft_per_box) {
      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet, weight_per_box_lbs)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
          pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
          boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
          sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
          weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs)
      `, [skuId, sibling.sqft_per_box, sibling.pieces_per_box, sibling.boxes_per_pallet,
          sibling.sqft_per_pallet, sibling.weight_per_box_lbs]);
    }

    // Set attributes
    const material = collLower === 'floor' ? 'Porcelain' : collLower === 'mosaic' ? 'Glass/Ceramic' : 'Ceramic';
    if (attrIds.color && color) {
      await pool.query(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrIds.color, color]);
    }
    if (attrIds.size && size) {
      await pool.query(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrIds.size, size]);
    }
    if (attrIds.finish && finish) {
      await pool.query(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrIds.finish, finish]);
    }
    if (attrIds.material) {
      await pool.query(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrIds.material, material]);
    }
    if (attrIds.collection) {
      await pool.query(`INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrIds.collection, titleCase(entry.collection)]);
    }

    stats.created++;
  }

  // Refresh search vectors for affected products
  if (!dryRun && stats.created > 0) {
    console.log('\nRefreshing search vectors...');
    const collections = [...new Set(missing.map(m => titleCase(m.collection)))];
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
             FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
             WHERE s2.product_id = p.id AND s2.status = 'active'), ''))), 'D')
        FROM vendors v
        WHERE v.id = p.vendor_id
          AND p.collection = $1
          AND v.code = 'ADEX'
      `, [collection]);
      console.log(`  ${collection}: ${result.rowCount} search vectors refreshed`);
    }
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`SKUs created:    ${stats.created}`);
  console.log(`New products:    ${stats.newProducts}`);
  console.log(`Skipped:         ${stats.skipped}`);
  console.log(`No match:        ${stats.noMatch}`);

  if (noMatchList.length > 0) {
    console.log('\nNo match found for:');
    noMatchList.forEach(l => console.log(l));
  }

  await pool.end();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
