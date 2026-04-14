#!/usr/bin/env node
/**
 * Import Style Access — Full Catalog (Lungarno Ceramics + CommodiTile)
 *
 * Source: Style Access Q3-2025 PDF Price List + style-access.com (images)
 * Brands: Lungarno Ceramics, CommodiTile
 * Product types: Wall Tile, Floor Tile, Mosaic, Trim
 *
 * Features:
 *   - Parses price list data from pdftotext output (backend/data/style-access-pricelist.txt)
 *   - Creates products, SKUs, pricing, packaging for all 35 series (~472 SKUs)
 *   - Groups tiles by color within each series (variant pills)
 *   - Marks trim/jolly pieces as accessories of matching color products
 *   - Fetches product images from WooCommerce REST API (style-access.com)
 *
 * Usage: docker compose exec api node scripts/import-style-access.js
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Category IDs from seed.sql
const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  ceramic:   '650e8400-e29b-41d4-a716-446655440013',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
  stone:     '650e8400-e29b-41d4-a716-446655440011',
  sundries:  '650e8400-e29b-41d4-a716-446655440110',
};

const MARKUP = 2.0;
const BRAND_MAP = { 'LGC': 'Lungarno', 'COMT': 'CommodiTile' };

// ==================== CATEGORY DETERMINATION ====================
function getCategoryId(type, material) {
  if (type === 'Mosaic') return CAT.mosaic;
  if (type === 'Misc') return CAT.sundries;
  if (material.includes('Ceramic') || material === 'Terracotta') return CAT.ceramic;
  if (material.includes('Porcelain') || material.includes('Through-Body')) return CAT.porcelain;
  if (material === 'Glass') return CAT.mosaic;
  if (material === 'Natural Stone') return CAT.stone;
  return CAT.ceramic;
}

// ==================== COLOR GROUPING ====================
// Extract base color from description for product grouping.
// Strips finish modifiers, patterns, trim markers, size info.
function getBaseColor(desc) {
  return desc
    .replace(/\b(Jolly|geometric|jolly|Trim|BN|Universal|OG|NHU)\b/gi, '')
    .replace(/\b(Flat|Dixie|Charleston|Swing)\b/gi, '')
    .replace(/\b(undulated|Undulated|extruded|pressed|antislip)\b/gi, '')
    .replace(/\bglazed\s+pol\.?\b/gi, '')
    .replace(/\bfinish\s+R\d+\b/gi, '')
    .replace(/\b(Flower\s+Deco|Deco|Audrey\s+D[eé]cor|Chloe\s+D[eé]cor)\b/gi, '')
    .replace(/\b(Gloss|Satin|Matte|matte|gloss|satin)\b/gi, '')
    .replace(/\b(Brick\s+Joint|loose|Cross\s+Hatch)\b/gi, '')
    .replace(/\b\d+in\b/gi, '')
    .replace(/\b\d+x\d+\b/gi, '')
    .replace(/[,.'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== PRICE LIST PARSING ====================
const KNOWN_MATERIALS = [
  'Through-Body Porcelain Pressed', 'Through-Body Porcelain', 'Through-Body Glass',
  'Porcelain Pressed >0.5', 'Porcelain Rectified', 'Porcelain Pressed', 'Porcelain',
  'Ceramic Pressed', 'Ceramic Extruded', 'Terracotta', 'Natural Stone', 'Glass',
];
const KNOWN_TYPES = ['Wall Tile', 'Floor Tile', 'Mosaic', 'Trim', 'Misc'];

function parsePriceList() {
  const text = readFileSync(join(__dirname, '..', 'data', 'style-access-pricelist.txt'), 'utf8');
  const rawLines = text.split('\n');
  // Join continuation lines (e.g. Elements series wraps description + numerics across two lines)
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (i + 1 < rawLines.length && /^\s{20,}(CT|SH|PC|EA)\s+\d/.test(rawLines[i + 1])) {
      lines.push(rawLines[i] + rawLines[i + 1]);
      i++;
    } else {
      lines.push(rawLines[i]);
    }
  }
  const rows = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/PRICE LIST|EFFECTIVE|Price Increase|2025 Fall|2026|Winter New/i.test(line)) continue;
    if (/^\s*(Brand|CT\s+PC)/i.test(line)) continue;
    if (/^\s+(CT\s+PC|PC \/|SF \/)/i.test(line)) continue;
    if (/^\s+Mosaic\s*$/.test(line) || /^\s+Hatch\s+Terracotta/.test(line)) continue;

    const uomMatch = line.match(/\s(CT|SH|PC|EA)\s+(\d+)\s/);
    if (!uomMatch) continue;

    const uom = uomMatch[1];
    const uomStart = uomMatch.index + 1;
    const beforeUom = line.substring(0, uomStart).trimEnd();
    const numericSection = line.substring(uomStart + uom.length).trim();

    // Extract $ prices (at end of line)
    const priceRegex = /\$\s*([\d,.]+)/g;
    const prices = [];
    let m;
    while ((m = priceRegex.exec(numericSection)) !== null) {
      prices.push(parseFloat(m[1].replace(/,/g, '')));
    }

    // Non-price numbers
    const withoutPrices = numericSection.replace(/\$\s*[\d,.]+/g, '').replace(/,/g, '').trim();
    const rawNums = withoutPrices.split(/\s+/).map(s => s === '-' ? null : parseFloat(s));

    const pcsPerCt = rawNums[0] != null ? Math.round(rawNums[0]) : null;
    const sfPerPc = rawNums[1] || null;
    const sfPerCt = rawNums[2] || null;
    const ctPerPal = rawNums[3] != null ? Math.round(rawNums[3]) : null;
    const uomPrice = prices[0] || null;
    const fieldSfPrice = prices[1] || null;

    // Parse text before UOM
    let material = null, beforeMat = beforeUom;
    for (const mat of KNOWN_MATERIALS) {
      const idx = beforeUom.lastIndexOf(mat);
      if (idx > 0) { material = mat; beforeMat = beforeUom.substring(0, idx).trimEnd(); break; }
    }
    if (!material) continue;

    let type = null, beforeType = beforeMat;
    for (const t of KNOWN_TYPES) {
      const idx = beforeMat.lastIndexOf(t);
      if (idx > 0) { type = t; beforeType = beforeMat.substring(0, idx).trimEnd(); break; }
    }
    if (!type) {
      for (const t of KNOWN_TYPES) {
        if (beforeMat.includes(t)) {
          type = t; beforeType = beforeMat.substring(0, beforeMat.indexOf(t)).trimEnd(); break;
        }
      }
    }
    if (!type) continue;

    // Size
    let size = null, beforeSize = beforeType;
    const sizePatterns = [
      /\s+(2x2,\s*1x2\s*Cross)\s*$/, /\s+(\d[\d.]*x\d[\d.]*(?:\s+(?:Long\s+Oval|Crosshatch|Oval|loose))?)\s*$/,
      /\s+(\din\s+Circle)\s*$/, /\s+(\S+)\s*$/,
    ];
    for (const pat of sizePatterns) {
      const sm = beforeType.match(pat);
      if (sm) { size = sm[1].trim(); beforeSize = beforeType.substring(0, sm.index).trimEnd(); break; }
    }

    // Brand, Series, SKU, Description
    const brandMatch = beforeSize.match(/^(LGC|COMT|Lungarno|CommodiTile|none)\s+/);
    if (!brandMatch) continue;
    const brand = BRAND_MAP[brandMatch[1]] || brandMatch[1];
    const parts = beforeSize.substring(brandMatch[0].length).split(/\s{2,}/);
    // When PDF column spacing collapses to single space, series+SKU or SKU+desc merge
    if (parts.length === 2) {
      const m0 = parts[0].match(/^(.+?)\s([A-Z][A-Z0-9]{5,})$/);
      if (m0) {
        parts.splice(0, 1, m0[1], m0[2]);
      } else {
        const m1 = parts[1].match(/^([A-Z][A-Z0-9]{5,})\s+(.+)$/);
        if (m1) parts.splice(1, 1, m1[1], m1[2]);
      }
    }
    if (parts.length < 3) continue;

    rows.push({
      brand, series: parts[0].trim(), sku: parts[1].trim(),
      description: parts.slice(2).join(' ').trim(),
      size, type, material, uom, pcsPerCt, sfPerPc, sfPerCt, ctPerPal,
      uomPrice, fieldSfPrice,
    });
  }

  // Fix Zellige Bespoke rows where prices overflowed as ####### in pdftotext
  for (const row of rows) {
    if (row.series !== 'Zellige Bespoke') continue;
    if (row.sku.endsWith('26OVL') && !row.fieldSfPrice) {
      // 2x6 Long Oval: UOM Price overflowed, only Field SF Price ($16.50) survived (captured as uomPrice)
      row.fieldSfPrice = row.uomPrice;
      row.uomPrice = null;
    } else if (row.sku.endsWith('44L') && !row.uomPrice && !row.fieldSfPrice) {
      // 4x4: both UOM Price and Field SF Price overflowed
      row.uomPrice = 150.64;
      row.fieldSfPrice = 14.00;
    }
  }

  return rows;
}

// ==================== WOOCOMMERCE IMAGE FETCHER ====================
async function fetchImages() {
  const imageMap = new Map(); // sku → imageUrl
  console.log('Fetching product images from style-access.com...');
  try {
    for (let page = 1; page <= 7; page++) {
      const url = `https://style-access.com/wp-json/wp/v2/product?per_page=100&page=${page}&_embed`;
      const res = await fetch(url);
      if (!res.ok) break;
      const products = await res.json();
      if (!products.length) break;

      for (const p of products) {
        // Extract SKU from excerpt
        const excerpt = p.excerpt?.rendered || '';
        const skuMatch = excerpt.match(/SKU:\s*([A-Z0-9]+)/i);
        if (!skuMatch) continue;
        const sku = skuMatch[1];

        // Get featured image URL
        const media = p._embedded?.['wp:featuredmedia'];
        const imageUrl = media?.[0]?.source_url;
        if (imageUrl) imageMap.set(sku, imageUrl);
      }

      console.log(`  Page ${page}: ${products.length} products (${imageMap.size} images total)`);
    }
  } catch (err) {
    console.warn('  Warning: Could not fetch images from style-access.com:', err.message);
  }
  return imageMap;
}

// ==================== DB UPSERT HELPERS ====================
async function upsertVendor(name, code, website) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, website) VALUES ($1, $2, $3)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
    RETURNING id
  `, [name, code, website]);
  return res.rows[0].id;
}

async function upsertProduct(vendorId, { name, collection, categoryId, descriptionShort }) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, description_short)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
    DO UPDATE SET category_id = EXCLUDED.category_id,
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, name, collection, categoryId, descriptionShort || null]);
  return res.rows[0];
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType }) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = EXCLUDED.sell_by,
      variant_type = EXCLUDED.variant_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName, sellBy, variantType || null]);
  return res.rows[0];
}

async function upsertPricing(skuId, { cost, retailPrice, priceBasis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retailPrice, priceBasis]);
}

async function upsertPackaging(skuId, { sqftPerBox, boxesPerPallet }) {
  if (!sqftPerBox) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = EXCLUDED.sqft_per_box, boxes_per_pallet = EXCLUDED.boxes_per_pallet
  `, [skuId, sqftPerBox, boxesPerPallet]);
}

async function upsertAttribute(skuId, slug, value) {
  if (!value) return;
  const attrRes = await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [slug]);
  if (!attrRes.rows.length) return;
  const attrId = attrRes.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

async function upsertMediaAsset(productId, skuId, url) {
  if (!url) return;
  if (skuId) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, 'primary', $3, $3, 0)
      ON CONFLICT DO NOTHING
    `, [productId, skuId, url]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
      VALUES ($1, 'primary', $2, $2, 0)
      ON CONFLICT DO NOTHING
    `, [productId, url]);
  }
}

// ==================== MAIN IMPORT LOGIC ====================
async function main() {
  console.log('=== Style Access Import ===\n');

  // 1. Parse price list
  const rows = parsePriceList();
  console.log(`Parsed ${rows.length} SKUs from price list\n`);

  // 2. Skip image fetching (will be handled separately)
  const imageMap = new Map();
  console.log(`Skipping image fetch (will be handled separately)\n`);

  // 3. Create vendor
  const vendorId = await upsertVendor('Style Access (Lungarno / CommodiTile)', 'STYLEACCESS', 'https://style-access.com');
  console.log(`Vendor ID: ${vendorId}\n`);

  // 4. Group rows into products
  // Product key = (series, baseColor)
  // Each product has multiple SKUs (different sizes, formats, trims)
  const productMap = new Map(); // "series|baseColor" → { rows: [...], catId, series, baseColor }

  for (const row of rows) {
    const baseColor = getBaseColor(row.description);
    const key = `${row.series}|${baseColor}`;

    if (!productMap.has(key)) {
      // Use category from first non-trim SKU in this group
      const catId = row.type === 'Trim' ? null : getCategoryId(row.type, row.material);
      productMap.set(key, { rows: [], catId, series: row.series, baseColor });
    }

    const group = productMap.get(key);
    group.rows.push(row);

    // Update catId from non-trim rows
    if (!group.catId && row.type !== 'Trim') {
      group.catId = getCategoryId(row.type, row.material);
    }
  }

  console.log(`Grouped into ${productMap.size} products\n`);

  // 5. Import
  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;
  let imagesLinked = 0;

  for (const [key, group] of productMap) {
    const catId = group.catId || CAT.ceramic; // fallback for trim-only groups
    const productName = group.baseColor || group.rows[0].description;
    const collection = group.series;

    // Create product
    const prod = await upsertProduct(vendorId, {
      name: productName,
      collection,
      categoryId: catId,
      descriptionShort: `${collection} - ${productName}`,
    });

    if (prod.is_new) productsCreated++;
    else productsUpdated++;

    // Create SKUs for this product
    for (const row of group.rows) {
      const isTrim = row.type === 'Trim';
      const isMosaic = row.type === 'Mosaic';
      const isSqft = !isTrim && row.type !== 'Misc';

      const sellBy = isSqft ? 'sqft' : 'unit';
      const variantType = isTrim ? 'accessory' : null;

      // Variant name: description + size for context
      const variantName = `${row.description} (${row.size})`;
      const internalSku = `SA-${row.sku}`;

      const sku = await upsertSku(prod.id, {
        vendorSku: row.sku,
        internalSku,
        variantName,
        sellBy,
        variantType,
      });

      if (sku.is_new) skusCreated++;
      else skusUpdated++;

      // Pricing
      let cost, priceBasis;
      if (isTrim || row.type === 'Misc') {
        // Per-unit pricing
        cost = row.uomPrice;
        priceBasis = 'per_unit';
      } else if (row.fieldSfPrice) {
        // CT items with explicit per-sqft price
        cost = row.fieldSfPrice;
        priceBasis = 'per_sqft';
      } else if (row.sfPerPc && row.uomPrice) {
        // SH items: calculate per-sqft from per-sheet price
        cost = parseFloat((row.uomPrice / row.sfPerPc).toFixed(2));
        priceBasis = 'per_sqft';
      } else {
        cost = row.uomPrice;
        priceBasis = 'per_unit';
      }

      if (cost) {
        const retailPrice = parseFloat((cost * MARKUP).toFixed(2));
        await upsertPricing(sku.id, { cost, retailPrice, priceBasis });
      }

      // Packaging (sqft per carton/box)
      if (row.sfPerCt && row.ctPerPal) {
        await upsertPackaging(sku.id, {
          sqftPerBox: row.sfPerCt,
          boxesPerPallet: row.ctPerPal,
        });
      }

      // Attributes
      await upsertAttribute(sku.id, 'material', row.material);
      await upsertAttribute(sku.id, 'color', row.description);
      if (row.size) await upsertAttribute(sku.id, 'width', row.size);

      // Image from WooCommerce API
      const imageUrl = imageMap.get(row.sku);
      if (imageUrl) {
        await upsertMediaAsset(prod.id, sku.id, imageUrl);
        imagesLinked++;
      }
    }

    // If no SKU-level images, try to set product-level image from first available
    const firstImage = group.rows.map(r => imageMap.get(r.sku)).find(Boolean);
    if (firstImage) {
      await upsertMediaAsset(prod.id, null, firstImage);
    }

    const trimCount = group.rows.filter(r => r.type === 'Trim').length;
    const tileCount = group.rows.length - trimCount;
    console.log(`  ${collection} / ${productName}: ${tileCount} tiles${trimCount ? ` + ${trimCount} trims` : ''}`);
  }

  // Summary
  console.log('\n=== Import Complete ===');
  console.log(`Products created: ${productsCreated}`);
  console.log(`Products updated: ${productsUpdated}`);
  console.log(`SKUs created: ${skusCreated}`);
  console.log(`SKUs updated: ${skusUpdated}`);
  console.log(`Images linked: ${imagesLinked}`);
  console.log(`Total products: ${productsCreated + productsUpdated}`);
  console.log(`Total SKUs: ${skusCreated + skusUpdated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
