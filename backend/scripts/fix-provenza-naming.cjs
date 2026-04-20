/**
 * Fix Provenza product naming and structure.
 *
 * Problems:
 * - 832 import created one product per color (e.g., "Provenza - CAMEO-WHITE OAK")
 * - Should be one product per collection (e.g., "Provenza - Old World") with colors as SKU variants
 * - 1,540 orphan products with no SKUs
 * - Case duplicates ("Provenza - AFFINITY" vs "Provenza - Affinity")
 *
 * This script:
 * 1. Maps every color to its correct Provenza collection (from website scrape)
 * 2. Creates proper collection-based products
 * 3. Re-parents SKUs to the correct product
 * 4. Deactivates orphan products
 * 5. Fixes variant_name to clean title-cased color names
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440008';

// ── Color → Collection mapping (from provenzafloors.com scrape) ──

const COLLECTION_COLORS = {
  // Hardwood
  'Affinity': ['Contour', 'Delight', 'Intrigue', 'Journey', 'Liberation', 'Mellow', 'Silhouette', 'Acclaim', 'Celebration', 'Engage', 'Serenity', 'Legacy', 'Glam', 'Grandeur', 'Charmed', 'Cameo', 'Appeal', 'Contour'],
  'African Plains': ['Raffia', 'Sahara Sun', 'Black River', 'Serengeti'],
  'Antico': ['Auburn', 'Chamboard', 'Heritage', 'Caribou', 'Relic', 'Clay'],
  'Cadeau': ['Aria', 'Cadence', 'Chapelle', 'Dolce', 'Ferro', 'Largo', 'Noir', 'Shimmer', 'Sonata', 'Verdun'],
  'Grand Pompeii': ['Apollo', 'Stabiane', 'Regina', 'Loreto', 'Nolana', 'Aleria', 'Baggio', 'Marcellina', 'Pantera', 'Sorentina'],
  'Herringbone Reserve': ['Autumn Wheat', 'Stone Grey', 'Dovetail'],
  'Lugano': ['Bella', 'Forma', 'Oro', 'Chiara', 'Felice', 'Genre'],
  'Mateus': ['Adora', 'Chateau', 'Enzo', 'Lido', 'Luxor', 'Maxime', 'Prado', 'Remy', 'Savoy', 'Trevi'],
  'Modern Rustic': ['Moonlit Pearl', 'Silver Lining', 'Oyster White'],
  'New York Loft': ['Canal Street', 'Park Place', 'Pier 55', 'Penn Station', 'West End', 'Carnegie Hall', 'Ferry Point', 'Rock Island', 'Music Hall', 'Marquee', 'Grand Central', 'Midtown', 'Saratoga'],
  'Old World': ['Cocoa Powder', 'Toasted Sesame', 'Mount Bailey', 'Gray Rocks', 'Mink', 'Pearl Grey', 'Desert Haze', 'Fossil Stone', 'Warm Sand', 'Tortoise Shell', 'French Revival', 'Haute Pepper'],
  'Opia': ['Brulee', 'Coterie', 'Curio', 'Destiny', 'Echo', 'Fontaine', 'Galerie', 'Maestro', 'Portico', 'Silo'],
  'Palais Royale': ['Amiens', 'Orleans', 'Riviera', 'Toulouse', 'Versailles', 'Martinique', 'Provence'],
  'Pompeii': ['Vesuvius', 'Salina', 'Lipari', 'Messina', 'Porta', 'Sabatini', 'Amiata', 'Dogana', 'Fortezza', 'Greco', 'Terra'],
  'Richmond': ['Stone Bridge', 'Flint Hill', 'Merrimac'],
  'Studio Moderno': ['Fellini', 'Cavalli', 'Diamonte', 'Rondo', 'Symphonie', 'Classique', 'Jolie'],
  'Tresor': ['Amour', 'Classique', 'Diamonte', 'Jolie', 'Lyon', 'Symphonie', 'Orsay', 'Rondo', 'Blanche', 'Rivoli'],
  'Vitali': ['Corsica', 'Genova', 'Milano', 'Napoli', 'Rocca', 'Arezzo', 'Emilia', 'Fabio', 'Galo', 'Lucca'],
  'Vitali Elite': ['Alba', 'Bronte', 'Carrara', 'Cori', 'Modena', 'Paterno', 'Sandrio', 'Trento'],
  'Volterra': ['Grotto', 'Pisa', 'Antica', 'Valori', 'Avellino', 'Lombardy', 'Mara', 'Novara', 'Ravina', 'Savona', 'Continental'],
  'Dutch Masters': ['Bosch', 'Cleve', 'Escher', 'Gaspar', 'Hals', 'Klee', 'Leyster', 'Mondrian', 'Steen', 'Vermeer'],
  'Lighthouse Cove': ['Ivory White', 'Black Pearl', 'Frosty Taupe', 'Ruby Red'],
  'Herringbone Custom': [],
  // Waterproof LVP
  'Concorde Oak': ['Brushed Pearl', 'Cool Classic', 'French Revival', 'London Fog', 'Loyal Friend', 'Mystic Moon', 'Royal Crest', 'Smoked Amber', 'Warm Tribute', 'Willow Wisp', 'Coco Classic', 'Grey Feather'],
  'First Impressions': ['High Style', 'One N Only', 'Pop Art', 'Cool Comfort', 'Real Deal', 'Cozy Cottage', 'Best Choice'],
  'Moda Living': ['At Ease', 'First Crush', 'Jet Set', 'Fly Away', 'True Story', 'Soul Mate', 'Soft Whisper', 'Finally Mine', 'Hang Ten', 'Sweet Talker', 'Free Spirit', 'Good Life', 'Happy Place', 'Last Chance', 'Next Level', 'Wild Thing'],
  'Moda Living Elite': ['Bravo', 'Diva', 'Foxy', 'Inspire', 'Vogue', 'Luxe', 'Jewel', 'Oasis', 'Soulful', 'Gala', 'Indie', 'Showpiece'],
  'New Wave': ['Bashful Beige', 'Daring Doe', 'Great Escape', 'Lunar Glow', 'Modern Mink', 'Nest Egg', 'Night Owl', 'Playful Pony', 'Rare Earth', 'Timber Wolf', 'Barely Beige', 'Brown Sugar', 'Delight'],
  'Stonescape': ['Ancient Earth', 'Angel Trail', 'Desert View', 'Formation Grey', 'Lava Dome', 'Mountain Mist', 'Navajo Bridge', 'Cape Royale', 'Cliff Hanger', 'Eagle Dancer', 'Happy Trails', 'Jackpot', 'Magic Hour', 'Marble Canyon', 'Moon Dancer', 'Ridge Point', 'Roaring Springs', 'Rockface', 'Shooting Star', 'Hourglass'],
  'Uptown Chic': ['Big Easy', 'Catwalk', 'Class Act', 'Double Dare', 'Jazz Singer', 'Naturally Yours', 'Posh Beige', 'Sassy Grey', 'Rock N Roll', 'Bold Ambition', 'Be Mine', 'Better Times', 'Born Ready', 'Spring Fever', 'Summer Wind', 'Rise N Shine', 'Smash Hit', 'Just Lucky', 'Star Struck', 'Starlit Sea', 'Sundance', 'Wild Applause', 'Road Trip', 'Just Chill', 'Midas Touch', 'Love Birds', 'Endless Summer', 'Sandy Cliff', 'Diamond Sky', 'Simply Silver', 'Rule Breaker', 'Cover Story', 'Pitch Perfect', 'Grand Tour', 'Joy Ride', 'Butter Cup', 'Moderne Icon', 'Grey Rocks', 'Oak Ram', 'Breathless', 'Cloud Nine', 'Foxy', 'Gala', 'After Party', 'The Natural', 'True North', 'Warm Tribute', 'Sassy Grey'],
  // Laminate
  'Modessa': ['Showtime', 'So Chic', 'Cover Story', 'High Life', 'Game On', 'Grandstand', 'Heartbreaker', 'Starling', 'Knockout', 'Morning Light', 'Parfait'],
  // Wall
  'Wall Chic': [],
};

// Category mapping for collections
const COLLECTION_CATEGORY = {
  'Affinity': 'hardwood', 'African Plains': 'hardwood', 'Antico': 'hardwood',
  'Cadeau': 'hardwood', 'Grand Pompeii': 'hardwood', 'Herringbone Reserve': 'hardwood',
  'Lugano': 'hardwood', 'Mateus': 'hardwood', 'Modern Rustic': 'hardwood',
  'New York Loft': 'hardwood', 'Old World': 'hardwood', 'Opia': 'hardwood',
  'Palais Royale': 'hardwood', 'Pompeii': 'hardwood', 'Richmond': 'hardwood',
  'Studio Moderno': 'hardwood', 'Tresor': 'hardwood', 'Vitali': 'hardwood',
  'Vitali Elite': 'hardwood', 'Volterra': 'hardwood', 'Dutch Masters': 'hardwood',
  'Lighthouse Cove': 'hardwood', 'Herringbone Custom': 'hardwood',
  'Concorde Oak': 'lvp', 'First Impressions': 'lvp', 'Moda Living': 'lvp',
  'Moda Living Elite': 'lvp', 'New Wave': 'lvp', 'Stonescape': 'lvp',
  'Uptown Chic': 'lvp', 'Modessa': 'laminate', 'Wall Chic': 'wall',
};

// Build reverse map: normalized color → collection
const COLOR_TO_COLLECTION = new Map();
for (const [collection, colors] of Object.entries(COLLECTION_COLORS)) {
  for (const color of colors) {
    const key = color.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!COLOR_TO_COLLECTION.has(key)) {
      COLOR_TO_COLLECTION.set(key, collection);
    }
  }
}

// Species suffixes to strip from color names
const SPECIES_RE = /[-\s]+(white oak|european oak|siberian oak|oak|maple|hevea|acacia|w\.?o\.?)$/i;
// Size/dimension suffixes to strip
const SIZE_RE = /\s+\d+(?:[\/\.]\d+)?["']?(?:\s*[xX×]\s*\d+(?:[\/\.]\d+)?["']?)*\s*$/;
// Collection suffixes
const COLL_SUFFIX_RE = /\s+(collection|coll\.?|spc|wpf|lvp|maxcore|coll)\s*\.?\s*$/i;
// Dimension prefix like "22X30 "
const DIM_PREFIX_RE = /^\d+[xX×]\d+\s+/;

/**
 * Normalize a color/product name to look up in the color map.
 */
function normalizeForLookup(name) {
  if (!name) return '';
  let n = name.trim();
  // Strip species suffix
  n = n.replace(SPECIES_RE, '');
  // Strip size suffix
  n = n.replace(SIZE_RE, '');
  // Normalize
  n = n.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return n;
}

/**
 * Title-case a string. "AUTUMN GREY" → "Autumn Grey"
 */
function titleCase(str) {
  if (!str) return '';
  const s = str.trim();
  if (s !== s.toUpperCase() || s.length <= 2) return s;
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Try to determine the correct Provenza collection for a product/SKU.
 */
function findCollection(variantName, productName, currentCollection) {
  // Try variant name first (most reliable — it's the color)
  if (variantName) {
    const key = normalizeForLookup(variantName);
    if (COLOR_TO_COLLECTION.has(key)) return COLOR_TO_COLLECTION.get(key);
  }

  // Try product name
  if (productName) {
    const key = normalizeForLookup(productName);
    if (COLOR_TO_COLLECTION.has(key)) return COLOR_TO_COLLECTION.get(key);
  }

  // Try extracting from existing collection field
  // e.g., "Provenza - AFFINITY" → "Affinity"
  if (currentCollection) {
    let collName = currentCollection.replace(/^Provenza\s*[-–—]\s*/i, '').trim();
    // Strip known suffixes
    collName = collName.replace(COLL_SUFFIX_RE, '').trim();
    collName = collName.replace(SIZE_RE, '').trim();
    collName = collName.replace(DIM_PREFIX_RE, '').trim();
    // Strip species
    collName = collName.replace(SPECIES_RE, '').trim();

    // Check if this cleaned name IS a known collection
    const collUpper = collName.toUpperCase();
    for (const coll of Object.keys(COLLECTION_COLORS)) {
      if (coll.toUpperCase() === collUpper) return coll;
    }

    // Check if it's a color name
    const key = normalizeForLookup(collName);
    if (COLOR_TO_COLLECTION.has(key)) return COLOR_TO_COLLECTION.get(key);

    // Partial match — collection name might be truncated by DNav
    for (const coll of Object.keys(COLLECTION_COLORS)) {
      if (coll.toUpperCase().startsWith(collUpper) || collUpper.startsWith(coll.toUpperCase())) {
        return coll;
      }
    }
  }

  return null;
}

/**
 * Determine the clean color name for a SKU.
 */
function cleanColorName(variantName, productName) {
  const raw = variantName || productName || '';
  let name = raw.trim();
  // Strip species suffix
  name = name.replace(SPECIES_RE, '');
  // Strip size suffix
  name = name.replace(SIZE_RE, '');
  name = name.trim();
  // Title case if ALL CAPS
  return titleCase(name);
}

// ── Accessory detection ──
const ACCESSORY_RE = /\b(stair\s*nose|reducer|t[-\s]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[-\s]?purpose|transition|scotia|shoe\s*mold|sq(?:uare)?\s*nose|cleaner|touch[-\s]?up|repair\s*kit|molding|moulding)/i;

function getAccessoryType(name) {
  const upper = (name || '').toUpperCase();
  if (/STAIR\s*NOSE/.test(upper)) return 'Stairnose';
  if (/REDUCER/.test(upper)) return 'Reducer';
  if (/T[-\s]?MOL[D]?|T[-\s]?MLDG/.test(upper)) return 'T-Molding';
  if (/QTR\s*RND|QUARTER\s*ROUND/.test(upper)) return 'Quarter Round';
  if (/END\s*CAP/.test(upper)) return 'End Cap';
  if (/SQR?\s*NOSE|SQUARE\s*NOSE/.test(upper)) return 'Square Nose';
  if (/BULLNOSE/.test(upper)) return 'Bullnose';
  if (/THRESHOLD/.test(upper)) return 'Threshold';
  if (/MULTI[-\s]?PURPOSE/.test(upper)) return 'Multi-Purpose';
  if (/FLUSH/.test(upper)) return 'Flush Mount';
  if (/CLEANER/.test(upper)) return 'Cleaner';
  return null;
}

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  if (DRY_RUN) console.log('=== DRY RUN — no changes will be made ===\n');

  try {
    // ── 1. Load all Provenza products + SKUs ──
    const result = await pool.query(`
      SELECT p.id as product_id, p.name as product_name, p.collection, p.status, p.is_active,
             s.id as sku_id, s.variant_name, s.internal_sku, s.vendor_sku, s.variant_type, s.sell_by
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
      ORDER BY p.collection, p.name
    `, [VENDOR_ID]);

    // Group by product
    const products = new Map();
    for (const row of result.rows) {
      if (!products.has(row.product_id)) {
        products.set(row.product_id, {
          id: row.product_id,
          name: row.product_name,
          collection: row.collection,
          status: row.status,
          is_active: row.is_active,
          skus: [],
        });
      }
      if (row.sku_id) {
        products.get(row.product_id).skus.push({
          id: row.sku_id,
          variant_name: row.variant_name,
          internal_sku: row.internal_sku,
          vendor_sku: row.vendor_sku,
          variant_type: row.variant_type,
          sell_by: row.sell_by,
        });
      }
    }

    console.log(`Loaded ${products.size} Provenza products (${result.rows.length} rows)`);

    const withSkus = [...products.values()].filter(p => p.skus.length > 0);
    const withoutSkus = [...products.values()].filter(p => p.skus.length === 0);
    console.log(`  ${withSkus.length} products with SKUs`);
    console.log(`  ${withoutSkus.length} orphan products (no SKUs)\n`);

    // ── 2. Resolve category IDs ──
    const hwCat = await pool.query("SELECT id FROM categories WHERE slug = 'engineered-hardwood'");
    const lvpCat = await pool.query("SELECT id FROM categories WHERE slug = 'lvp-plank'");
    const lamCat = await pool.query("SELECT id FROM categories WHERE slug = 'laminate'");
    const catMap = {
      'hardwood': hwCat.rows[0]?.id || null,
      'lvp': lvpCat.rows[0]?.id || null,
      'laminate': lamCat.rows[0]?.id || null,
    };

    // ── 3. Process each product with SKUs ──
    // Track target products we create/update
    const targetProducts = new Map(); // "collection|||name" → product_id
    let reparented = 0;
    let renamed = 0;
    let orphaned = 0;
    let unmapped = 0;
    const unmappedNames = [];

    for (const product of withSkus) {
      for (const sku of product.skus) {
        // Determine if this is an accessory
        const isAcc = sku.variant_type === 'accessory' ||
          ACCESSORY_RE.test(product.name) ||
          ACCESSORY_RE.test(sku.variant_name || '');

        // Find the correct collection for this SKU's color
        const color = cleanColorName(sku.variant_name, product.name);
        const collection = findCollection(sku.variant_name, product.name, product.collection);

        if (!collection) {
          unmapped++;
          if (unmappedNames.length < 30) {
            unmappedNames.push(`${sku.internal_sku}: variant="${sku.variant_name}" product="${product.name}" coll="${product.collection}"`);
          }
          continue;
        }

        const collectionDisplay = `Provenza - ${collection}`;
        const catType = COLLECTION_CATEGORY[collection] || 'hardwood';
        const categoryId = catMap[catType] || null;

        let targetName;
        let targetSellBy = sku.sell_by;
        let targetVariantType = sku.variant_type;

        if (isAcc) {
          const accType = getAccessoryType(product.name) || getAccessoryType(sku.variant_name) || 'Accessory';
          targetName = `${collection} ${accType}`;
          targetSellBy = 'unit';
          targetVariantType = 'accessory';
        } else {
          targetName = collection;
          targetSellBy = 'sqft';
          targetVariantType = null;
        }

        const targetKey = `${collectionDisplay}|||${targetName}`;

        // Create or find target product
        if (!targetProducts.has(targetKey)) {
          if (!DRY_RUN) {
            const res = await pool.query(`
              INSERT INTO products (vendor_id, name, collection, category_id, status, is_active,
                                    slug, updated_at)
              VALUES ($1, $2, $3, $4, 'active', true,
                      $5, NOW())
              ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
                status = 'active',
                is_active = true,
                category_id = COALESCE(EXCLUDED.category_id, products.category_id),
                updated_at = NOW()
              RETURNING id
            `, [
              VENDOR_ID, targetName, collectionDisplay, categoryId,
              slugify(collectionDisplay + ' ' + targetName),
            ]);
            targetProducts.set(targetKey, res.rows[0].id);
          } else {
            targetProducts.set(targetKey, `NEW:${targetKey}`);
          }
        }

        const targetProductId = targetProducts.get(targetKey);

        // Re-parent SKU if needed
        if (!DRY_RUN && targetProductId !== product.id) {
          await pool.query(`
            UPDATE skus SET product_id = $1, variant_name = $2, sell_by = $3,
                           variant_type = $4, status = 'active', updated_at = NOW()
            WHERE id = $5
          `, [targetProductId, color, targetSellBy, targetVariantType, sku.id]);
          reparented++;
        } else if (!DRY_RUN && targetProductId === product.id) {
          // Same product, just fix the variant name
          if (sku.variant_name !== color) {
            await pool.query(`
              UPDATE skus SET variant_name = $1, status = 'active', updated_at = NOW()
              WHERE id = $2
            `, [color, sku.id]);
            renamed++;
          }
        } else if (DRY_RUN) {
          if (product.collection !== collectionDisplay || product.name !== targetName) {
            reparented++;
          }
        }
      }
    }

    console.log(`\n=== SKU Processing ===`);
    console.log(`  Re-parented: ${reparented} SKUs`);
    console.log(`  Renamed: ${renamed} SKUs`);
    console.log(`  Unmapped: ${unmapped} SKUs (no collection found)`);
    if (unmappedNames.length > 0) {
      console.log(`  Sample unmapped:`);
      for (const n of unmappedNames.slice(0, 15)) console.log(`    ${n}`);
    }

    // ── 4. Deactivate orphan products ──
    // Products that now have 0 SKUs (either originally or after re-parenting)
    if (!DRY_RUN) {
      const orphanResult = await pool.query(`
        UPDATE products SET is_active = false, status = 'inactive', updated_at = NOW()
        WHERE vendor_id = $1
          AND collection LIKE 'Provenza%'
          AND id NOT IN (SELECT DISTINCT product_id FROM skus)
          AND is_active = true
        RETURNING id
      `, [VENDOR_ID]);
      orphaned = orphanResult.rowCount;
    } else {
      orphaned = withoutSkus.length;
    }

    console.log(`\n=== Cleanup ===`);
    console.log(`  Deactivated ${orphaned} orphan products`);
    console.log(`  Target collection products: ${targetProducts.size}`);

    // ── 5. Refresh search vectors for affected products ──
    if (!DRY_RUN) {
      for (const [, pid] of targetProducts) {
        if (typeof pid === 'string') continue; // dry run placeholder
        await pool.query('SELECT refresh_search_vectors($1)', [pid]).catch(() => {});
      }
    }

    // ── 6. Print final summary ──
    if (!DRY_RUN) {
      const finalCount = await pool.query(`
        SELECT COUNT(DISTINCT p.id) as products, COUNT(s.id) as skus
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND p.is_active = true
      `, [VENDOR_ID]);
      console.log(`\n=== Final State ===`);
      console.log(`  Active products: ${finalCount.rows[0].products}`);
      console.log(`  Active SKUs: ${finalCount.rows[0].skus}`);

      // Show sample of final collection grouping
      const sample = await pool.query(`
        SELECT p.collection, p.name, COUNT(s.id) as sku_count
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND p.is_active = true
        GROUP BY p.collection, p.name
        ORDER BY p.collection, p.name
        LIMIT 40
      `, [VENDOR_ID]);
      console.log(`\n=== Sample Products ===`);
      for (const r of sample.rows) {
        console.log(`  ${r.collection} / ${r.name} (${r.sku_count} SKUs)`);
      }
    }

  } finally {
    await pool.end();
  }
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
