/**
 * Ottimo Ceramics — Full Vendor Import
 *
 * Source: Ottimo Q-3-2025 PDF price list (pdftotext -layout output)
 * Two sections: Mosaics (lines ~12–152) + Tiles (lines ~158–678)
 *
 * Product grouping: collection + color = product.
 * Different sizes of same collection+color = different SKUs (tiles).
 * Mosaics are typically 1 SKU per product.
 *
 * Retail = cost × 2.0 (standard markup)
 *
 * Usage: docker compose exec api node scripts/import-ottimo.js
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ─── Category IDs ───
const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  ceramic:   '650e8400-e29b-41d4-a716-446655440013',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
  pavers:    '650e8400-e29b-41d4-a716-446655440062',
};

// ─── Attribute IDs ───
const ATTR = {
  color:    'd50e8400-e29b-41d4-a716-446655440001',
  size:     'd50e8400-e29b-41d4-a716-446655440004',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
  finish:   'd50e8400-e29b-41d4-a716-446655440003',
};

const MARKUP = 2.0;

// ─── Title-case helper ───
function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    .replace(/\bOf\b/g, 'of').replace(/\bAnd\b/g, 'and').replace(/\bDe\b/g, 'de')
    .replace(/\bW\/\b/gi, 'w/');
}

// ─── Normalize size string: "12"x24"" → "12x24" ───
function normalizeSize(raw) {
  if (!raw) return '';
  return raw.replace(/[""'']/g, '').replace(/\s+/g, '').replace(/×/g, 'x');
}

// ─── Page header detection ───
function isPageHeader(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\s*Ottimo\s*$/i.test(t)) return true;
  if (/Ceramics,?\s*Inc/i.test(t)) return true;
  if (/Ottimo Item Number/i.test(t)) return true;
  if (/Program Price List/i.test(t)) return true;
  if (/Ceramic\s*\/\s*Wall/i.test(t)) return true;
  if (/Porcelain\s+& Floor/i.test(t)) return true;
  if (/Surcharge/i.test(t)) return true;
  if (/May \d+, \d{4}/i.test(t)) return true;
  if (/Temporary\s+.*Pcs\s+Sft/i.test(t)) return true;
  if (/^\s*7%\s+/.test(t)) return true;
  return false;
}

// ─── Extract finish from description ───
function extractFinish(desc) {
  const d = desc.toUpperCase();
  if (/\bPOLISHED\b/.test(d)) return 'Polished';
  if (/\bSEMI\s*POLISHED\b/.test(d) || /\bLAPATTO\b/i.test(d) || /\bLAPATTO\b/.test(d)) return 'Semi Polished';
  if (/\bGLAZED\b/.test(d) && /\bGLOSS\b/.test(d)) return 'Gloss';
  if (/\bGLOSS\b/.test(d) && !/\bMATTE\b/.test(d)) return 'Gloss';
  if (/\bMATTE\b/.test(d)) return 'Matte';
  if (/\bGLAZED\b/.test(d)) return 'Glazed';
  if (/\bSATIN\b/.test(d)) return 'Satin';
  if (/\bTEXTURED\b/.test(d)) return 'Textured';
  return null;
}

// ─── Extract material from mosaic description ───
function extractMosaicMaterial(desc) {
  const d = desc.toUpperCase();
  if (/\bALUMINUM\b/.test(d)) return 'Aluminum';
  if (/\bSTAINLESS\s*STEEL\b/.test(d)) return 'Stainless Steel';
  if (/\bMARBLE\b/.test(d)) return 'Marble';
  if (/\bGLASS\b/.test(d) && /\bSTONE\b/.test(d)) return 'Glass & Stone';
  if (/\bRECYCLED\s*GLASS\b/.test(d)) return 'Recycled Glass';
  if (/\bGLASS\b/.test(d)) return 'Glass';
  if (/\bSTONE\b/.test(d)) return 'Stone';
  if (/\bPORCELAIN\b/.test(d)) return 'Porcelain';
  if (/\bSHELL\b/.test(d)) return 'Shell';
  if (/\bMIRROR\b/.test(d)) return 'Mirror';
  return 'Mixed';
}

// ─── Parse mosaic description → { collection, color, size } ───
function parseMosaicDesc(desc) {
  let text = desc.trim();

  // Extract size from description
  let size = '';
  const sizeMatch = text.match(/(\d+[\s\d\/]*"?\s*x\s*\d+[\s\d\/]*"?)/i);
  if (sizeMatch) size = sizeMatch[1].trim();

  // Try splitting on " - " for color
  const dashParts = text.split(/\s+-\s+/);
  let collection, color;

  if (dashParts.length >= 2) {
    // "Era Stone and Stainess Mix Mosaic - White and Black (1.21sf/pc)"
    let collPart = dashParts[0].trim();
    color = dashParts.slice(1).join(' - ').trim();
    // Clean color: remove parenthetical sqft info and trailing size
    color = color.replace(/\s*\([\d.]+sf\/(?:pc|sheet|piece)\)/gi, '').trim();
    color = color.replace(/\s*\([^)]*\)/g, '').trim();
    // Strip embedded sizes from collPart before matching
    collPart = collPart.replace(/\d+[\s\d\/]*"?\s*[xX×]\s*\d+[\s\d\/]*"?/g, '').replace(/\s+/g, ' ').trim();
    // Extract collection: first word(s) before material/type words
    const collMatch = collPart.match(/^([\w\s]+?)\s+(?:Stone|Glass|Marble|Recycled|Aluminum|Stainless|Mirror|Mosaic|Mosiac|Hexagon|Subway|Woven|Iridescent|Offset|Stacked|Elongated|Triangle|Arabesque|Linear|Pillowed|Picket|Square|Rectangle|Reverse|Penny)/i);
    collection = collMatch ? collMatch[1].trim() : collPart.replace(/\s+(?:Mosaic|Mosiac|Blend|Mix|Sheet|Glass|Stone).*$/i, '').trim();
  } else {
    // "Cosmos Glass Blend 12 1/4"x12 1/4" Blanco"
    // Try to extract collection from start and color from end
    const words = text.replace(/\s*\([\d.]+sf\/(?:pc|sheet|piece)\)/gi, '').split(/\s+/);

    // Collection = first word(s) that aren't material/type
    const materialWords = new Set(['glass', 'stone', 'marble', 'aluminum', 'stainless', 'steel',
      'recycled', 'mirror', 'porcelain', 'shell', 'ceramic', 'mosaic', 'mosiac', 'blend', 'mix',
      'hexagon', 'hex', 'subway', 'woven', 'iridescent', 'square', 'rectangle', 'sheet',
      'mesh', 'mount', 'meshmount', 'offset', 'stacked', 'elongated', 'linear', 'triangle',
      'arabesque', 'pillowed', 'picket', 'reverse', 'bevel', 'edge', 'penny', 'round',
      'dimensional', 'metallic', 'vine', '3d']);
    const sizePattern = /^\d+[\s\d\/"'x×.]+$/i;
    const sqftPattern = /^[\d.]+sf\/|^Sold\b|^per\b/i;

    let collWords = [];
    let colorWords = [];
    let pastMaterial = false;

    for (const w of words) {
      const lower = w.toLowerCase().replace(/[""'']/g, '');
      if (sqftPattern.test(w)) continue;
      if (sizePattern.test(lower)) { pastMaterial = true; continue; }
      if (materialWords.has(lower)) { pastMaterial = true; continue; }
      if (!pastMaterial) {
        collWords.push(w);
      } else {
        colorWords.push(w);
      }
    }

    collection = collWords.join(' ') || words[0];
    color = colorWords.join(' ') || collection;
  }

  // Clean up collection name
  collection = collection.replace(/\s+/g, ' ').trim();
  // Remove trailing size/sqft info from collection
  collection = collection.replace(/\s*\d+[\s\d\/"'x×.]+$/i, '').trim();

  // Clean up color
  color = color.replace(/\s+/g, ' ').trim();
  // Remove trailing size info from color
  color = color.replace(/\s*\d+[\s\d\/"'x×.]+$/i, '').trim();
  // Remove parenthetical info
  color = color.replace(/\s*\([^)]*\)/g, '').trim();
  // Remove "Mosiac"/"Mosaic" residue from color
  color = color.replace(/\s*Mosiac?\b/gi, '').trim();
  // Remove "PER PIECE" notes
  color = color.replace(/\s*PER PIECE/gi, '').trim();
  // If color starts with collection name, strip it
  if (color.toUpperCase().startsWith(collection.toUpperCase() + ' ')) {
    color = color.substring(collection.length + 1).trim();
  }

  if (!color) color = collection;

  return { collection: titleCase(collection), color: titleCase(color), size };
}

// ─── Parse tile description → { collection, color, finish } ───
function parseTileDesc(desc, sizeCol) {
  let text = desc.trim();

  // Remove the size that duplicates the size column
  // e.g. "Affinity 12"x24" Matte White Onyx" → "Affinity Matte White Onyx"
  text = text.replace(/\d+[\s\d\/]*"?\s*[xX×]\s*\d+[\s\d\/]*"?/g, '').trim();

  // Remove parenthetical notes
  text = text.replace(/\s*\([^)]*\)/g, '').trim();

  // Remove trailing "WALL ONLY", "PAVER" markers (already captured in application column)
  text = text.replace(/\s+WALL\s+ONLY$/i, '').trim();

  // Normalize "Porcelain- White" → "Porcelain - White"
  text = text.replace(/(\w)-\s+/g, '$1 - ');

  // Split on " - " for color
  const dashIdx = text.lastIndexOf(' - ');
  let beforeDash, color;

  if (dashIdx > 0) {
    beforeDash = text.substring(0, dashIdx).trim();
    color = text.substring(dashIdx + 3).trim();
  } else {
    beforeDash = text;
    color = null;
  }

  // Extract collection: the first word(s) before material/finish descriptors
  // "Breeze Matte Porcelain Fresh White" → collection=Breeze
  // "Calacatta Ocean Polished Porcelain" → collection=Calacatta Ocean

  // Remove material/finish words to find collection vs color boundary
  const stripWords = [
    'matte', 'polished', 'semi polished', 'semi', 'lapatto', 'glazed', 'gloss', 'glossy',
    'satin', 'textured', 'pressed', 'dimensional',
    'porcelain', 'ceramic', 'stoneware',
    'wall', 'floor', 'field', 'paver', 'deco', 'décor',
    'series', 'collection', 'tile', 'subway', 'covebase', 'cove base',
    'color body', 'metallic', 'oxide', 'fabric', 'stucco', 'concrete look',
    'stone look', 'wood', 'outdoor', 'handmade',
  ];

  let collPart = beforeDash;
  for (const sw of stripWords) {
    const re = new RegExp(`\\b${sw}\\b`, 'gi');
    collPart = collPart.replace(re, '');
  }
  collPart = collPart.replace(/\s+/g, ' ').trim();

  // If no dash separator, try to extract color from remaining words after collection
  if (!color) {
    // The collection is the first meaningful word(s), color is the rest
    // "Super White Polished Porcelain" → collection=Super White, color=Super White
    color = collPart || beforeDash;
  }

  // Clean collection: remove trailing color words that leaked in
  let collection = collPart;
  if (color && collection.endsWith(' ' + color)) {
    collection = collection.substring(0, collection.length - color.length - 1).trim();
  }
  if (!collection) collection = color;

  // Handle "Made in Italy/Spain" notes
  color = color.replace(/\s*\(Made in \w+\)/gi, '').trim();
  collection = collection.replace(/\s*\(Made in \w+\)/gi, '').trim();

  // Handle "Also avail." notes
  color = color.replace(/\s*\/\s*Also avail\..*$/i, '').trim();
  collection = collection.replace(/\s*\/\s*Also avail\..*$/i, '').trim();

  // Remove "PAVER" from collection/color
  color = color.replace(/\s*PAVER\s*/gi, '').trim();
  collection = collection.replace(/\s*PAVER\s*/gi, '').trim();

  // Remove "2.0" version suffixes from collection
  collection = collection.replace(/\s+\d+\.\d+\s*$/i, '').trim();

  // Handle standalone products without clear color separation
  if (!collection || collection === color) {
    // Try first word as collection
    const words = (beforeDash || text).split(/\s+/);
    const firstWord = words[0];
    if (firstWord && !stripWords.includes(firstWord.toLowerCase())) {
      collection = firstWord;
    }
  }

  // Strip collection name prefix from color if present
  if (color && collection && color !== collection) {
    if (color.toUpperCase().startsWith(collection.toUpperCase() + ' ')) {
      color = color.substring(collection.length + 1).trim();
    }
  }

  const finish = extractFinish(desc);

  return {
    collection: titleCase(collection),
    color: titleCase(color),
    finish,
  };
}

// ─── Resolve category for tiles ───
function getTileCategory(material, application) {
  const app = (application || '').toUpperCase();
  const mat = (material || '').toUpperCase();
  if (app === 'PAVER') return CAT.pavers;
  if (mat === 'CERAMIC') return CAT.ceramic;
  return CAT.porcelain;
}

// ─── Parse the pdftotext output ───
function parsePricelist(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  const mosaicRecords = [];
  const tileRecords = [];
  const errors = [];

  let section = 'mosaic'; // starts in mosaic section

  // Tile regex - matches lines like:
  // AFF010M-2            12"x24" Porcelain Wall & Floor Affinity 12"x24" Matte White Onyx    $1.92    5    9.7
  const tileRe = /^(\S+?\*?)\s+([\d."'/]+\s*x\s*[\d."'/]+)\s+(Porcelain|Ceramic)\s+(Wall & Floor|WALL ONLY|PAVER)\s+(.+?)\s+\$([\d,.]+)\s+(\d+)\s+([\d.]+)\s*$/i;

  // Also handle tile lines with "Sold by pc" instead of pcs/sqft (like QRY covebase in tile section)
  const tilePcRe = /^(\S+?\*?)\s+([\d."'/]+\s*x\s*[\d."'/]+)\s+(Porcelain|Ceramic)\s+(Wall & Floor|WALL ONLY|PAVER)\s+(.+?)\s+\$([\d,.]+)\s+Sold by pc\s*$/i;

  // Mosaic regex - matches lines like:
  // AL01                   Aluminum Dark and Light Mix Mosiac 12"x12" Sheet    $29.13   Sold by pc
  const mosaicRe = /^(\S+(?:\s\d+)?)\s{2,}(.+?)\s+\$([\d,.]+)\s+(Sold by pc|\d+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect section boundary
    if (/Tile\s*-\s*Sold per Carton/i.test(line)) {
      section = 'tile';
      continue;
    }

    // Stop at BULLNOSE special order section
    if (/^BULLNOSE\b/i.test(line.trim())) break;

    // Skip headers/blanks
    if (isPageHeader(line)) continue;

    // Skip $0.00 warning lines (ERA01 NOT to be used, etc.)
    if (/\$0\.00/.test(line)) continue;

    // Skip "*Denotes Bullnose" annotation
    if (/Denotes Bullnose/i.test(line)) continue;

    if (section === 'mosaic') {
      const m = line.match(mosaicRe);
      if (!m) continue;

      const vendorSku = m[1].trim();
      const desc = m[2].trim();
      const price = parseFloat(m[3].replace(',', ''));

      if (price <= 0) continue;

      const parsed = parseMosaicDesc(desc);

      // Check for pcs/carton in the "Sold by pc" or numeric field
      let pcsCarton = null;
      if (m[4] !== 'Sold by pc') {
        pcsCarton = parseInt(m[4], 10);
      }

      mosaicRecords.push({
        vendorSku,
        description: desc,
        price,
        collection: parsed.collection,
        color: parsed.color,
        size: parsed.size,
        material: extractMosaicMaterial(desc),
        finish: extractFinish(desc),
        pcsCarton,
      });
    } else {
      // Tile section
      let m = line.match(tileRe);
      if (m) {
        const vendorSku = m[1].replace(/\*+$/, '').trim();
        const sizeCol = m[2].trim();
        const material = m[3].trim();
        const application = m[4].trim();
        const desc = m[5].trim();
        const price = parseFloat(m[6].replace(',', ''));
        const pcsCarton = parseInt(m[7], 10);
        const sqftCarton = parseFloat(m[8]);

        if (price <= 0) continue;

        const parsed = parseTileDesc(desc, sizeCol);

        tileRecords.push({
          vendorSku,
          description: desc,
          sizeCol,
          material,
          application,
          price,
          pcsCarton,
          sqftCarton,
          collection: parsed.collection,
          color: parsed.color,
          finish: parsed.finish,
          categoryId: getTileCategory(material, application),
        });
        continue;
      }

      // Check for "Sold by pc" tile lines (e.g., QRY covebase)
      m = line.match(tilePcRe);
      if (m) {
        const vendorSku = m[1].replace(/\*+$/, '').trim();
        const sizeCol = m[2].trim();
        const material = m[3].trim();
        const application = m[4].trim();
        const desc = m[5].trim();
        const price = parseFloat(m[6].replace(',', ''));

        if (price <= 0) continue;

        const parsed = parseTileDesc(desc, sizeCol);

        tileRecords.push({
          vendorSku,
          description: desc,
          sizeCol,
          material,
          application,
          price,
          pcsCarton: null,
          sqftCarton: null,
          collection: parsed.collection,
          color: parsed.color,
          finish: parsed.finish,
          categoryId: getTileCategory(material, application),
          soldByPc: true,
        });
      }
    }
  }

  return { mosaicRecords, tileRecords, errors };
}

// ─── Group records into products ───
function groupIntoProducts(mosaicRecords, tileRecords) {
  const productMap = new Map(); // key → { collection, color, categoryId, skus[] }

  // Group mosaics by collection + color
  for (const rec of mosaicRecords) {
    const key = `mosaic|${rec.collection}|${rec.color}`;
    if (!productMap.has(key)) {
      productMap.set(key, {
        collection: rec.collection,
        color: rec.color,
        categoryId: CAT.mosaic,
        skus: [],
      });
    }
    productMap.get(key).skus.push({
      vendorSku: rec.vendorSku,
      description: rec.description,
      price: rec.price,
      sellBy: 'unit',
      priceBasis: 'per_unit',
      variantName: rec.color,
      size: rec.size,
      material: rec.material,
      finish: rec.finish,
      pcsCarton: rec.pcsCarton,
      sqftCarton: null,
    });
  }

  // Group tiles by collection + color
  for (const rec of tileRecords) {
    const key = `tile|${rec.collection}|${rec.color}`;
    if (!productMap.has(key)) {
      productMap.set(key, {
        collection: rec.collection,
        color: rec.color,
        categoryId: rec.categoryId,
        skus: [],
      });
    }
    const size = normalizeSize(rec.sizeCol);
    const sellBy = rec.soldByPc ? 'unit' : 'sqft';
    const priceBasis = rec.soldByPc ? 'per_unit' : 'per_sqft';

    productMap.get(key).skus.push({
      vendorSku: rec.vendorSku,
      description: rec.description,
      price: rec.price,
      sellBy,
      priceBasis,
      variantName: size,
      size,
      material: titleCase(rec.material),
      finish: rec.finish,
      pcsCarton: rec.pcsCarton,
      sqftCarton: rec.sqftCarton,
    });
  }

  return productMap;
}

// ─── Main import function ───
async function run() {
  const filePath = join(__dirname, '..', 'data', 'ottimo-pricelist.txt');
  console.log('Reading pdftotext output...');

  const { mosaicRecords, tileRecords } = parsePricelist(filePath);
  console.log(`Parsed ${mosaicRecords.length} mosaic records + ${tileRecords.length} tile records = ${mosaicRecords.length + tileRecords.length} total\n`);

  const productMap = groupIntoProducts(mosaicRecords, tileRecords);
  console.log(`Grouped into ${productMap.size} products\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert vendor
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Ottimo Ceramics', 'OTTIMO', 'https://ottimoceramics.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Ottimo Ceramics (${vendorId})\n`);

    let totalProducts = 0, totalSkus = 0, totalPricing = 0, totalPkg = 0, totalAttrs = 0;

    for (const [key, prod] of productMap) {
      const productName = prod.color || prod.collection;

      // Insert product
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, productName, prod.collection, prod.categoryId]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      for (const sku of prod.skus) {
        const internalSku = 'OTTIMO-' + sku.vendorSku;
        const variantName = sku.variantName || productName;

        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = EXCLUDED.sell_by, status = 'active'
          RETURNING id
        `, [productId, sku.vendorSku, internalSku, variantName, sku.sellBy]);
        const skuId = skuRes.rows[0].id;
        totalSkus++;

        // Pricing
        if (sku.price > 0) {
          const cost = sku.price.toFixed(2);
          const retail = (sku.price * MARKUP).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost,
              retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
          `, [skuId, cost, retail, sku.priceBasis]);
          totalPricing++;
        }

        // Packaging (tiles with pcs/sqft data)
        if (sku.sqftCarton || sku.pcsCarton) {
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
              pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)
          `, [skuId, sku.sqftCarton || null, sku.pcsCarton || null]);
          totalPkg++;
        }

        // Attributes
        if (prod.color) {
          await upsertAttr(client, skuId, ATTR.color, prod.color);
          totalAttrs++;
        }
        if (sku.size) {
          await upsertAttr(client, skuId, ATTR.size, normalizeSize(sku.size));
          totalAttrs++;
        }
        if (sku.material) {
          await upsertAttr(client, skuId, ATTR.material, sku.material);
          totalAttrs++;
        }
        if (sku.finish) {
          await upsertAttr(client, skuId, ATTR.finish, sku.finish);
          totalAttrs++;
        }
      }

      if (totalProducts % 50 === 0) {
        console.log(`  ... ${totalProducts} products processed`);
      }
    }

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`SKUs: ${totalSkus}`);
    console.log(`Pricing records: ${totalPricing}`);
    console.log(`Packaging records: ${totalPkg}`);
    console.log(`Attribute records: ${totalAttrs}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function upsertAttr(client, skuId, attrId, value) {
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

run().catch(err => { console.error(err); process.exit(1); });
