/**
 * Import Orion Q4-2025 dealer cost pricing from PDF catalog.
 * Transcribed from image-based PDF: ORION Q-4-2025.pdf
 *
 * Usage: node backend/scripts/import-orion-costs.mjs
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';

// ── PDF price list transcription ──
// Format: [name_pattern, size, cost, basis]
// basis: 'sf' = per sqft, 'pc' = per piece, 'sh' = per sheet
const PRICE_LIST = [
  // Page 2 - Porcelain tiles
  ['AETERNA', '24X48', 3.29, 'sf'],
  ['ALBANY', '24X24', 2.99, 'sf'],
  ['AMAZONA JADE', '24X48', 3.49, 'sf'],
  ['ARNO AZZURRO', '24X48', 3.49, 'sf'],
  ['ASPEN', '8X48', 2.99, 'sf'],
  ['AUGUSTO', '24X48', 3.49, 'sf'],
  ['AXE', '8X48', 2.69, 'sf'],
  ['AU DUSK', '8X48', 2.69, 'sf'],
  ['BLOND', '8X48', 2.69, 'sf'],
  ['BLUE FOREST', '24X48', 3.49, 'sf'],
  ['BOIS DE LILLE', '8X48', 2.69, 'sf'],
  ['BOSTON', '24X24', 2.99, 'sf'],
  ['BRACCIANO', '24X48', 3.79, 'sf'],
  ['CF LIGHT', '32X32', 3.49, 'sf'],
  ['COREU GRIS', '24X24', 2.99, 'sf'],
  ['CREMA ROMA', '24X48', 3.49, 'sf'],
  ['CROMATIC BLACK', '24X24', 2.99, 'sf'],
  ['CROMATIC BLANCO', '24X24', 2.99, 'sf'],
  ['DARK ROSE', '24X48', 3.49, 'sf'],
  ['EKALI NOIR', '24X48', 3.49, 'sf'],
  ['ELEGANCE WHITE', '24X48', 3.49, 'sf'],
  ['ESSENTIAL', '8X48', 2.69, 'sf'],

  // Page 3
  ['GARE WHITE', '24X48', 3.49, 'sf'],
  ['GERY', '8X48', 2.69, 'sf'],
  ['HEISINKI', '8X48', 2.69, 'sf'],
  ['HORTON WHITE', '24X48', 3.49, 'sf'],
  ['IKON AMBER', '8X48', 2.69, 'sf'],
  ['ILLUSION SNOW', '24X48', 3.49, 'sf'],
  ['JET ANTRACITA', '8X48', 2.69, 'sf'],
  ['JUNGLE BLANCO', '8X48', 2.69, 'sf'],
  ['KM BLANCO', '8X48', 2.69, 'sf'],
  ['KOMI NOCE', '8X48', 2.69, 'sf'],
  ['LA BLUE GRIGIO', '24X24', 2.99, 'sf'],
  ['LA BLUE NERO', '24X24', 2.99, 'sf'],
  ['LABRADORITE BLUE', '24X48', 3.79, 'sf'],
  ['LILAC PURPLE', '24X48', 3.79, 'sf'],
  ['LUX DANAE', '24X48', 3.79, 'sf'],
  ['MACAUBA AZUL', '24X48', 3.49, 'sf'],
  ['MARMETTE BIANCO', '24X24', 3.49, 'sf'],
  ['MARMETTE JEANS', '24X24', 3.49, 'sf'],
  ['MARMETTE MIX', '24X24', 3.49, 'sf'],
  ['MARVEL', '24X48', 3.79, 'sf'],
  ['MAZERO GOLD', '24X48', 3.49, 'sf'],
  ['MONTCLAIR BLANCO', '24X24', 2.99, 'sf'],
  ['MONTCLAIR IVORY', '24X24', 2.99, 'sf'],
  ['MONTCLAIR PERLA', '24X24', 2.99, 'sf'],
  ['MUKALI', '8X48', 2.69, 'sf'],
  ['NEOWOOD', '8X48', 2.69, 'sf'],

  // Page 4
  ['OLYMPIA WHITE', '24X48', 3.49, 'sf'],
  ['ONI CORAL', '24X48', 3.79, 'sf'],
  ['ONI PEARL', '24X48', 3.79, 'sf'],
  ['ONI WHITE', '24X48', 3.79, 'sf'],
  ['PAINT BLUE', '24X48', 3.49, 'sf'],
  ['PAINT GRAY', '24X48', 3.49, 'sf'],
  ['PAINT ROSE', '24X48', 3.49, 'sf'],
  ['PAINT SALVIA', '24X48', 3.49, 'sf'],
  ['PAINT WHITE', '24X48', 3.49, 'sf'],
  ['PALMA', '24X48', 3.49, 'sf'],
  ['PAMESA CREMA MARFIL', '24X48', 3.99, 'sf'],
  ['PAMESA CREMA MARFIL', '48X48', 4.49, 'sf'],
  ['PISA GOLD', '24X48', 3.49, 'sf'],
  ['ROMA', '24X48', 3.49, 'sf'],
  ['SCARLET BLACK', '24X48', 3.49, 'sf'],
  ['SCARLET BLLE', '24X48', 3.49, 'sf'],
  ['SCARLET WHITE', '24X48', 3.49, 'sf'],
  ['SEGESTA IVORY', '24X48', 3.49, 'sf'],
  ['SEQUOIA MAXI', '9X48', 3.49, 'sf'],
  ['SERENE', '24X48', 3.79, 'sf'],
  ['SILKE BLANCO', '24X48', 3.49, 'sf'],
  ['SILKE GRIS', '24X48', 3.49, 'sf'],
  ['STAR EMERALD', '24X48', 3.79, 'sf'],
  ['STAR INDIGO', '24X48', 3.79, 'sf'],
  ['STAR PURPLE', '24X48', 3.79, 'sf'],
  ['SYBIL SILVER', '24X48', 3.49, 'sf'],

  // Page 5
  ['STUDIO', '6X9', 3.79, 'sf'],
  ['SUPER WHITE IN', '12X24', 2.49, 'sf'],
  ['SUPER WHITE IN', '24X24', 2.49, 'sf'],
  ['SUPER WHITE', '24X48', 3.29, 'sf'],
  ['SUPER BLACK', '24X48', 3.79, 'sf'],
  ['SWEDEN', '8X48', 2.29, 'sf'],
  ['TAJ MAHAL', '24X48', 4.49, 'sf'],
  ['TARTAN', '24X24', 2.29, 'sf'],
  ['TERRANOVA', '8X18', 2.99, 'sf'],
  ['TERRANOVA', '16X16', 2.99, 'sf'],
  ['TERRANOVA', '16X24', 2.99, 'sf'],
  ['TIME', '8X45', 4.99, 'sf'],
  ['TOSCANA', '12X24', 3.29, 'sf'],
  ['TOSCANA', '24X48', 3.99, 'sf'],
  ['TOSCANA', '3X24', 10.00, 'pc'],
  ['TOSCANA', '2X2', 11.99, 'sh'],
  ['TOSCANA', '48X48', 4.49, 'sf'],
  ['TRAZZO', '24X24', 2.29, 'sf'],
  ['TUDOR', '6X36', 2.69, 'sf'],
  ['VIKEN', '24X48', 3.79, 'sf'],
  ['VERMONT MIX', '8X48', 3.19, 'sf'],
  ['VOSGES', '6X36', 2.69, 'sf'],
  ['WETWOOD', '7.2X47', 3.99, 'sf'],
  ['WOOD NOCE', '8X48', 3.49, 'sf'],
  ['WHITE M3600H', '12X24', 1.99, 'sf'],
  ['WHITE M3900H', '12X36', 1.99, 'sf'],
  ['WHITE M3900HY', '12X36', 2.39, 'sf'],
  ['WOODEN WILLOW', '8X48', null, 'sf'],  // price says $/SF - call for pricing

  // Page 5 - Trims
  // Skipping trims (quarter rounds, bullnose) - not typical SKUs

  // Page 6 - Countertop Slabs (per SF)
  ['ALPINE', null, 7.99, 'sf'],
  ['AURELIUS', null, 12.99, 'sf'],
  ['BIANCO SUPERIOR', null, 11.99, 'sf'],
  ['BLACK RAJ', null, 9.99, 'sf'],
  ['BLUE EAGLE', null, 13.99, 'sf'],
  ['BROWN PERSA', null, 9.99, 'sf'],
  ['CALACATTA', null, 9.99, 'sf'],
  ['CALACATTA BLACK', null, 13.99, 'sf'],
  ['CALACATTA DA VINCI', null, 11.99, 'sf'],
  ['CALACATTA GOLD', null, 11.99, 'sf'],
  ['CARRARA', null, 8.99, 'sf'],
  ['CRISTALLO', null, 13.99, 'sf'],
  ['DELICATTUS', null, 9.99, 'sf'],
  ['ETE ET SERENA', null, 11.99, 'sf'],
  ['FELINE', null, 11.99, 'sf'],
  ['FELINE CRYSTAL', null, 13.99, 'sf'],
  ['FROST CZ', null, 8.99, 'sf'],
  ['FUSION', null, 11.99, 'sf'],
  ['GABANA', null, 11.99, 'sf'],
  ['GOLD MACAUBAS', null, 13.99, 'sf'],
  ['GVX DESERT SILVER', null, 13.99, 'sf'],
  ['LUNAR', null, 11.99, 'sf'],
  ['MARMOREA CARRARA', null, 11.99, 'sf'],
  ['MARMOREA VERDE ALPI', null, 13.99, 'sf'],
  ['MATARAZZO', null, 11.99, 'sf'],
  ['MATIRA', null, 11.99, 'sf'],
  ['MATRIX', null, 9.99, 'sf'],
  ['MERIDIAN', null, 11.99, 'sf'],
  ['MOUNTAIN MIST', null, 11.99, 'sf'],
  ['MULTIFIOS BIDESE', null, 11.99, 'sf'],
  ['MULTIFIOS BRETON', null, 11.99, 'sf'],
  ['MULTIFIOS HEDEL', null, 11.99, 'sf'],
  ['NATURAL GRANITE', null, 9.99, 'sf'],
  ['NEBULATO AZUL', null, 13.99, 'sf'],
  ['NERO MARQUINIA', null, 11.99, 'sf'],
  ['NILO', null, 11.99, 'sf'],
  ['ONIC', null, 13.99, 'sf'],
  ['OPUS WHITE', null, 11.99, 'sf'],
  ['ORINOCO', null, 11.99, 'sf'],
  ['PEDRE', null, 11.99, 'sf'],
  ['PERLA SANTANA', null, 11.99, 'sf'],
  ['PLATINO', null, 9.99, 'sf'],
  ['QUARTZITO AZUL', null, 13.99, 'sf'],
  ['REVERSE', null, 9.99, 'sf'],
  ['ROSSO VERONA', null, 9.99, 'sf'],
  ['RUBY FUSION', null, 11.99, 'sf'],
  ['SIBERIA', null, 11.99, 'sf'],
  ['SUPER WHITE CALACATTA', null, 11.99, 'sf'],
  ['TAJ MAHAL SLAB', null, 11.99, 'sf'],  // slab version, different from tile
  ['TEMPEST BLUE', null, 13.99, 'sf'],
  ['TITANIUM', null, 9.99, 'sf'],
  ['VANCOUVER', null, 11.99, 'sf'],
  ['WATERFALL', null, 11.99, 'sf'],
  ['WHITE PARADISE', null, 11.99, 'sf'],

  // Page 4 continued - Vinyl / SPC
  ['DALLAS', null, 2.29, 'sf'],
  ['HOUSTON', null, 2.29, 'sf'],
  ['IVORY', null, 2.29, 'sf'],
  ['7A101', null, 2.29, 'sf'],
  ['JTF962861', null, 2.29, 'sf'],
  ['JTF962901', null, 2.29, 'sf'],
  ['JTF98007', null, 2.29, 'sf'],
  ['RIGID CORE', null, 2.29, 'sf'],

  // Page 3 continued - Natural Terrazzo
  ['NATURAL TERRAZZO', '16X16', 5.99, 'sf'],

  // Page 5 - TMG / wood look
  ['TMG', '8X48', 2.69, 'sf'],

  // Additional patterns for matching variants
  ['ASTRO', '24X48', 3.49, 'sf'],  // Astro Avorio, Cotto, Verde
  ['PERLA SANTANA', null, 11.99, 'sf'],  // accent in DB name
  ['SPARK BLANCO', null, 2.49, 'sf'],  // 35x35 glossy white - Super White IN family
  ['SEQUOIA MAXI MID', null, 3.49, 'sf'],  // mid blue variant
  ['TAJ MAHAL', null, 4.49, 'sf'],  // matte slab variant (no size in name)
  ['PAINT ROSE', '24X48', 3.49, 'sf'],  // accent é variant

  // L-series countertop slabs (from page 7-8)
  ['L01', null, 11.99, 'sf'],
  ['L02', null, 11.99, 'sf'],
  ['L03', null, 11.99, 'sf'],
  ['L03M', null, 11.99, 'sf'],
  ['L04', null, 11.99, 'sf'],
  ['L05', null, 11.99, 'sf'],
  ['L06', null, 11.99, 'sf'],
  ['L07', null, 11.99, 'sf'],
  ['L08', null, 11.99, 'sf'],
];

/**
 * Normalize a name for fuzzy matching:
 * lowercase, remove punctuation, collapse whitespace
 */
function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[""''|()\/\\,\-–—.×&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a product name matches a price list pattern.
 * The pattern must appear as a prefix/substring of the product name.
 */
function matchesPattern(productName, pattern) {
  const normName = normalize(productName);
  const normPattern = normalize(pattern);

  // Exact prefix match
  if (normName.startsWith(normPattern)) return true;

  // Check if pattern words all appear in sequence in the name
  const patternWords = normPattern.split(' ');
  const nameWords = normName.split(' ');

  let pi = 0;
  for (let ni = 0; ni < nameWords.length && pi < patternWords.length; ni++) {
    if (nameWords[ni] === patternWords[pi] || nameWords[ni].startsWith(patternWords[pi])) {
      pi++;
    }
  }
  return pi === patternWords.length;
}

async function main() {
  // Fetch all Orion SKUs with their current pricing
  const { rows: skus } = await pool.query(`
    SELECT s.id as sku_id, s.internal_sku, p.name as product_name, p.collection,
      pr.cost, pr.retail_price, pr.price_basis
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [VENDOR_ID]);

  console.log(`Found ${skus.length} Orion SKUs\n`);

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  const unmatched = [];

  for (const sku of skus) {
    // Try to find a matching price list entry
    let bestMatch = null;
    let bestScore = 0;

    const candidates = [];
    for (const [pattern, size, cost, basis] of PRICE_LIST) {
      if (cost === null) continue; // skip call-for-pricing items

      if (matchesPattern(sku.product_name, pattern)) {
        let score = pattern.length; // longer pattern = more specific = better
        let sizeMatched = false;
        if (size) {
          const normSize = size.toLowerCase().replace('x', 'x');
          const normName = normalize(sku.product_name);
          const normSku = normalize(sku.internal_sku);
          if (normName.includes(normSize) || normSku.includes(normSize)) {
            score += 100; // strong size match bonus
            sizeMatched = true;
          }
        }
        candidates.push({ pattern, size, cost, basis, score, sizeMatched });
      }
    }

    // If we have size-matched candidates, only consider those
    // Otherwise, accept the best pattern-length match
    const sizeMatched = candidates.filter(c => c.sizeMatched);
    const pool2 = sizeMatched.length > 0 ? sizeMatched : candidates;
    for (const c of pool2) {
      if (c.score > bestScore) {
        bestScore = c.score;
        bestMatch = c;
      }
    }
    // If no size-matched candidates but we have pattern matches, use the longest pattern
    if (!bestMatch && candidates.length > 0) {
      bestMatch = candidates.reduce((a, b) => a.pattern.length >= b.pattern.length ? a : b);
    }

    if (bestMatch) {
      matched++;
      const { cost } = bestMatch;

      if (sku.cost !== undefined && sku.cost !== null && parseFloat(sku.cost) > 0 && parseFloat(sku.cost) !== cost) {
        // Already has a real cost set - skip
        skipped++;
        continue;
      }

      // Upsert pricing with cost
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = $2
      `, [sku.sku_id, cost, sku.retail_price || 0, sku.price_basis || 'per_sqft']);

      updated++;
      console.log(`  ✓ ${sku.product_name} → $${cost}/sf  (matched: "${bestMatch.pattern}")`);
    } else {
      unmatched.push(sku.product_name);
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`Total SKUs:  ${skus.length}`);
  console.log(`Matched:     ${matched}`);
  console.log(`Updated:     ${updated}`);
  console.log(`Skipped:     ${skipped} (already had cost)`);
  console.log(`Unmatched:   ${unmatched.length}`);

  if (unmatched.length > 0) {
    console.log(`\n── Unmatched products ──`);
    for (const name of unmatched) {
      console.log(`  ✗ ${name}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
