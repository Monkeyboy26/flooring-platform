/**
 * Fix Orion product and collection names.
 *
 * Problems addressed:
 *   - Sizes in names (24"×48", 24x24, etc.)
 *   - Junk parenthetical text: ( / ), ( / / ), (), ( )
 *   - Marketing text after pipes: "| Waterproof & Durable..."
 *   - Inconsistent casing → Title Case
 *   - Leftover descriptors: "Rigid Core SPC Vinyl", "Finish Terrazzo", etc.
 *   - Collection = full name instead of just the collection
 *   - Pipe-separated suffixes
 *
 * Usage: node backend/scripts/fix-orion-names.mjs [--dry-run]
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
const DRY_RUN = process.argv.includes('--dry-run');

// ── Known collections (must be defined before casing overrides) ──

const KNOWN_COLLECTIONS = [
  'Aeterna', 'Albany', 'Alpine', 'Amazona', 'Arno', 'Aspen', 'Astro', 'Augusto',
  'Aurelius', 'Axe', 'AU',
  'Bianco Superior', 'Black Raj', 'Blond', 'Blue Eagle', 'Blue Forest',
  'Bois de Lille', 'Boston', 'Bracciano', 'Brown Persa',
  'CF', 'Calacatta', 'Carrara', 'Coreu', 'Crema Roma', 'Cristallo', 'Cromatic',
  'Dallas', 'Dark Rose', 'Delicattus',
  'ETE ET', 'Ekali', 'Elegance', 'Essential',
  'Feline', 'Frost', 'Fusion',
  'GVX', 'Gabana', 'Gare', 'Gery', 'Gold Macaubas',
  'Heisinki', 'Horton', 'Houston',
  'Ikon', 'Illusion', 'Ivory',
  'Jet', 'Jungle',
  'KM', 'Komi',
  'La Blue', 'Labradorite', 'Lilac', 'Living', 'Lunar', 'Lux Danae',
  'Macauba', 'Marmette', 'Marmorea', 'Marvel', 'Matarazzo', 'Matira',
  'Matrix', 'Mazero', 'Meridian', 'Montclair', 'Mountain Mist',
  'Mukali', 'Multifios',
  'Natural Granite', 'Natural Terrazzo', 'Nebulato', 'Neowood', 'Nero Marquinia', 'Nilo',
  'ONI', 'Olympia', 'Onic', 'Opus', 'Orinoco',
  'Paint', 'Palma', 'Pamesa', 'Pedre', 'Perla Santana', 'Pisa', 'Platino',
  'Quartzito',
  'Reverse', 'Rigid Core', 'Roma', 'Rosso Verona', 'Ruby Fusion',
  'Scarlet', 'Segesta', 'Sequoia Maxi', 'Serene', 'Siberia', 'Silke',
  'Spark', 'Star', 'Super White', 'Sybil',
  'Taj Mahal', 'Tempest', 'Titanium', 'Tmg', 'Toscana',
  'Vancouver', 'Viken',
  'Waterfall', 'Wetwood', 'White Paradise',
];

// ── Cleaning rules ──

/** Remove sizes like 24"×48", 24x24, 48"×48", 60x120, etc. */
function stripSize(s) {
  return s
    .replace(/\d+\.?\d*\s*[\u201C\u201D\u2033\u2032"″''"]?\s*[x×X]\s*\d+\.?\d*\s*[\u201C\u201D\u2033\u2032"″''"]?/g, '')
    .replace(/\d+\s*cm/gi, '');
}

/** Remove junk parenthetical text: (), ( ), ( / ), ( / / ), (24"×48"), etc. */
function stripParens(s) {
  return s.replace(/\([^)]*\)/g, '');
}

/** Remove pipe-separated marketing text */
function stripPipeText(s) {
  return s.replace(/\s*\|.*$/, '');
}

/** Remove common descriptors that shouldn't be in names */
function stripDescriptors(s) {
  return s
    .replace(/\bRigid\s*Core\s*SPC\s*Vinyl\b/gi, '')
    .replace(/\bSPC\s*Vinyl\s*Flooring\b/gi, '')
    .replace(/\bVinyl\s*Flooring\b/gi, '')
    .replace(/\bVinyl\b/gi, '')
    .replace(/\bPremium\s*Collection\b/gi, '')
    .replace(/\bPremium\b/gi, '')
    .replace(/\bFinish\s*Terrazzo\b/gi, '')
    .replace(/\bTerrazzo\s*look\b/gi, '')
    .replace(/\bSlab\s*Countertop\b/gi, '')
    .replace(/\bGlossy\s*White\b/gi, '')
    .replace(/\bPolished\b/gi, '')
    .replace(/\bMatte\b/gi, '')
    .replace(/\bItalian\b/gi, '')
    .replace(/\bRettificato\b/gi, '')
    .replace(/\bPorcelain\b/gi, '')
    .replace(/\bCeramic\b/gi, '')
    .replace(/\bWaterproof\b/gi, '')
    .replace(/\bDurable\b/gi, '')
    .replace(/\bWood\s*Effect\b/gi, '')
    .replace(/\bWood\s*Look\b/gi, '')
    .replace(/\bStone\s*effect\b/gi, '')
    .replace(/\bMarble\s*Look\b/gi, '')
    .replace(/\bOnyx\b/gi, '')
    .replace(/\bOnix\b/gi, '')
    .replace(/\bSuper\s*Polished\b/gi, '')
    .replace(/\bPul\b/gi, '')
    .replace(/\bTile\b/gi, '')
    .replace(/\bFlooring\b/gi, '')
    .replace(/\bORION\b/gi, '')
    .replace(/\bWall\b/gi, '')
    .replace(/\bFloor\b/gi, '')
    .replace(/\binch\b/gi, '')
    .replace(/\b\d+mm\b/gi, '')
    .replace(/\b\d+mil\b/gi, '')
    .replace(/\bWear\s*Layer\b/gi, '')
    .replace(/\bCollection\b/gi, '')
    .replace(/\bfor\s+(Any|Modern|Every)\s+\w+\b/gi, '')
    .replace(/\bESSENZE\s*LIGNEE\b/gi, '')
    .replace(/\bStoneware\b/gi, '')
    .replace(/\b\d{7,}\b/g, '')
    .replace(/\b\d+\s+\d+\b/g, '')
    .replace(/\b0\d\b/g, '');
}

/** Normalize to title case */
function titleCase(s) {
  const small = new Set(['de', 'du', 'da', 'di', 'le', 'la', 'les']);

  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      // Preserve fully-uppercase short codes like "CZ", "GVX", "SPC", "ET", "AU", "KM"
      if (word.length <= 3 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) return word;
      // Preserve alphanumeric model codes like "7A101", "JTF962861"
      if (/^[A-Z0-9]+$/i.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word)) return word.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Clean trailing punctuation, commas, dashes, stray quotes */
function cleanPunctuation(s) {
  return s
    .replace(/[\u201C\u201D\u2033\u2032"″]+/g, '')
    .replace(/,\s+/g, ' ')
    .replace(/[,;:\-–—]+\s*$/, '')
    .replace(/^\s*[,;:\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build casing overrides from known collections with uppercase codes */
const CASING_OVERRIDES = new Map();
for (const col of KNOWN_COLLECTIONS) {
  if (/^[A-Z]{2,3}$/.test(col) || /\b[A-Z]{2,3}\b/.test(col)) {
    CASING_OVERRIDES.set(col.toLowerCase(), col);
  }
}

function applyCollectionCasing(s) {
  for (const [lower, correct] of CASING_OVERRIDES) {
    const re = new RegExp(`\\b${lower.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    s = s.replace(re, correct);
  }
  return s;
}

/** Full name cleaning pipeline */
function cleanName(rawName) {
  let s = rawName;
  s = stripPipeText(s);
  s = stripSize(s);
  s = stripParens(s);
  s = stripDescriptors(s);
  s = cleanPunctuation(s);
  s = s.replace(/\s+/g, ' ').trim();

  // Handle empty result (model-number-only products after stripping)
  if (!s) s = rawName.replace(/\([^)]*\)/g, '').trim();

  s = titleCase(s);
  s = applyCollectionCasing(s);
  return s;
}

/** Normalize accented chars for matching */
function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Extract collection name from cleaned product name */
function extractCollection(cleanedName) {
  const lower = stripAccents(cleanedName.toLowerCase());
  const sorted = [...KNOWN_COLLECTIONS].sort((a, b) => b.length - a.length);
  for (const col of sorted) {
    if (lower.startsWith(stripAccents(col.toLowerCase()))) {
      return applyCollectionCasing(titleCase(col));
    }
  }
  return cleanedName.split(' ')[0];
}

async function main() {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.collection,
      s.id as sku_id, s.internal_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [VENDOR_ID]);

  console.log(`Found ${rows.length} Orion products/SKUs`);
  if (DRY_RUN) console.log('(DRY RUN — no changes will be made)\n');

  let updated = 0;
  let merged = 0;

  // Group by product ID to handle multi-SKU products
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.id)) byProduct.set(row.id, { ...row, skus: [] });
    byProduct.get(row.id).skus.push({ sku_id: row.sku_id, internal_sku: row.internal_sku });
  }

  for (const [productId, product] of byProduct) {
    const newName = cleanName(product.name);
    const newCollection = extractCollection(newName);

    if (newName !== product.name || newCollection !== product.collection) {
      // Check if a product with the target name already exists
      const { rows: existing } = await pool.query(
        'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4',
        [VENDOR_ID, newCollection, newName, productId]
      );

      if (existing.length > 0) {
        // Merge: move SKUs, media, pricing to the existing product, then delete duplicate
        const keepId = existing[0].id;
        console.log(`  MERGE: "${product.name}" → existing "${newName}" (${keepId})`);
        if (!DRY_RUN) {
          await pool.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, productId]);
          await pool.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2', [keepId, productId]);
          await pool.query('DELETE FROM products WHERE id = $1', [productId]);
        }
        merged++;
      } else {
        console.log(`  ${product.name}`);
        console.log(`    → name: "${newName}"  collection: "${newCollection}"`);
        if (!DRY_RUN) {
          await pool.query(
            'UPDATE products SET name = $1, collection = $2 WHERE id = $3',
            [newName, newCollection, productId]
          );
        }
        updated++;
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`Total products: ${byProduct.size}`);
  console.log(`Updated: ${updated}`);
  console.log(`Merged (duplicates removed): ${merged}`);
  console.log(`Unchanged: ${byProduct.size - updated - merged}`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
