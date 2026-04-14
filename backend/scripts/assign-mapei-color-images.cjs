/**
 * Assign per-SKU color-specific product images to Mapei Keracolor & Keracaulk SKUs.
 *
 * Uses Floor & Decor's public Amplience CDN for product photos that show
 * each bag/tube with the grout/caulk color visible in the background.
 *
 * For colors not available as Keracolor on F&D, falls back to Ultracolor Plus FA
 * or FlexColor CQ images (different bag but same color swatch visible).
 *
 * Run: docker exec -it flooring-api node scripts/assign-mapei-color-images.cjs
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const FD_CDN = 'https://i8.amplience.net/i/flooranddecor';

// ── F&D SKU Mappings per product line ────────────────────────────────

// Keracolor S (Sanded Grout) — F&D product images
const KERACOLOR_S_MAP = {
  'Eggshell (formerly White) 5UJ522011': '100035260',
  'White':        '100035260',
  'Alabaster':    '100035278',
  'Pewter':       '100035302',
  'Bahama Beige': '100035328',
  'Chamois':      '100035344',
  'Chocolate':    '100035377',
  'Gray':         '100035401',
  'Black':        '100035419',
  'Sahara Beige': '100035435',
  'Biscuit':      '100035476',
  'Bone':         '100035500',
  'Pearl Gray':   '100035542',
  'Silver':       '100035583',
  'Avalanche':    '100035666',
  'Ivory':        '100035682',
  'Mocha':        '100035724',
  'Charcoal':     '100035781',
  'Light Almond': '100035799',
  'Frost':        '100035864',
  'Cocoa':        '100035872',
  'Warm Gray':    '100035906',
  'Rain':         '100243617',
  'Cobblestone':  '100243633',
  'Driftwood':    '100242775',
  'Mint':         '100242742',
};

// Keracolor U (Unsanded Grout) — F&D product images
const KERACOLOR_U_MAP = {
  'Eggshell (formerly White) 5UJ522011': '100035971',
  'White':        '100035971',
  'Pewter':       '100036003',
  'Bahama Beige': '100036011',
  'Gray':         '100036052',
  'Black':        '100036060',
  'Sahara Beige': '100036078',
  'Biscuit':      '100036094',
  'Bone':         '100036128',
  'Pearl Gray':   '100036144',
  'Silver':       '100036169',
  'Navajo Brown': '100036185',
  'Avalanche':    '100036201',
  'Ivory':        '100036219',
  'Mocha':        '100036235',
  'Charcoal':     '100036268',
  'Light Almond': '100036276',
  'Frost':        '100036300',
  'Cocoa':        '100036318',
  'Warm Gray':    '100036326',
  'Mint':         '100242890',
  'Cobblestone':  '100242908',
  'Timberwolf':   '100242916',
  'Driftwood':    '100242924',
  'Iron':         '100242940',
};

// Keracaulk S (Sanded Caulk) — F&D product images
const KERACAULK_S_MAP = {
  'Eggshell (formerly White) 5UJ522011': '100034537',
  'White':        '100034537',
  'Alabaster':    '100034545',
  'Pewter':       '100034552',
  'Bahama Beige': '100034560',
  'Chamois':      '100034578',
  'Harvest':      '100034586',
  'Chocolate':    '100034594',
  'Gray':         '100034602',
  'Black':        '100034610',
  'Sahara Beige': '100034628',
  'Biscuit':      '100034644',
  'Bone':         '100034651',
  'Pearl Gray':   '100034677',
  'Silver':       '100034693',
  'Navajo Brown': '100034719',
  'Avalanche':    '100034735',
  'Ivory':        '100034743',
  'Mocha':        '100034768',
  'Pale Umber':   '100034776',
  'Charcoal':     '100034792',
  'Light Almond': '100034800',
  'Frost':        '100034834',
  'Cocoa':        '100034842',
  'Warm Gray':    '100034859',
  'Straw':        '100034867',
  'Rain':         '100242437',
  'Mint':         '100242445',
  'Cobblestone':  '100242452',
  'Timberwolf':   '100242460',
  'Walnut':       '100242486',
  'Iron':         '100242494',
};

// Keracaulk U (Unsanded Caulk) — F&D product images
const KERACAULK_U_MAP = {
  'Eggshell (formerly White) 5UJ522011': '100034891',
  'White':        '100034891',
  'Pewter':       '100034917',
  'Bahama Beige': '100034925',
  'Chamois':      '100034933',
  'Harvest':      '100034941',
  'Chocolate':    '100034958',
  'Gray':         '100034966',
  'Black':        '100034974',
  'Sahara Beige': '100034982',
  'Biscuit':      '100035005',
  'Bone':         '100035013',
  'Pearl Gray':   '100035039',
  'Silver':       '100035054',
  'Navajo Brown': '100035070',
  'Avalanche':    '100035096',
  'Ivory':        '100035104',
  'Mocha':        '100035120',
  'Pale Umber':   '100035138',
  'Charcoal':     '100035153',
  'Light Almond': '100035161',
  'Cocoa':        '100035203',
  'Warm Gray':    '100035211',
  'Straw':        '100035229',
  'Rain':         '100242585',
  'Mint':         '100242593',
  'Cobblestone':  '100242601',
  'Timberwolf':   '100242619',
  'Driftwood':    '100242627',
  'Iron':         '100242643',
};

// Fallback: Ultracolor Plus FA / FlexColor CQ images for colors not available in the specific product line
const ULTRACOLOR_FA_FALLBACK = {
  'Harvest':      '100221233',
  'Navajo Brown': '100221316',
  'Pale Umber':   '100221365',
  'Straw':        '100221381',
  'Timberwolf':   '100221464',
  'Iron':         '100221498',
  'Alabaster':    '100221191',  // Ultracolor Plus FA Alabaster
  'Chamois':      '100221209',  // Ultracolor Plus FA Chamois
  'Chocolate':    '100221225',  // Ultracolor Plus FA Chocolate
  'Rain':         '100221530',  // Ultracolor Plus FA Rain
  'Frost':        '100221563',  // Ultracolor Plus FA Frost
  'Driftwood':    '100221472',  // Ultracolor Plus FA Driftwood
  'Moonbeam':     '101055358',
  'Castle Wall':  '101055416',
  'Cavern Moss':  '101055424',
  'Deep Ocean':   '101055572',
  'Night Sky':    '101055580',
  'Armor':        '101055440',
  'Sea Salt':     '101055432',
  'Honeybutter':  '101055366',
  'Sandstorm':    '101055408',
  'Oatmeal':      '101055390',
  'Nutmeg':       '101055382',
  'Wicker':       '101055399',
  'Jet Black':    '100839901', // Ultracolor Plus Max
  'Pure White':   '100035260', // Use White/Eggshell Keracolor S as fallback
};

// Map product name patterns to their F&D SKU maps
const PRODUCT_MAP_LOOKUP = {
  'Keracolor S': KERACOLOR_S_MAP,
  'Keracolor U': KERACOLOR_U_MAP,
  'Keracaulk S': KERACAULK_S_MAP,
  'Keracaulk U': KERACAULK_U_MAP,
};

function getProductLineKey(productName) {
  if (/Keracolor\s+S/i.test(productName)) return 'Keracolor S';
  if (/Keracolor\s+U/i.test(productName)) return 'Keracolor U';
  if (/Keracaulk\s+S/i.test(productName)) return 'Keracaulk S';
  if (/Keracaulk\s+U/i.test(productName)) return 'Keracaulk U';
  return null;
}

function cleanVariantName(variantName) {
  // Strip trailing SKU codes like "23825", "6BU503805", "5UJ522011", etc.
  let name = variantName
    .replace(/\s+\d{4,}$/,  '')           // "Avalanche 23825" → "Avalanche"
    .replace(/\s+\d+[A-Z]{2,}\d+$/i, '')  // trailing alphanumeric codes
    .replace(/\s+6BU\w+$/i, '')            // "Avalanche 6BU503805"
    .replace(/\s+5U[A-Z]\d+$/i, '')        // "Eggshell 5UJ522011"
    .replace(/\s*\(formerly\s+\w+\)/i, '') // "Eggshell (formerly White)" → "Eggshell"
    .trim();
  // Normalize known aliases
  if (/^eggshell$/i.test(name)) name = 'White';
  return name;
}

function getFdSku(productLineKey, colorName) {
  const primaryMap = PRODUCT_MAP_LOOKUP[productLineKey];
  if (!primaryMap) return null;

  // Try direct match first
  if (primaryMap[colorName]) return primaryMap[colorName];

  // Try case-insensitive match
  const lowerColor = colorName.toLowerCase();
  for (const [key, val] of Object.entries(primaryMap)) {
    if (key.toLowerCase() === lowerColor) return val;
  }

  // Fallback to Ultracolor Plus FA
  if (ULTRACOLOR_FA_FALLBACK[colorName]) return ULTRACOLOR_FA_FALLBACK[colorName];
  for (const [key, val] of Object.entries(ULTRACOLOR_FA_FALLBACK)) {
    if (key.toLowerCase() === lowerColor) return val;
  }

  return null;
}

async function main() {
  try {
    // Load all Keracolor/Keracaulk SKUs across ALL vendors
    const { rows: skus } = await pool.query(`
      SELECT s.id AS sku_id, s.variant_name, p.name AS product_name, p.id AS product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.name ILIKE '%Keracolor%' OR p.name ILIKE '%Keracaulk%'
      ORDER BY p.name, s.variant_name
    `);

    console.log(`Found ${skus.length} Keracolor/Keracaulk SKUs to process`);

    let inserted = 0;
    let skipped = 0;
    let missing = 0;
    const missingColors = [];

    for (const sku of skus) {
      const lineKey = getProductLineKey(sku.product_name);
      if (!lineKey) {
        skipped++;
        continue;
      }

      const colorName = cleanVariantName(sku.variant_name);
      const fdSku = getFdSku(lineKey, colorName);

      if (!fdSku) {
        missing++;
        missingColors.push(`${lineKey}: ${colorName}`);
        continue;
      }

      const imageUrl = `${FD_CDN}/${fdSku}_1`;

      // Check if this SKU already has a primary image
      const existing = await pool.query(
        `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`,
        [sku.sku_id]
      );

      if (existing.rows.length > 0) {
        // Update existing primary image URL
        await pool.query(
          `UPDATE media_assets SET url = $1, original_url = $1
           WHERE sku_id = $2 AND asset_type = 'primary'`,
          [imageUrl, sku.sku_id]
        );
        inserted++;
      } else {
        // Insert new SKU-level primary image
        await pool.query(
          `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
           VALUES ($1, $2, 'primary', $3, $3, 0)`,
          [sku.product_id, sku.sku_id, imageUrl]
        );
        inserted++;
      }
    }

    console.log(`\nResults:`);
    console.log(`  Inserted/Updated: ${inserted}`);
    console.log(`  Skipped (no product line match): ${skipped}`);
    console.log(`  Missing (no F&D image found): ${missing}`);

    if (missingColors.length > 0) {
      const unique = [...new Set(missingColors)];
      console.log(`\nMissing colors (${unique.length}):`);
      unique.forEach(c => console.log(`  - ${c}`));
    }

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
