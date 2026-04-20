#!/usr/bin/env node
/**
 * fix-provenza-images.cjs
 *
 * Assigns correct per-SKU images to Provenza flooring products.
 * Uses the known Provenza image URL pattern to construct the right URL for each color.
 * Falls back to scraping provenzafloors.com if needed.
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

// Map of collection → category slug for Provenza image URLs
const COLLECTION_CATEGORIES = {
  'Affinity': 'hardwood/affinity',
  'African Plains': 'hardwood/africanplains',
  'Antico': 'hardwood/antico',
  'Cadeau': 'hardwood/cadeau',
  'Dutch Masters': 'hardwood/dutchmasters',
  'Grand Pompeii': 'hardwood/grandpompeii',
  'Herringbone Reserve': 'hardwood/herringbonereserve',
  'Herringbone Custom': 'hardwood/herringbonecustom',
  'Lighthouse Cove': 'hardwood/lighthousecove',
  'Lugano': 'hardwood/lugano',
  'Mateus': 'hardwood/mateus',
  'Modern Rustic': 'hardwood/modernrustic',
  'New York Loft': 'hardwood/newyorkloft',
  'Old World': 'hardwood/oldworld',
  'Opia': 'hardwood/opia',
  'Palais Royale': 'hardwood/palaisroyale',
  'Pompeii': 'hardwood/pompeii',
  'Richmond': 'hardwood/richmond',
  'Studio Moderno': 'hardwood/studiomoderno',
  'Tresor': 'hardwood/tresor',
  'Vitali': 'hardwood/vitali',
  'Vitali Elite': 'hardwood/vitalielite',
  'Volterra': 'hardwood/volterra',
  'Wall Chic': 'hardwood/wallchic',
  'Concorde Oak': 'lvp/concordeoak',
  'First Impressions': 'lvp/firstimpressions',
  'Moda Living': 'lvp/modaliving',
  'Moda Living Elite': 'lvp/modalivingelite',
  'New Wave': 'lvp/newwave',
  'Stonescape': 'lvp/stonescape',
  'Uptown Chic': 'lvp/uptownchic',
  'Modessa': 'laminate/modessa',
};

// Collection name slug format for URLs
const COLLECTION_URL_NAMES = {
  'Affinity': 'Affinity',
  'African Plains': 'AfricanPlains',
  'Antico': 'Antico',
  'Cadeau': 'Cadeau',
  'Dutch Masters': 'DutchMasters',
  'Grand Pompeii': 'GrandPompeii',
  'Herringbone Reserve': 'Herringbone',
  'Herringbone Custom': 'HerringboneCustom',
  'Lighthouse Cove': 'LighthouseCove',
  'Lugano': 'Lugano',
  'Mateus': 'Mateus',
  'Modern Rustic': 'ModernRustic',
  'New York Loft': 'NewYorkLoft',
  'Old World': 'OldWorld',
  'Opia': 'Opia',
  'Palais Royale': 'PalaisRoyale',
  'Pompeii': 'Pompeii',
  'Richmond': 'Richmond',
  'Studio Moderno': 'StudioModerno',
  'Tresor': 'Tresor',
  'Vitali': 'Vitali',
  'Vitali Elite': 'VitaliElite',
  'Volterra': 'Volterra',
  'Wall Chic': 'WallChic',
  'Concorde Oak': 'MaxCore-ConcordeOak',
  'First Impressions': 'MaxCore-FirstImpressions',
  'Moda Living': 'MaxCore-ModaLiving',
  'Moda Living Elite': 'MaxCore-ModaLivingElite',
  'New Wave': 'MaxCore-NewWave',
  'Stonescape': 'MaxCore-Stonescape',
  'Uptown Chic': 'MaxCore-UptownChic',
  'Modessa': 'MaxCore-Modessa',
};

// Build image URL from known existing images
// Pattern: https://storage.googleapis.com/provenza-web/images/products/{category}/detail/Provenza-{Collection}-{SKUCode}-{Color}.jpg
// But SKU codes vary — use color name matching against known URLs in our DB
async function main() {
  try {
    // Get all existing Provenza images to learn the URL pattern per collection
    const existingImages = await pool.query(`
      SELECT ma.url, s.variant_name, p.name as product_name, p.collection
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      LEFT JOIN skus s ON s.id = ma.sku_id
      WHERE p.collection LIKE 'Provenza%' AND ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
    `);

    // Build a map: collection → color → URL
    const knownUrls = new Map();
    for (const row of existingImages.rows) {
      const coll = row.product_name;
      if (!knownUrls.has(coll)) knownUrls.set(coll, new Map());
      if (row.variant_name) {
        knownUrls.get(coll).set(row.variant_name.toLowerCase(), row.url);
      }
    }

    console.log('Known image URLs by collection:');
    for (const [coll, colors] of knownUrls) {
      console.log(`  ${coll}: ${colors.size} colors`);
    }

    // Get all SKUs needing images
    const missing = await pool.query(`
      SELECT p.name as collection_name, p.collection, s.variant_name, s.id as sku_id, s.vendor_sku, p.id as product_id
      FROM products p
      JOIN skus s ON s.product_id = p.id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
      WHERE p.collection LIKE 'Provenza%' AND p.is_active = true
        AND p.name NOT LIKE '%Stairnose%' AND p.name NOT LIKE '%Reducer%'
        AND p.name NOT LIKE '%Quarter%' AND p.name NOT LIKE '%End Cap%'
        AND p.name NOT LIKE '%Flush%' AND p.name NOT LIKE '%Accessory%'
        AND p.name NOT LIKE '%T Mold%' AND p.name NOT LIKE '%Bullnose%'
        AND ma.id IS NULL
      ORDER BY p.name, s.variant_name
    `);

    console.log(`\n${missing.rows.length} SKUs missing images`);

    let fixed = 0;
    let failed = 0;

    for (const row of missing.rows) {
      const collName = row.collection_name;
      const color = row.variant_name || '';
      const cleanColor = color.replace(/\s*\d+.*$/, '').trim(); // Remove size suffixes like '9.05"X60" Wpf'
      const category = COLLECTION_CATEGORIES[collName];
      const urlCollName = COLLECTION_URL_NAMES[collName];

      if (!category || !urlCollName) {
        console.log(`  SKIP: No URL pattern for collection "${collName}" / color "${color}"`);
        failed++;
        continue;
      }

      // Try to construct URL from pattern
      // Remove spaces, hyphens from color for URL
      const colorSlug = cleanColor.replace(/[\s'-]+/g, '');

      // Check known URLs from same collection for pattern matching
      const collKnown = knownUrls.get(collName);
      let basePattern = null;

      if (collKnown && collKnown.size > 0) {
        // Extract the URL pattern from a known image in this collection
        const sampleUrl = collKnown.values().next().value;
        // e.g., https://storage.googleapis.com/provenza-web/images/products/hardwood/dutchmasters/detail/Provenza-DutchMasters-CDM001-Bosch-v2.jpg
        // We need to replace the color part and SKU code
        const match = sampleUrl.match(/^(.*detail\/Provenza-[^-]+-)[^-]+-.+$/);
        if (match) {
          basePattern = match[1];
        }
      }

      // Construct URL — try multiple patterns
      const baseUrl = `https://storage.googleapis.com/provenza-web/images/products/${category}/detail`;
      const urls = [
        `${baseUrl}/Provenza-${urlCollName}-${colorSlug}.jpg`,
        `${baseUrl}/Provenza-${urlCollName}-${colorSlug}-fs.jpg`,
      ];

      // Also try with vendor_sku code if available
      if (row.vendor_sku) {
        const skuCode = row.vendor_sku.replace(/^PRO/i, '');
        urls.unshift(`${baseUrl}/Provenza-${urlCollName}-PRO${skuCode}-${colorSlug}.jpg`);
        urls.unshift(`${baseUrl}/Provenza-${urlCollName}-${row.vendor_sku}-${colorSlug}.jpg`);
      }

      // Try each URL
      let foundUrl = null;
      for (const url of urls) {
        try {
          const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            foundUrl = url;
            break;
          }
        } catch { }
      }

      if (foundUrl) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'primary', $3, $3, 0)
          ON CONFLICT DO NOTHING
        `, [row.product_id, row.sku_id, foundUrl]);
        fixed++;
        console.log(`  OK: ${collName} / ${color} → ${foundUrl.split('/').pop()}`);
      } else {
        failed++;
        console.log(`  MISS: ${collName} / ${color} (tried ${urls.length} URLs)`);
      }
    }

    console.log(`\nDone: ${fixed} fixed, ${failed} failed`);

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
