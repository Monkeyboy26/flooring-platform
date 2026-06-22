/**
 * LDZ Flooring — Full Vendor Import
 *
 * Source: LDZ FLOORING PRICELIST 2026.pdf
 *         + ldzflooring.com (product images)
 *
 * Collections:
 *   SPC Vinyl 7mm: Rustic Retreat (7.2x48 + 9x60), Natural (9x60), Luxury (9x64)
 *   Light SPC 10mm: Classic Elegance A (9x60), Classic Elegance B (9x60)
 *   Laminate: Revolution 10mm (7.6x47.8), Earthline 12mm (9.2x60)
 *   Accessories: Wall Base, Mouldings, Stair Nose, Stair Tread, Underlayment
 *
 * Pricing: dealer cost from PDF, retail = cost x 2.0, MAP from PDF
 * Images: scraped from ldzflooring.com product pages at import time
 *
 * Usage: docker compose exec api node scripts/import-ldz.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ─── Category IDs ───
const CAT = {
  lvp:      '650e8400-e29b-41d4-a716-446655440031',
  laminate: '650e8400-e29b-41d4-a716-446655440090',
};

// ─── Attribute IDs ───
const ATTR = {
  color:    'd50e8400-e29b-41d4-a716-446655440001',
  size:     'd50e8400-e29b-41d4-a716-446655440004',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
  finish:   'd50e8400-e29b-41d4-a716-446655440003',
};

const MARKUP = 2.0;

// ─── Collection definitions from PDF ───
// Each size group: { size, sizeLabel, sfPerBox, pcsPerBox, boxesPerPallet, cost, map, colors: { colorName: vendorSku } }
const COLLECTIONS = [
  {
    collection: 'Rustic Retreat',
    material: 'SPC Vinyl',
    category: CAT.lvp,
    variantType: 'lvt',
    thickness: '7mm',
    wearLayer: '20 Mil',
    sizes: [
      {
        size: '7.2x48', sizeLabel: '7.2" x 48"', bevel: 'Painted',
        sfPerBox: 24.02, pcsPerBox: 10, boxesPerPallet: 50,
        cost: 1.89, map: 2.69,
        colors: {
          'Nebraska Oak':    'YYLDZ-2202B',
          'Conscription':    'YYLDZ-2204B',
          'Burnt Oak Brown': 'YYLDZ-2205B',
          'Massy Oak':       'YYLDZ-2207B',
          'Varnished Oak':   'YYLDZ-2208B',
          'Dragon Bines':    'YYLDZ-2210B',
          'Sala Jatoba':     'YYLDZ-2215B',
        },
      },
      {
        size: '9x60', sizeLabel: '9" x 60"', bevel: 'Painted',
        sfPerBox: 22.64, pcsPerBox: 6, boxesPerPallet: 56,
        cost: 1.99, map: 2.89,
        colors: {
          'Nebraska Oak':    'YYLDZ-2218',
          'Conscription':    'YYLDZ-2204C',
          'Burnt Oak Brown': 'YYLDZ-2219',
          'Massy Oak':       'YYLDZ-2207C',
          'Varnished Oak':   'YYLDZ-2221',
          'Dragon Bines':    'YYLDZ-2210C',
          'Sala Jatoba':     'YYLDZ-2215C',
          'Rainforest':      'YYLDZ-2222',
        },
      },
    ],
  },
  {
    collection: 'Natural',
    material: 'SPC Vinyl',
    category: CAT.lvp,
    variantType: 'lvt',
    thickness: '7mm',
    wearLayer: '22 Mil',
    sizes: [
      {
        size: '9x60', sizeLabel: '9" x 60"', bevel: 'Pressed',
        sfPerBox: 18.57, pcsPerBox: 5, boxesPerPallet: 56,
        cost: 1.99, map: 2.89,
        colors: {
          'Silver Lake': 'BBLLDZ-2451',
          'Mocha':       'BBLLDZ-2452',
          'Espresso':    'BBLLDZ-2453',
          'Hickory':     'BBLLDZ-2454',
          'Chestnut':    'BBLLDZ-2455',
          'Desert Hill': 'BBLLDZ-2456',
        },
      },
    ],
  },
  {
    collection: 'Luxury',
    material: 'SPC Vinyl',
    category: CAT.lvp,
    variantType: 'lvt',
    thickness: '7mm',
    wearLayer: '20 Mil',
    sizes: [
      {
        size: '9x64', sizeLabel: '9" x 64"', bevel: 'Pressed',
        sfPerBox: 23.68, pcsPerBox: 6, boxesPerPallet: 44,
        cost: 1.99, map: 2.89,
        colors: {
          'Cocoa Bean':   'TPLDZ-2470',
          'Amber Waves':  'TPLDZ-2471',
          'Buttery Ash':  'TPLDZ-2472',
          'Sunlit Pine':  'TPLDZ-2473',
          'Urban Slate':  'TPLDZ-2474',
          'Smoky Canvas': 'TPLDZ-2475',
        },
      },
    ],
  },
  {
    collection: 'Classic Elegance',
    material: 'Light SPC',
    category: CAT.lvp,
    variantType: 'lvt',
    thickness: '10mm',
    wearLayer: '20 Mil',
    sizes: [
      {
        size: '9x60', sizeLabel: '9" x 60"', bevel: 'Painted',
        sfPerBox: 22.44, pcsPerBox: 6, boxesPerPallet: 56,
        cost: 2.49, map: 3.59,
        colors: {
          'California Sequoia': 'LDZ-201-16',
          'White Oak':          'LDZ-201-17',
          'Maple':              'YYLDZ-2423-L',
          'Cherrywood':         'YYLDZ-2424-L',
          'Maillard':           'YYLDZ-2425-L',
          'Walnut':             'YYLDZ-2426-L',
        },
      },
      {
        size: '9x60', sizeLabel: '9" x 60"', bevel: 'Pressed',
        sfPerBox: 22.15, pcsPerBox: 6, boxesPerPallet: 60,
        cost: 2.59, map: 3.79,
        colors: {
          'Auburn Oak':     'YYLDZ-2560-L',
          'Caramel':        'YYLDZ-2561-L',
          'Sienna Oak':     'YYLDZ-2562-L',
          'White Sand':     'YYLDZ-2563-L',
          'Honey Glaze':    'YYLDZ-2564-L',
          'Moonlit Pewter': 'YYLDZ-2565-L',
        },
      },
    ],
  },
  {
    collection: 'Revolution',
    material: 'Laminate',
    category: CAT.laminate,
    variantType: null,
    thickness: '10mm',
    wearLayer: 'AC4',
    sizes: [
      {
        size: '7.6x47.8', sizeLabel: '7.6" x 47.8"', bevel: 'Painted',
        sfPerBox: 20.40, pcsPerBox: 8, boxesPerPallet: 55,
        cost: 1.59, map: 2.29,
        colors: {
          'Chocolate':   'TPLDZ-2510',
          'Sunwood':     'TPLDZ-2511',
          'Ivory Oak':   'TPLDZ-2512',
          'Frosted Ash': 'TPLDZ-2513',
          'Silver Mist': 'TPLDZ-2514',
          'Harvest Oak': 'TPLDZ-2515',
        },
      },
    ],
  },
  {
    collection: 'Earthline',
    material: 'Laminate',
    category: CAT.laminate,
    variantType: null,
    thickness: '12mm',
    wearLayer: 'AC4',
    sizes: [
      {
        size: '9.2x60', sizeLabel: '9.2" x 60"', bevel: 'Pressed',
        sfPerBox: 23.00, pcsPerBox: 6, boxesPerPallet: 52,
        cost: 1.89, map: 2.69,
        colors: {
          'Sandy Drift':     'TPLDZ-2580',
          'Honey Grove':     'TPLDZ-2581',
          'Charcoal Bark':   'TPLDZ-2582',
          'Gray Ash':        'TPLDZ-2583',
          'Weathered Taupe': 'TPLDZ-2584',
          'Blonde Birch':    'TPLDZ-2585',
        },
      },
    ],
  },
];

// ─── Product page URLs for image scraping ───
const PRODUCT_URLS = {
  // Rustic Retreat
  'Nebraska Oak':    'https://ldzflooring.com/product/ldz-201-02/',
  'Conscription':    'https://ldzflooring.com/product/conscription/',
  'Burnt Oak Brown': 'https://ldzflooring.com/product/burnt-oak-brown/',
  'Massy Oak':       'https://ldzflooring.com/product/massy-oak/',
  'Varnished Oak':   'https://ldzflooring.com/product/varnished-oak/',
  'Dragon Bines':    'https://ldzflooring.com/product/ldz-201-10/',
  'Sala Jatoba':     'https://ldzflooring.com/product/ldz-201-15/',
  'Rainforest':      'https://ldzflooring.com/product/ldz-201-13/',
  // Natural
  'Silver Lake':  'https://ldzflooring.com/product/silver-lake/',
  'Mocha':        'https://ldzflooring.com/product/mocha/',
  'Espresso':     'https://ldzflooring.com/product/espresso/',
  'Hickory':      'https://ldzflooring.com/product/hickory/',
  'Chestnut':     'https://ldzflooring.com/product/chestnut/',
  'Desert Hill':  'https://ldzflooring.com/product/desert-hill/',
  // Luxury
  'Cocoa Bean':   'https://ldzflooring.com/product/cocoa-bean-available-in-august-2024/',
  'Amber Waves':  'https://ldzflooring.com/product/amber-waves/',
  'Buttery Ash':  'https://ldzflooring.com/product/buttery-ash/',
  'Sunlit Pine':  'https://ldzflooring.com/product/sunlit-pine/',
  'Urban Slate':  'https://ldzflooring.com/product/urban-slate/',
  'Smoky Canvas': 'https://ldzflooring.com/product/smoky-canvas/',
  // Classic Elegance A
  'California Sequoia': 'https://ldzflooring.com/product/california-sequoia/',
  'White Oak':          'https://ldzflooring.com/product/white-oak/',
  'Maple':              'https://ldzflooring.com/product/maple-available-in-april-2024/',
  'Cherrywood':         'https://ldzflooring.com/product/cherrywood-available-in-april-2024/',
  'Maillard':           'https://ldzflooring.com/product/maillard-available-in-april-2024/',
  'Walnut':             'https://ldzflooring.com/product/walnut-available-in-april-2024/',
  // Classic Elegance B
  'Auburn Oak':     'https://ldzflooring.com/product/auburn-oak/',
  'Caramel':        'https://ldzflooring.com/product/caramel/',
  'Sienna Oak':     'https://ldzflooring.com/product/sienna-oak/',
  'White Sand':     'https://ldzflooring.com/product/white-sand/',
  'Honey Glaze':    'https://ldzflooring.com/product/honey-glaze/',
  'Moonlit Pewter': 'https://ldzflooring.com/product/moonlit-pewter/',
  // Revolution
  'Chocolate':   'https://ldzflooring.com/product/%e5%b7%a7%e5%85%8b%e5%8a%9b/',
  'Sunwood':     'https://ldzflooring.com/product/sunwood/',
  'Ivory Oak':   'https://ldzflooring.com/product/ivory-oak/',
  'Frosted Ash': 'https://ldzflooring.com/product/frosted-ash/',
  'Silver Mist': 'https://ldzflooring.com/product/silver-mist/',
  'Harvest Oak': 'https://ldzflooring.com/product/harvest-oak/',
  // Earthline
  'Sandy Drift':     'https://ldzflooring.com/product/sandy-drift/',
  'Honey Grove':     'https://ldzflooring.com/product/honey-grove/',
  'Charcoal Bark':   'https://ldzflooring.com/product/charcoal-bark/',
  'Gray Ash':        'https://ldzflooring.com/product/gray-ash-2/',
  'Weathered Taupe': 'https://ldzflooring.com/product/weathered-taupe/',
  'Blonde Birch':    'https://ldzflooring.com/product/blonde-brich/',
};

// ─── Accessory silhouette images (from ldzflooring.com) ───
const ACCESSORY_IMAGES = {
  'Stair Nose Round': 'https://ldzflooring.com/wp-content/uploads/2024/02/stairnose-round.png',
  'T-Molding':        'https://ldzflooring.com/wp-content/uploads/2024/02/T-moulding.png',
  'Reducer':          'https://ldzflooring.com/wp-content/uploads/2024/02/reducer.png',
  'End Cap':          'https://ldzflooring.com/wp-content/uploads/2024/02/end-cap.png',
  'Quarter Round':    'https://ldzflooring.com/wp-content/uploads/2024/02/quarter-round.png',
  'Underlayment':     'https://ldzflooring.com/wp-content/uploads/2024/02/6mil-PE-film.png',
};

// ─── Accessories from PDF ───
const ACCESSORIES = [
  // Wall base — sold per piece
  { name: 'MDF Wall Base', collection: 'Accessories', size: '4" x 5/8" x 96"', color: 'White', cost: 3.00, sku: 'WB-4-58' },
  { name: 'MDF Wall Base', collection: 'Accessories', size: '4" x 9/16" x 96"', color: 'White', cost: 3.00, sku: 'WB-4-916' },
  { name: 'MDF Wall Base', collection: 'Accessories', size: '3" x 1/2" x 96"', color: 'White', cost: 2.00, sku: 'WB-3-12' },
  { name: 'MDF Wall Base', collection: 'Accessories', size: '3" x 1/8" x 96"', color: 'White', cost: 2.00, sku: 'WB-3-18' },
  // Mouldings — sold per piece (8 ft), match floors
  { name: 'T-Molding',        collection: 'Mouldings', size: '8 ft', cost: 15.00, sku: 'TMOLD', image: ACCESSORY_IMAGES['T-Molding'] },
  { name: 'Reducer',           collection: 'Mouldings', size: '8 ft', cost: 15.00, sku: 'REDUCE', image: ACCESSORY_IMAGES['Reducer'] },
  { name: 'End Cap',           collection: 'Mouldings', size: '8 ft', cost: 15.00, sku: 'ENDCAP', image: ACCESSORY_IMAGES['End Cap'] },
  { name: 'Quarter Round',     collection: 'Mouldings', size: '8 ft', cost: 15.00, sku: 'QROUND', image: ACCESSORY_IMAGES['Quarter Round'] },
  { name: 'Stair Nose Round',  collection: 'Mouldings', size: '8 ft', cost: 25.00, sku: 'SNROUND', image: ACCESSORY_IMAGES['Stair Nose Round'] },
  { name: 'Stair Nose Square', collection: 'Mouldings', size: '8 ft', cost: 25.00, sku: 'SNSQUARE' },
  // Stair treads — sold per piece
  { name: 'Stair Tread Round',  collection: 'Stair Treads', size: '48" x 12" x 1.18"', cost: 40.00, sku: 'STROUND' },
  { name: 'Stair Tread Square', collection: 'Stair Treads', size: '48" x 12" x 1.18"', cost: 40.00, sku: 'STSQUARE' },
  // Underlayment — sold per roll
  { name: '6 Mil PE Film Underlayment',   collection: 'Underlayment', size: '500 sqft roll', cost: 40.00, sku: 'UL-6MIL', image: ACCESSORY_IMAGES['Underlayment'] },
  { name: '2mm EVA Foam Underlayment',    collection: 'Underlayment', size: '200 sqft roll', cost: 40.00, sku: 'UL-2EVA' },
  { name: '3mm EVA Foam Underlayment',    collection: 'Underlayment', size: '200 sqft roll', cost: 40.00, sku: 'UL-3EVA' },
];

// ─── Fetch product page and extract gallery image URLs ───
async function fetchProductImages(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Flooring-PIM/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`    WARN: ${res.status} fetching ${url}`);
      return [];
    }
    const html = await res.text();

    // Extract gallery image URLs from WooCommerce markup
    // Pattern: <a href="https://i0.wp.com/ldzflooring.com/wp-content/uploads/...">
    const images = [];
    const regex = /woocommerce-product-gallery__image[^>]*>[\s\S]*?<a[^>]+href="([^"]+wp-content\/uploads\/[^"]+)"/g;
    let match;
    while ((match = regex.exec(html))) {
      images.push(match[1]);
    }

    // Fallback: look for data-large_image attributes
    if (images.length === 0) {
      const altRegex = /data-large_image="([^"]+wp-content\/uploads\/[^"]+)"/g;
      while ((match = altRegex.exec(html))) {
        images.push(match[1]);
      }
    }

    // Strip CDN prefix and query params to get clean WordPress URLs
    return images.map(u => {
      let clean = u.replace(/^https?:\/\/i\d\.wp\.com\//, 'https://');
      clean = clean.split('?')[0];
      return clean;
    });
  } catch (err) {
    console.log(`    WARN: Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

// ─── Classify images as primary / alternate / lifestyle ───
// LDZ website pattern: product close-up always has "color" or "film" in filename.
// For older products without those keywords, fall back to the last gallery image.
function classifyImages(imageUrls) {
  if (imageUrls.length === 0) return [];

  // Find the close-up: image with "color" or "film" in filename (not "installation")
  let primaryIdx = imageUrls.findIndex(url => {
    const fn = url.split('/').pop().toLowerCase();
    return (/color|film/.test(fn) && !/installation|application/.test(fn));
  });

  // Fallback: last image that isn't an installation/application photo
  if (primaryIdx === -1) {
    for (let i = imageUrls.length - 1; i >= 0; i--) {
      const fn = imageUrls[i].split('/').pop().toLowerCase();
      if (!/installation|application/.test(fn)) { primaryIdx = i; break; }
    }
  }

  // Final fallback: last image
  if (primaryIdx === -1) primaryIdx = imageUrls.length - 1;

  const result = [];
  let sortOrder = 0;

  // Primary
  result.push({ url: imageUrls[primaryIdx], type: 'primary', sortOrder: sortOrder++ });

  // Remaining images
  for (let i = 0; i < imageUrls.length; i++) {
    if (i === primaryIdx) continue;
    const filename = imageUrls[i].split('/').pop().toLowerCase();
    const isLifestyle = /installation|application|scene|room/.test(filename);
    const type = isLifestyle ? 'lifestyle' : 'alternate';
    result.push({ url: imageUrls[i], type, sortOrder: sortOrder++ });
  }

  return result;
}

// ─── DB helpers ───
async function upsertAttr(client, skuId, attrId, value) {
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

async function upsertImage(client, productId, skuId, url, assetType, sortOrder) {
  if (skuId) {
    await client.query(`
      INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [productId, skuId, assetType, url, sortOrder]);
  } else {
    await client.query(`
      INSERT INTO media_assets (id, product_id, asset_type, url, original_url, sort_order)
      VALUES (gen_random_uuid(), $1, $2, $3, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [productId, assetType, url, sortOrder]);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main import function ───
async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Upsert vendor ──
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'LDZ Flooring', 'LDZ', 'https://ldzflooring.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: LDZ Flooring (${vendorId})\n`);

    let totalProducts = 0, totalSkus = 0, totalPricing = 0, totalPkg = 0;
    let totalAttrs = 0, totalImages = 0, totalAccessories = 0;

    // ── Collect unique colors across all collections (for image fetching) ──
    // A single color can appear in multiple size groups but is one product
    const productMap = new Map(); // colorName → { productId, collection, ... }

    for (const col of COLLECTIONS) {
      console.log(`\n── ${col.collection} (${col.material} ${col.thickness}) ──`);

      // Collect all unique color names in this collection
      const allColors = new Set();
      for (const sg of col.sizes) {
        for (const colorName of Object.keys(sg.colors)) {
          allColors.add(colorName);
        }
      }

      for (const colorName of allColors) {
        // Upsert product: one product per color per collection
        const prodRes = await client.query(`
          INSERT INTO products (id, vendor_id, name, collection, category_id, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
          ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
          DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
          RETURNING id
        `, [vendorId, colorName, col.collection, col.category]);
        const productId = prodRes.rows[0].id;
        totalProducts++;

        // Track product for later image fetching
        productMap.set(`${col.collection}|${colorName}`, { productId, colorName });

        // Insert SKUs for each size group that includes this color
        for (const sg of col.sizes) {
          const vendorSku = sg.colors[colorName];
          if (!vendorSku) continue;

          const internalSku = vendorSku.startsWith('LDZ') ? vendorSku : `LDZ-${vendorSku}`;
          const hasMultipleSizes = col.sizes.filter(s => s.colors[colorName]).length > 1;
          const variantName = hasMultipleSizes
            ? `${colorName} ${sg.size}`
            : colorName;

          const skuRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'box', $5, 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET product_id = EXCLUDED.product_id, variant_name = EXCLUDED.variant_name,
                         sell_by = EXCLUDED.sell_by, variant_type = EXCLUDED.variant_type, status = 'active'
            RETURNING id
          `, [productId, vendorSku, internalSku, variantName, col.variantType]);
          const skuId = skuRes.rows[0].id;
          totalSkus++;

          // Pricing
          const cost = sg.cost.toFixed(2);
          const retail = (sg.cost * MARKUP).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis, map_price)
            VALUES ($1, $2, $3, 'sqft', $4)
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost,
              retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis,
              map_price = EXCLUDED.map_price
          `, [skuId, cost, retail, sg.map.toFixed(2)]);
          totalPricing++;

          // Packaging
          const sfPallet = +(sg.sfPerBox * sg.boxesPerPallet).toFixed(2);
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = EXCLUDED.sqft_per_box,
              pieces_per_box = EXCLUDED.pieces_per_box,
              boxes_per_pallet = EXCLUDED.boxes_per_pallet,
              sqft_per_pallet = EXCLUDED.sqft_per_pallet
          `, [skuId, sg.sfPerBox, sg.pcsPerBox, sg.boxesPerPallet, sfPallet]);
          totalPkg++;

          // Attributes
          await upsertAttr(client, skuId, ATTR.color, colorName);
          await upsertAttr(client, skuId, ATTR.size, sg.size);
          await upsertAttr(client, skuId, ATTR.material, col.material);
          if (sg.bevel) {
            await upsertAttr(client, skuId, ATTR.finish, `${sg.bevel} Bevel`);
          }
          totalAttrs += 4;

          console.log(`  ${variantName} (${internalSku}) — $${cost}/sf, ${sg.sfPerBox} sf/box`);
        }
      }
    }

    // ── Fetch and save product images ──
    console.log('\n── Fetching product images from ldzflooring.com ──');
    for (const [key, { productId, colorName }] of productMap) {
      const pageUrl = PRODUCT_URLS[colorName];
      if (!pageUrl) {
        console.log(`  SKIP ${colorName}: no product page URL`);
        continue;
      }

      const imageUrls = await fetchProductImages(pageUrl);
      if (imageUrls.length === 0) {
        console.log(`  SKIP ${colorName}: no images found`);
        continue;
      }

      const classified = classifyImages(imageUrls);
      for (const img of classified) {
        await upsertImage(client, productId, null, img.url, img.type, img.sortOrder);
        totalImages++;
      }
      console.log(`  ${colorName}: ${classified.length} images saved`);

      await sleep(300); // Throttle requests
    }

    // ── Accessories ──
    console.log('\n── Accessories ──');
    for (const acc of ACCESSORIES) {
      // Each accessory is its own product + SKU
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET status = 'active'
        RETURNING id
      `, [vendorId, acc.name, acc.collection, CAT.lvp]);
      const productId = prodRes.rows[0].id;

      const variantName = acc.color
        ? `${acc.name} ${acc.size} ${acc.color}`
        : `${acc.name} ${acc.size}`;
      const internalSku = `LDZ-${acc.sku}`;

      const skuRes = await client.query(`
        INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
        ON CONFLICT ON CONSTRAINT skus_internal_sku_key
        DO UPDATE SET product_id = EXCLUDED.product_id, variant_name = EXCLUDED.variant_name,
                     sell_by = 'unit', variant_type = 'accessory', status = 'active'
        RETURNING id
      `, [productId, acc.sku, internalSku, variantName]);
      const skuId = skuRes.rows[0].id;

      // Pricing (per unit)
      const cost = acc.cost.toFixed(2);
      const retail = (acc.cost * MARKUP).toFixed(2);
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, 'unit')
        ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost,
          retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
      `, [skuId, cost, retail]);

      // Attributes
      if (acc.size) await upsertAttr(client, skuId, ATTR.size, acc.size);
      if (acc.color) await upsertAttr(client, skuId, ATTR.color, acc.color);

      // Accessory silhouette image
      if (acc.image) {
        await upsertImage(client, productId, null, acc.image, 'primary', 0);
        totalImages++;
      }

      totalAccessories++;
      console.log(`  ${variantName} (${internalSku}) — $${cost}/ea`);
    }

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Flooring SKUs: ${totalSkus}`);
    console.log(`Accessory SKUs: ${totalAccessories}`);
    console.log(`Total SKUs: ${totalSkus + totalAccessories}`);
    console.log(`Pricing records: ${totalPricing + totalAccessories}`);
    console.log(`Packaging records: ${totalPkg}`);
    console.log(`Attribute records: ${totalAttrs}`);
    console.log(`Image records: ${totalImages}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
