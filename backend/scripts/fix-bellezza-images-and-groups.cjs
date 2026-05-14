'use strict';

/**
 * fix-bellezza-images-and-groups.cjs
 *
 * Comprehensive fix for Bellezza vendor data:
 * 1. Per-SKU image assignment (match image URLs to correct color variants)
 * 2. Primary image selection (laydown/swatch as primary, not lifestyle)
 * 3. Accessories linkage via sku_accessories table
 * 4. Product collection grouping
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─── COLLECTION GROUPING ────────────────────────────────────────────────────────
// Map product names to logical collection groups
const COLLECTION_MAP = {
  // Marble Look
  'Marble Look': [
    'Armani White', 'Calaca Gold', 'Calacatta Gold', 'Calacatta Natural',
    'Calcutta Gold', 'Elegance Marble Pearl', 'Emporio Calacatta',
    'Golden Blanco', 'Laurent Black', 'Magna White', 'Markina Gold',
    'Marmo Marfil', 'Montblanc Gold', 'Naples White', 'Panda',
    'Pearl Onyx', 'Statuario Nice', 'Statuario Spider', 'Staturio Blue',
    'Vibrant Bianco', 'Dolomite', 'Enigma White', 'Larin Marfil',
  ],
  // Concrete & Industrial Look
  'Concrete & Industrial': [
    'Chamonix', 'Concretus', 'District', 'Fry', 'Grunge',
    'Modern Concrete Ivory', 'Spatula', 'Temper', 'Epoque',
    'Ceppo', 'Unique Ceppo Bone', 'Bolonia Marengo', 'Kadence',
    'Frammenti', 'Volga',
  ],
  // Stone Look
  'Stone Look': [
    'Antwerp', 'Arena Chiaro', 'Camden', 'Grande', 'Hudson',
    'Nord', 'Park', 'Westmount Beige', 'Connor Beige', 'Granby Beige',
    'Granby Ivory', 'Harley Lux', 'Leccese Cesellata', 'Palatino',
    'Sierra', 'Myrcella', 'Arhus',
  ],
  // Wood Look
  'Wood Look': [
    'Docks', 'Gio', 'Puccini', 'Manhattan',
  ],
  // Subway & Artisan
  'Subway & Artisan': [
    'Altea', 'Limit', 'Amazonia', 'Ibiza', 'Lingot',
    'Austral Blanco', 'Austral Essence Blanco', 'Calacatta Brick Gloss',
    'Calacatta Gloss', 'Calacatta Hex Gloss', 'Sun Blanco',
    'Scanda White', 'Sekos White', 'Angelo Silk Shimmer',
    'Artistic White Brillo', 'Celian', 'Elven', 'Insignia White',
    'Kube Blanco', 'Kyoto White', 'Odissey Saphire', 'Scale Decor 3D',
    'Vilema', 'Mixit Concept',
  ],
  // Hexagon & Mosaic
  'Hexagon & Mosaic': [
    'Hex XL Coimbra', 'Hex XL Fosco', 'Hex XL Inverno Grey',
    'NatureGlass Hex', 'Silver Matte Hex', 'Statuario Matte Hex',
    'Nero Marquina Matte Hexagon', 'Penny Calacatta Gold', 'Penny Fosco',
    'Penny Grafito', 'Black Marble Mosaic', 'Chateau Mosaic',
    'Milano Mosaic', 'Stainless Gold Hexagon Mosaic',
    'Metallic Dark Grey Mosaic', 'Dorset Hexagon', 'LN520 Stacked Linear',
  ],
  // Recycled Glass
  'Recycled Glass': [
    'WG001',
  ],
  // Wall Panels
  'Wall Panels': [
    'Acoustic MDF Sound Absorption Panel', 'BPC Interior Panel',
    'Exterior Composite Wall Panel',
  ],
  // Trim & Accessories
  'Trim & Accessories': [
    'Schluter Trim', 'MAPEI Grout Medium Grey',
  ],
  // Milano
  'Milano': [
    'Milano Crema',
  ],
};

// Build reverse map: product name → collection
const PRODUCT_TO_COLLECTION = {};
for (const [collection, products] of Object.entries(COLLECTION_MAP)) {
  for (const name of products) {
    PRODUCT_TO_COLLECTION[name] = collection;
  }
}

// ─── IMAGE COLOR MATCHING ────────────────────────────────────────────────────────
// Common color keywords that appear in Bellezza image URLs
const COLOR_PATTERNS = [
  // Exact color names in URL filenames
  { pattern: /beige/i, colors: ['Beige'] },
  { pattern: /bianco/i, colors: ['Bianco', 'White'] },
  { pattern: /blanc/i, colors: ['Blanc', 'Blanco', 'White'] },
  { pattern: /white/i, colors: ['White', 'Bianco', 'Blanc', 'Blanco'] },
  { pattern: /dark[_-]?gr[ae]y/i, colors: ['Dark Gray', 'Dark Grey'] },
  { pattern: /gr[ae]y(?!stone)/i, colors: ['Gray', 'Grey', 'Gris'] },
  { pattern: /gris/i, colors: ['Gris', 'Gray', 'Grey'] },
  { pattern: /ocean/i, colors: ['Ocean'] },
  { pattern: /antracit[ea]/i, colors: ['Antracite', 'Anthracite'] },
  { pattern: /bone/i, colors: ['Bone'] },
  { pattern: /noir/i, colors: ['Noir', 'Black'] },
  { pattern: /black/i, colors: ['Black', 'Noir'] },
  { pattern: /ash[_-]?blue/i, colors: ['Ash Blue'] },
  { pattern: /dusty[_-]?pink/i, colors: ['Dusty Pink'] },
  { pattern: /matcha/i, colors: ['Matcha'] },
  { pattern: /pine[_-]?green/i, colors: ['Pine Green'] },
  { pattern: /rosewood/i, colors: ['Rosewood'] },
  { pattern: /smoke/i, colors: ['Smoke'] },
  { pattern: /thistle/i, colors: ['Thistle Blue'] },
  { pattern: /coral/i, colors: ['Coral'] },
  { pattern: /aqua/i, colors: ['Aqua'] },
  { pattern: /mint/i, colors: ['Mint'] },
  { pattern: /blue/i, colors: ['Blue', 'Bleu Izu'] },
  { pattern: /ivory/i, colors: ['Ivory'] },
  { pattern: /golden/i, colors: ['Golden'] },
  { pattern: /iron/i, colors: ['Iron'] },
  { pattern: /frost/i, colors: ['Frost'] },
  { pattern: /coal/i, colors: ['Coal'] },
  { pattern: /natural/i, colors: ['Natural'] },
  { pattern: /moon/i, colors: ['Moon', 'Moon Calma'] },
  { pattern: /calma/i, colors: ['Moon Calma'] },
  { pattern: /sand/i, colors: ['Sand'] },
  { pattern: /cotto/i, colors: ['Cotto'] },
  { pattern: /terra/i, colors: ['Terre', 'Terre Cuit'] },
  { pattern: /sable/i, colors: ['Sable'] },
  { pattern: /jaune/i, colors: ['Jaune'] },
  { pattern: /vert/i, colors: ['Vert'] },
  { pattern: /menthe/i, colors: ['Menthe'] },
  { pattern: /rose/i, colors: ['Rose'] },
  { pattern: /bleu/i, colors: ['Bleu Izu'] },
  { pattern: /crema/i, colors: ['Crema'] },
  { pattern: /walnut/i, colors: ['Walnut', 'Dark Walnut', 'Light Walnut'] },
  { pattern: /dark[_-]?walnut/i, colors: ['Dark Walnut'] },
  { pattern: /light[_-]?walnut/i, colors: ['Light Walnut'] },
  { pattern: /pine(?!.*green)/i, colors: ['Pine'] },
  { pattern: /oak/i, colors: ['Oak'] },
  { pattern: /coffee/i, colors: ['Coffee Brown', 'Dark Coffee'] },
  { pattern: /jet[_-]?black/i, colors: ['Jet Black'] },
];

/**
 * Extract color hint from a URL filename
 */
function extractColorsFromUrl(url) {
  const filename = url.split('/').pop().split('?')[0];
  const colors = new Set();
  for (const { pattern, colors: matchColors } of COLOR_PATTERNS) {
    if (pattern.test(filename)) {
      for (const c of matchColors) colors.add(c);
    }
  }
  return [...colors];
}

/**
 * Check if an image URL looks like a laydown/swatch (good primary)
 */
function isLaydownOrSwatch(url) {
  const filename = url.split('/').pop().toLowerCase();
  // Laydown photos, product swatches, .png swatch files with short names
  if (filename.includes('laydown')) return true;
  if (filename.includes('swatch')) return true;
  // Small PNG files that are just color swatches (e.g., "Antracite.png", "Grey.png")
  if (filename.match(/^[a-z_-]+\.png$/i) && !filename.includes('brochure')) return true;
  return false;
}

/**
 * Check if an image URL looks like a lifestyle shot (room scene)
 */
function isLifestyle(url) {
  const filename = url.split('/').pop().toLowerCase();
  if (filename.includes('1920x1080')) return true;
  if (filename.includes('kitchen')) return true;
  if (filename.includes('bath')) return true;
  if (filename.includes('wall')) return true;
  if (filename.includes('room')) return true;
  if (filename.includes('living')) return true;
  if (filename.includes('interior')) return true;
  if (filename.includes('-min.')) return true;
  return false;
}

// ─── ACCESSORY LINKAGE ──────────────────────────────────────────────────────────
// Define which accessories go with which tile products
// Format: { accessoryProduct, parentProduct, matchByColor }
const ACCESSORY_LINKS = [
  // Altea Jolly Trim → Altea tiles (per-color)
  { accessoryProduct: 'Altea', accessoryPattern: 'Jolly Trim', parentProduct: 'Altea', parentPatterns: ['Square', 'Subway'], matchByColor: true },
  // Limit Jolly Trim → Limit tiles (per-color)
  { accessoryProduct: 'Limit', accessoryPattern: 'Jolly Trim', parentProduct: 'Limit', parentPatterns: ['Subway'], matchByColor: true },
  // Schluter Trim → All porcelain tile products (generic)
  { accessoryProduct: 'Schluter Trim', parentCategory: 'Porcelain Tile', matchByColor: false },
  // MAPEI Grout → Lingot (as specified in price list: "Suggested for Deco Lingot Series")
  { accessoryProduct: 'MAPEI Grout Medium Grey', parentProduct: 'Lingot', matchByColor: false },
];

// ─── MAIN FIX FUNCTION ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bellezza Fix: Images, Accessories & Collections ===\n');

  // Get vendor ID
  const vendorRow = await pool.query("SELECT id FROM vendors WHERE code = 'BELLEZZA'");
  if (!vendorRow.rows.length) { console.error('Vendor BELLEZZA not found'); process.exit(1); }
  const vendorId = vendorRow.rows[0].id;

  // ─── STEP 1: Fix Collection Grouping ────────────────────────────────────
  console.log('--- Step 1: Updating product collections ---\n');
  let collectionsUpdated = 0;

  const allProducts = await pool.query(
    'SELECT id, name, collection FROM products WHERE vendor_id = $1 AND status = $2',
    [vendorId, 'active']
  );

  for (const prod of allProducts.rows) {
    const newCollection = PRODUCT_TO_COLLECTION[prod.name];
    if (newCollection && newCollection !== prod.collection) {
      await pool.query('UPDATE products SET collection = $1 WHERE id = $2', [newCollection, prod.id]);
      collectionsUpdated++;
      console.log(`  ${prod.name}: "${prod.collection || '(none)'}" → "${newCollection}"`);
    } else if (!newCollection) {
      console.log(`  [UNMAPPED] ${prod.name} — keeping "${prod.collection || '(none)'}"`);
    }
  }
  console.log(`\n  Collections updated: ${collectionsUpdated}\n`);

  // ─── STEP 2: Fix Per-SKU Image Assignment ───────────────────────────────
  console.log('--- Step 2: Fixing per-SKU image assignment ---\n');
  let imagesFixed = 0;
  let productsFixed = 0;

  // Get all active products with their SKUs and images
  const productsWithImages = await pool.query(`
    SELECT p.id, p.name,
           (SELECT COUNT(DISTINCT ma.url) FROM media_assets ma
            JOIN skus s2 ON ma.sku_id = s2.id WHERE s2.product_id = p.id) as unique_urls,
           (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = $2
    ORDER BY p.name
  `, [vendorId, 'active']);

  for (const prod of productsWithImages.rows) {
    // Skip products with only 1 SKU or no images — nothing to reassign
    if (prod.sku_count <= 1 || prod.unique_urls === 0) continue;

    // Get all SKUs for this product with their color attribute
    const skuRows = await pool.query(`
      SELECT s.id, s.internal_sku, s.variant_name, s.variant_type,
             (SELECT value FROM sku_attributes WHERE sku_id = s.id
              AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color') LIMIT 1) as color
      FROM skus s WHERE s.product_id = $1
      ORDER BY s.internal_sku
    `, [prod.id]);

    // Get unique image URLs currently assigned to this product
    const imageRows = await pool.query(`
      SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      JOIN skus s ON ma.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY ma.sort_order
    `, [prod.id]);

    if (imageRows.rows.length === 0) continue;

    // Separate parent SKUs (multi-color) from child SKUs (single color)
    const parentSkus = skuRows.rows.filter(s => s.internal_sku.match(/^BLZ-R\d+$/) && !s.internal_sku.includes('-', 5));
    const childSkus = skuRows.rows.filter(s => s.internal_sku.match(/^BLZ-R\d+-[A-Z]{4}$/));

    // If no child SKUs (product not split into colors), skip image reassignment
    if (childSkus.length === 0) continue;

    // Analyze each image URL for color hints
    const imageColorMap = imageRows.rows.map(img => ({
      url: img.url,
      originalType: img.asset_type,
      sortOrder: img.sort_order,
      detectedColors: extractColorsFromUrl(img.url),
      isLaydown: isLaydownOrSwatch(img.url),
      isLifestyle: isLifestyle(img.url),
    }));

    // Images with no color hint are "generic" (apply to all SKUs)
    const genericImages = imageColorMap.filter(img => img.detectedColors.length === 0);
    const colorSpecificImages = imageColorMap.filter(img => img.detectedColors.length > 0);

    // Only proceed if we have color-specific images to assign
    if (colorSpecificImages.length === 0) continue;

    console.log(`  ${prod.name} (${childSkus.length} color SKUs, ${imageRows.rows.length} images):`);

    // Delete all existing media_assets for this product
    await pool.query(`
      DELETE FROM media_assets WHERE sku_id IN (
        SELECT id FROM skus WHERE product_id = $1
      )
    `, [prod.id]);

    // Assign images per-SKU
    for (const sku of skuRows.rows) {
      const skuColor = sku.color;
      if (!skuColor) continue; // Skip SKUs without color

      // Find images matching this SKU's color
      const matchingImages = colorSpecificImages.filter(img => {
        return img.detectedColors.some(dc => {
          const dcLower = dc.toLowerCase();
          const skuLower = skuColor.toLowerCase();
          // Exact match or substring match
          return dcLower === skuLower ||
                 skuLower.includes(dcLower) ||
                 dcLower.includes(skuLower);
        });
      });

      // This SKU's images = its color-specific images + generic images
      const skuImages = [...matchingImages, ...genericImages];

      if (skuImages.length === 0) {
        // Fallback: if no color match, give it all images (better than none)
        for (let i = 0; i < imageColorMap.length; i++) {
          const img = imageColorMap[i];
          const assetType = img.isLaydown ? 'primary' : (img.isLifestyle ? 'lifestyle' : 'alternate');
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, $2, $3, $4, $4, $5)
          `, [prod.id, sku.id, assetType, img.url, i]);
          imagesFixed++;
        }
        continue;
      }

      // Sort: laydown first (primary), then non-lifestyle, then lifestyle
      skuImages.sort((a, b) => {
        if (a.isLaydown && !b.isLaydown) return -1;
        if (!a.isLaydown && b.isLaydown) return 1;
        if (!a.isLifestyle && b.isLifestyle) return -1;
        if (a.isLifestyle && !b.isLifestyle) return 1;
        return a.sortOrder - b.sortOrder;
      });

      // Assign asset types based on position
      for (let i = 0; i < skuImages.length; i++) {
        const img = skuImages[i];
        let assetType;
        if (i === 0) {
          assetType = 'primary';
        } else if (img.isLifestyle) {
          assetType = 'lifestyle';
        } else {
          assetType = 'alternate';
        }

        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
        `, [prod.id, sku.id, assetType, img.url, i]);
        imagesFixed++;
      }

      const primaryImg = skuImages[0];
      console.log(`    ${sku.internal_sku} (${skuColor}): ${skuImages.length} images, primary=${primaryImg.isLaydown ? 'laydown' : 'product'}`);
    }

    productsFixed++;
  }
  console.log(`\n  Products fixed: ${productsFixed}, Images reassigned: ${imagesFixed}\n`);

  // ─── STEP 3: Fix Primary Image Selection (for non-split products) ───────
  console.log('--- Step 3: Fixing primary image selection for remaining products ---\n');
  let primariesFixed = 0;

  // For products that weren't split (single SKU or no child colors),
  // still ensure laydown/swatch is primary
  const remainingProducts = await pool.query(`
    SELECT DISTINCT p.id, p.name
    FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND p.status = $2
    AND p.id NOT IN (
      SELECT product_id FROM skus WHERE internal_sku ~ '^BLZ-R[0-9]+-[A-Z]{4}$'
    )
  `, [vendorId, 'active']);

  for (const prod of remainingProducts.rows) {
    const images = await pool.query(`
      SELECT DISTINCT ma.id, ma.url, ma.asset_type, ma.sort_order, ma.sku_id
      FROM media_assets ma
      JOIN skus s ON ma.sku_id = s.id
      WHERE s.product_id = $1
      ORDER BY ma.sort_order
    `, [prod.id]);

    if (images.rows.length === 0) continue;

    // Check if current primary is a lifestyle (bad)
    const currentPrimary = images.rows.find(r => r.asset_type === 'primary');
    if (!currentPrimary) continue;

    const isPrimaryLifestyle = isLifestyle(currentPrimary.url);
    if (!isPrimaryLifestyle) continue; // Already good

    // Find a better primary (laydown/swatch)
    const betterPrimary = images.rows.find(r => isLaydownOrSwatch(r.url) && r.id !== currentPrimary.id);
    if (!betterPrimary) continue;

    // Swap: use temp sort_order to avoid unique constraint violation
    // Constraint is on (product_id, sku_id, asset_type, sort_order)
    const tempSort = 999;
    // Step 1: move old primary to temp
    await pool.query(
      "UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2",
      [tempSort, currentPrimary.id]
    );
    // Step 2: set better as primary
    await pool.query(
      "UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1",
      [betterPrimary.id]
    );
    // Step 3: fix old primary sort_order to the slot vacated by betterPrimary
    await pool.query(
      "UPDATE media_assets SET sort_order = $1 WHERE id = $2",
      [betterPrimary.sort_order || 3, currentPrimary.id]
    );
    primariesFixed++;
    console.log(`  ${prod.name}: swapped primary (was lifestyle → now laydown)`);
  }
  console.log(`\n  Primaries fixed: ${primariesFixed}\n`);

  // ─── STEP 4: Attach Accessories ────────────────────────────────────────
  console.log('--- Step 4: Attaching accessories via sku_accessories ---\n');
  let accessoriesLinked = 0;

  // Clear existing Bellezza sku_accessories to avoid duplicates
  await pool.query(`
    DELETE FROM sku_accessories WHERE parent_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1
    ) OR accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1
    )
  `, [vendorId]);

  // 4a: Altea Jolly Trim → Altea tile SKUs (per-color matching)
  console.log('  Linking Altea Jolly Trim → Altea tiles...');
  accessoriesLinked += await linkPerColorAccessories(pool, vendorId,
    'Altea', 'Jolly Trim',  // accessory pattern
    'Altea', ['Square', 'Subway']  // parent patterns
  );

  // 4b: Limit Jolly Trim → Limit tile SKUs (per-color matching)
  console.log('  Linking Limit Jolly Trim → Limit tiles...');
  accessoriesLinked += await linkPerColorAccessories(pool, vendorId,
    'Limit', 'Jolly Trim',
    'Limit', ['Subway']
  );

  // 4c: Schluter Trim → All porcelain tile SKUs (generic, link to parent SKUs only)
  console.log('  Linking Schluter Trim → Porcelain tile products...');
  const schluterSkus = await pool.query(`
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'Schluter Trim'
  `, [vendorId]);

  // Get representative SKUs from porcelain tile products (parent or first child per product)
  const porcelainParents = await pool.query(`
    SELECT DISTINCT ON (p.id) s.id as sku_id, p.name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND c.name = 'Porcelain Tile' AND p.status = 'active'
    AND s.variant_type IS DISTINCT FROM 'accessory'
    AND p.name NOT IN ('Schluter Trim', 'MAPEI Grout Medium Grey')
    ORDER BY p.id, s.internal_sku
  `, [vendorId]);

  for (const parentRow of porcelainParents.rows) {
    for (let i = 0; i < schluterSkus.rows.length; i++) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
      `, [parentRow.sku_id, schluterSkus.rows[i].id, i]);
      accessoriesLinked++;
    }
  }
  console.log(`    Linked ${schluterSkus.rows.length} Schluter trims to ${porcelainParents.rows.length} products`);

  // 4d: MAPEI Grout → Lingot SKUs
  console.log('  Linking MAPEI Grout → Lingot tiles...');
  const groutSkus = await pool.query(`
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'MAPEI Grout Medium Grey'
  `, [vendorId]);

  const lingotSkus = await pool.query(`
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'Lingot' AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [vendorId]);

  for (const lingotSku of lingotSkus.rows) {
    for (let i = 0; i < groutSkus.rows.length; i++) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
      `, [lingotSku.id, groutSkus.rows[i].id, i]);
      accessoriesLinked++;
    }
  }
  console.log(`    Linked ${groutSkus.rows.length} grout SKU(s) to ${lingotSkus.rows.length} Lingot SKUs`);

  console.log(`\n  Total accessories linked: ${accessoriesLinked}\n`);

  // ─── SUMMARY ────────────────────────────────────────────────────────────
  console.log('=== SUMMARY ===');
  console.log(`  Collections updated: ${collectionsUpdated}`);
  console.log(`  Products w/ images fixed: ${productsFixed}`);
  console.log(`  Image rows reassigned: ${imagesFixed}`);
  console.log(`  Primaries swapped: ${primariesFixed}`);
  console.log(`  Accessories linked: ${accessoriesLinked}`);
  console.log('\nDone!');

  await pool.end();
}

/**
 * Link per-color accessories to matching parent tile SKUs
 */
async function linkPerColorAccessories(pool, vendorId, accessoryProductName, accessoryVariantPattern, parentProductName, parentVariantPatterns) {
  let linked = 0;

  // Get accessory SKUs (individual color ones, not the parent multi-color)
  const accessorySkus = await pool.query(`
    SELECT s.id, s.internal_sku, s.variant_name,
           (SELECT value FROM sku_attributes WHERE sku_id = s.id
            AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color') LIMIT 1) as color
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_name ILIKE $3
    AND s.internal_sku ~ '-[A-Z]{4}$'
  `, [vendorId, accessoryProductName, `%${accessoryVariantPattern}%`]);

  // Get parent tile SKUs (individual color ones)
  const parentSkus = await pool.query(`
    SELECT s.id, s.internal_sku, s.variant_name,
           (SELECT value FROM sku_attributes WHERE sku_id = s.id
            AND attribute_id = (SELECT id FROM attributes WHERE name = 'Color') LIMIT 1) as color
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_type IS DISTINCT FROM 'accessory'
    AND s.internal_sku ~ '-[A-Z]{4}$'
  `, [vendorId, parentProductName]);

  // Filter parent SKUs by variant patterns (e.g., "Square", "Subway")
  const filteredParents = parentSkus.rows.filter(p => {
    return parentVariantPatterns.some(pat =>
      (p.variant_name || '').toLowerCase().includes(pat.toLowerCase())
    );
  });

  // Match by color
  for (const parentSku of filteredParents) {
    const parentColor = (parentSku.color || '').toLowerCase();
    if (!parentColor) continue;

    const matchingAccessory = accessorySkus.rows.find(a => {
      const accColor = (a.color || '').toLowerCase();
      return accColor === parentColor;
    });

    if (matchingAccessory) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, 0)
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
      `, [parentSku.id, matchingAccessory.id]);
      linked++;
    }
  }

  // Also link multi-color parent SKUs to the generic (multi-color) accessory
  const genericAccessory = await pool.query(`
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_name ILIKE $3
    AND s.internal_sku !~ '-[A-Z]{4}$'
  `, [vendorId, accessoryProductName, `%${accessoryVariantPattern}%`]);

  const genericParents = parentSkus.rows.filter(p => {
    return !p.internal_sku.match(/-[A-Z]{4}$/) && parentVariantPatterns.some(pat =>
      (p.variant_name || '').toLowerCase().includes(pat.toLowerCase())
    );
  });

  if (genericAccessory.rows.length > 0) {
    for (const parent of genericParents) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, 0)
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
      `, [parent.id, genericAccessory.rows[0].id]);
      linked++;
    }
  }

  console.log(`    Linked ${linked} accessory-parent pairs`);
  return linked;
}

main().catch(err => { console.error(err); process.exit(1); });
