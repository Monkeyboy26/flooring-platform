#!/usr/bin/env node
/**
 * enrich-ef.cjs
 *
 * Consolidated enrichment for Engineered Floors (EF):
 *   Phase 1: Build product map from vendor_sku parsing
 *   Phase 2: Assign per-SKU images from CSV catalog (including accessories)
 *   Phase 3: Cross-product accessory linking via sku_accessories
 *   Phase 4: Activate draft products that have pricing + images
 *
 * Usage:
 *   node backend/scripts/enrich-ef.cjs --dry-run
 *   node backend/scripts/enrich-ef.cjs
 */

const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_CODE = 'EF';

// ══════════════════════════════════════════════════════════════════════════════
// Suffix classification
// ══════════════════════════════════════════════════════════════════════════════

/** Suffixes that indicate main (flooring) SKUs */
const MAIN_SUFFIXES = new Set([
  'RF', 'RL', 'FL', 'CL', 'DB', 'LV', 'NX', 'IL',
  'A', 'AB', 'K', 'K5', 'K6', 'HP', 'SS',
  '6M', '20',
]);

/** Suffixes that indicate accessory SKUs, mapped to canonical labels */
const ACCESSORY_SUFFIX_MAP = {
  'EC': 'End Cap',
  'EN': 'End Cap',
  'FS': 'Flush Stairnose',
  'FN': 'Flush Stairnose',
  'OS': 'Overlap Stairnose',
  'QU': 'Quarter Round',
  'QR': 'Quarter Round',
  'RD': 'Reducer',
  'RE': 'Reducer',
  'TM': 'T-Mold',
  'TH': 'T-Mold',
  'T2': 'Stair Tread',
  'TS': 'Stair Tread',
  'SN': 'Stairnose',
};

/** Sort order for accessory types in the storefront "Matching Accessories" section */
const ACCESSORY_SORT_ORDER = {
  'End Cap': 1,
  'Flush Stairnose': 2,
  'Overlap Stairnose': 3,
  'Stairnose': 4,
  'Quarter Round': 5,
  'Reducer': 6,
  'T-Mold': 7,
  'Stair Tread': 8,
};

/** TYPE_KEYWORDS fallback from build-sku-accessories.cjs */
const TYPE_KEYWORDS = [
  [/flush\s*stair\s*nos[ei]/i, 'Flush Stairnose'],
  [/overlap(?:ping)?\s*stair\s*nos[ei]/i, 'Overlap Stairnose'],
  [/stair\s*nos[ei]/i, 'Stairnose'],
  [/stair\s*tread/i, 'Stair Tread'],
  [/step\s*nos[ei]/i, 'Stairnose'],
  [/nosing/i, 'Stairnose'],
  [/t[-\s]?mold(?:ing)?/i, 'T-Mold'],
  [/reducer/i, 'Reducer'],
  [/end\s*cap/i, 'End Cap'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/wall\s*base/i, 'Wall Base'],
];

// ══════════════════════════════════════════════════════════════════════════════
// Vendor SKU parsing
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse an EF vendor_sku like "1-D2026-6201-7X48-RF" into components.
 * Returns null if the SKU has fewer than 5 hyphen-separated parts.
 */
function parseVendorSku(vendorSku) {
  const parts = (vendorSku || '').split('-');
  if (parts.length < 5) return null;

  const suffix = parts[parts.length - 1].toUpperCase();
  const size = parts[parts.length - 2].toUpperCase();
  const colorCode = parts[2];
  const styleCode = parts[1];

  const isAccessory = !!ACCESSORY_SUFFIX_MAP[suffix];
  const isMain = MAIN_SUFFIXES.has(suffix);

  // Unknown suffix — skip
  if (!isAccessory && !isMain) return null;

  return {
    styleCode,
    colorCode,
    size,
    suffix,
    isAccessory,
    label: isAccessory ? ACCESSORY_SUFFIX_MAP[suffix] : null,
  };
}

/**
 * Derive accessory label from suffix map first, then fall back to product name keywords.
 */
function deriveAccessoryLabel(suffix, productName) {
  const sfx = (suffix || '').toUpperCase();
  if (ACCESSORY_SUFFIX_MAP[sfx]) return ACCESSORY_SUFFIX_MAP[sfx];

  // Fallback: check product name
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(productName || '')) return label;
  }
  return 'Accessory';
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV parsing (same pattern as import-engfloors-catalog.js)
// ══════════════════════════════════════════════════════════════════════════════

function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '\n' && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
    } else if (char === '\r') {
      // skip CR
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  function parseLine(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          field += '"'; i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          quoted = true;
        } else if (ch === ',') {
          fields.push(field.trim());
          field = '';
        } else {
          field += ch;
        }
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = vals[j] || '';
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Group CSV rows into product → colors → images structure.
 */
function groupRows(rows) {
  const products = new Map();

  for (const row of rows) {
    if (row['Availability'] !== 'Yes') continue;

    const productSku = row['Product SKU'];
    const productName = row['Product Name'];
    const colorName = row['Color Name'];
    const imageType = row['Image Type'];
    const imageUrl = row['Image Sample URL'];

    if (!productSku || !productName) continue;

    if (!products.has(productSku)) {
      products.set(productSku, {
        sku: productSku,
        name: productName,
        brand: row['Brand'],
        productType: row['Product Type'],
        backing: row['Backing'],
        construction: row['Construction'],
        fiberBrand: row['Fiber Brand'],
        collection: row['Collection'],
        finish: row['Finish'],
        installMethod: row['Installation Method'],
        shade: row['Shade'],
        colors: new Map(),
      });
    }

    const product = products.get(productSku);

    if (!product.colors.has(colorName)) {
      product.colors.set(colorName, { swatches: [], roomScenes: [] });
    }

    const colorEntry = product.colors.get(colorName);

    if (imageUrl) {
      if (imageType === 'Swatch') {
        colorEntry.swatches.push(imageUrl);
      } else if (imageType === 'Room Scene') {
        colorEntry.roomScenes.push(imageUrl);
      }
    }
  }

  return products;
}

// ══════════════════════════════════════════════════════════════════════════════
// DB helpers (same as import-engfloors-catalog.js)
// ══════════════════════════════════════════════════════════════════════════════

async function upsertMediaAsset({ product_id, sku_id, asset_type, url, sort_order }) {
  if (url && url.startsWith('http://')) url = url.replace('http://', 'https://');
  const at = asset_type || 'primary';
  const so = sort_order || 0;

  if (sku_id) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, sku_id, at, url, so]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, NULL, $2, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, at, url, so]);
  }
}

async function setAttr(sku_id, slug, value) {
  if (!value || !value.trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Build product map from vendor_sku parsing
// ══════════════════════════════════════════════════════════════════════════════

async function phase1_buildProductMap(vendorId) {
  console.log('\n' + '═'.repeat(60));
  console.log('PHASE 1: Build Product Map');
  console.log('═'.repeat(60));

  const result = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.variant_type, s.product_id,
           s.sell_by, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  console.log(`Loaded ${result.rows.length} active EF SKUs`);

  // styleColorMap[styleCode][colorCode] = { mainSkus: [], accessorySkus: [] }
  const styleColorMap = {};
  let skipped = 0;
  let unknownSuffix = 0;

  for (const sku of result.rows) {
    const parsed = parseVendorSku(sku.vendor_sku);
    if (!parsed) {
      // Short SKU (adhesives, underlayment, etc.) or unknown suffix
      const parts = (sku.vendor_sku || '').split('-');
      if (parts.length < 5) {
        skipped++;
      } else {
        unknownSuffix++;
        console.log(`  [SKIP] Unknown suffix: ${sku.vendor_sku} (${sku.product_name})`);
      }
      continue;
    }

    const { styleCode, colorCode, suffix, isAccessory, label } = parsed;
    if (!styleColorMap[styleCode]) styleColorMap[styleCode] = {};
    if (!styleColorMap[styleCode][colorCode]) {
      styleColorMap[styleCode][colorCode] = { mainSkus: [], accessorySkus: [] };
    }

    const entry = {
      id: sku.id,
      vendor_sku: sku.vendor_sku,
      variant_name: sku.variant_name,
      product_id: sku.product_id,
      product_name: sku.product_name,
      sell_by: sku.sell_by,
      variant_type: sku.variant_type,
      suffix,
      label,
    };

    if (isAccessory) {
      styleColorMap[styleCode][colorCode].accessorySkus.push(entry);
    } else {
      styleColorMap[styleCode][colorCode].mainSkus.push(entry);
    }
  }

  // Summary
  const styles = Object.keys(styleColorMap);
  let totalMainInMap = 0, totalAccInMap = 0, colorsWithBoth = 0;
  for (const style of styles) {
    for (const color of Object.keys(styleColorMap[style])) {
      const cell = styleColorMap[style][color];
      totalMainInMap += cell.mainSkus.length;
      totalAccInMap += cell.accessorySkus.length;
      if (cell.mainSkus.length > 0 && cell.accessorySkus.length > 0) colorsWithBoth++;
    }
  }

  console.log(`\nProduct Map Summary:`);
  console.log(`  Styles:          ${styles.length}`);
  console.log(`  Main SKUs:       ${totalMainInMap}`);
  console.log(`  Accessory SKUs:  ${totalAccInMap}`);
  console.log(`  Colors with both main + accessory: ${colorsWithBoth}`);
  console.log(`  Skipped (short): ${skipped}`);
  if (unknownSuffix > 0) console.log(`  Unknown suffix:  ${unknownSuffix}`);

  return styleColorMap;
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Per-SKU image assignment from CSV
// ══════════════════════════════════════════════════════════════════════════════

async function phase2_imageAssignment(vendorId) {
  console.log('\n' + '═'.repeat(60));
  console.log('PHASE 2: Per-SKU Image Assignment from CSV');
  console.log('═'.repeat(60));

  const csvPath = process.argv.find(a => a.endsWith('.csv'))
    || '/app/data/EF_Full_Product_Catalog.csv';

  // Try local path if Docker path doesn't exist
  const localPath = 'backend/data/EF_Full_Product_Catalog.csv';
  const resolvedPath = fs.existsSync(csvPath) ? csvPath : (fs.existsSync(localPath) ? localPath : null);

  if (!resolvedPath) {
    console.log(`  CSV not found at ${csvPath} or ${localPath} — skipping Phase 2`);
    return { imagesCreated: 0, attrsSet: 0, skusMatched: 0, skusUnmatched: 0 };
  }

  console.log(`Reading CSV: ${resolvedPath}`);
  const rows = parseCSV(resolvedPath);
  console.log(`Parsed ${rows.length} rows`);

  const csvProducts = groupRows(rows);
  console.log(`Grouped into ${csvProducts.size} CSV products\n`);

  // Build EDI SKU index: styleCode → normalizedColorName → [sku rows]
  // Include ALL SKUs (main + accessories) — unlike the original script
  const allSkusRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  const ediSkuIndex = {};
  for (const sku of allSkusRes.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 3) continue;
    const styleCode = parts[1];
    if (!ediSkuIndex[styleCode]) ediSkuIndex[styleCode] = {};
    const normColor = (sku.variant_name || '').toLowerCase().trim();
    if (!ediSkuIndex[styleCode][normColor]) ediSkuIndex[styleCode][normColor] = [];
    ediSkuIndex[styleCode][normColor].push(sku);
  }
  console.log(`Pre-loaded ${allSkusRes.rows.length} EDI SKUs for matching (main + accessories)\n`);

  // Clear stale SKU-level primary/alternate images for EF (so we reassign cleanly)
  if (!DRY_RUN) {
    const cleared = await pool.query(`
      DELETE FROM media_assets ma
      USING skus s, products p
      WHERE ma.sku_id = s.id
        AND s.product_id = p.id
        AND p.vendor_id = $1
        AND ma.asset_type IN ('primary', 'alternate')
        AND ma.sku_id IS NOT NULL
    `, [vendorId]);
    console.log(`Cleared ${cleared.rowCount} stale SKU-level primary/alternate images`);
  }

  // Pre-cache attribute IDs
  const attrResult = await pool.query('SELECT id, slug FROM attributes');
  const attrExists = new Set(attrResult.rows.map(r => r.slug));

  let imagesCreated = 0, attrsSet = 0, skusMatched = 0, skusUnmatched = 0;

  for (const [productSku, prod] of csvProducts) {
    const styleSkus = ediSkuIndex[productSku] || {};

    // Track room scenes for product-level lifestyle images
    const allRoomScenes = new Set();
    // We need to know which product_id to use for lifestyle images — gather from matched SKUs
    const productIds = new Set();

    for (const [colorName, colorData] of prod.colors) {
      const normColor = colorName.toLowerCase().trim();
      const matchedSkus = styleSkus[normColor] || [];

      if (matchedSkus.length === 0) {
        skusUnmatched++;
        for (const rsUrl of colorData.roomScenes) allRoomScenes.add(rsUrl);
        continue;
      }

      skusMatched += matchedSkus.length;

      for (const sku of matchedSkus) {
        productIds.add(sku.product_id);

        if (DRY_RUN) {
          if (colorData.swatches.length > 0) {
            console.log(`  [DRY] Would assign ${colorData.swatches.length} swatch(es) to SKU ${sku.vendor_sku} (${sku.variant_name})`);
          }
          continue;
        }

        // Swatch → SKU-level primary/alternate
        for (let i = 0; i < colorData.swatches.length; i++) {
          await upsertMediaAsset({
            product_id: sku.product_id,
            sku_id: sku.id,
            asset_type: i === 0 ? 'primary' : 'alternate',
            url: colorData.swatches[i],
            sort_order: i,
          });
          imagesCreated++;
        }

        // Attributes
        if (attrExists.has('color')) { await setAttr(sku.id, 'color', colorName); attrsSet++; }
        if (prod.construction && attrExists.has('construction')) { await setAttr(sku.id, 'construction', prod.construction); attrsSet++; }
        if (prod.backing && attrExists.has('material')) { await setAttr(sku.id, 'material', prod.backing); attrsSet++; }
        if (prod.fiberBrand && attrExists.has('fiber_brand')) { await setAttr(sku.id, 'fiber_brand', prod.fiberBrand); attrsSet++; }
        if (prod.finish && attrExists.has('finish')) { await setAttr(sku.id, 'finish', prod.finish); attrsSet++; }
        if (prod.shade && attrExists.has('shade')) { await setAttr(sku.id, 'shade', prod.shade); attrsSet++; }
        if (prod.installMethod && attrExists.has('installation_method')) { await setAttr(sku.id, 'installation_method', prod.installMethod); attrsSet++; }
        if (prod.collection && attrExists.has('collection')) { await setAttr(sku.id, 'collection', prod.collection); attrsSet++; }
      }

      for (const rsUrl of colorData.roomScenes) allRoomScenes.add(rsUrl);
    }

    // Product-level lifestyle images (deduplicated room scenes)
    if (allRoomScenes.size > 0 && productIds.size > 0) {
      // Apply lifestyle images to ALL product_ids that matched under this style code
      for (const pid of productIds) {
        let rsIndex = 0;
        for (const rsUrl of allRoomScenes) {
          if (DRY_RUN) {
            if (rsIndex === 0) console.log(`  [DRY] Would assign ${allRoomScenes.size} room scene(s) to product ${pid}`);
          } else {
            await upsertMediaAsset({
              product_id: pid,
              sku_id: null,
              asset_type: 'lifestyle',
              url: rsUrl,
              sort_order: rsIndex,
            });
            imagesCreated++;
          }
          rsIndex++;
        }
      }
    }

    const matchCount = Object.values(styleSkus).flat().length;
    if (matchCount > 0) {
      console.log(`  ${prod.name} (${productSku}) — ${prod.colors.size} colors, ${matchCount} EDI SKUs matched`);
    }
  }

  console.log(`\nPhase 2 Summary:`);
  console.log(`  SKUs matched:   ${skusMatched}`);
  console.log(`  Colors unmatched: ${skusUnmatched}`);
  console.log(`  Images upserted: ${imagesCreated}`);
  console.log(`  Attrs set:       ${attrsSet}`);

  return { imagesCreated, attrsSet, skusMatched, skusUnmatched };
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Cross-product accessory linking
// ══════════════════════════════════════════════════════════════════════════════

async function phase3_accessoryLinking(vendorId, styleColorMap) {
  console.log('\n' + '═'.repeat(60));
  console.log('PHASE 3: Cross-Product Accessory Linking');
  console.log('═'.repeat(60));

  // Clear existing EF records from sku_accessories
  if (!DRY_RUN) {
    const cleared = await pool.query(`
      DELETE FROM sku_accessories sa
      USING skus s, products p
      WHERE sa.parent_sku_id = s.id
        AND s.product_id = p.id
        AND p.vendor_id = $1
    `, [vendorId]);
    console.log(`Cleared ${cleared.rowCount} existing EF accessory links`);

    // Clear EF accessory_label values
    const labelCleared = await pool.query(`
      UPDATE skus s SET accessory_label = NULL
      FROM products p
      WHERE s.product_id = p.id
        AND p.vendor_id = $1
        AND s.accessory_label IS NOT NULL
    `, [vendorId]);
    console.log(`Cleared ${labelCleared.rowCount} existing EF accessory labels`);
  }

  const linkBatch = []; // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]
  const variantTypeBatch = []; // [sku_id] — SKUs that need variant_type = 'accessory', sell_by = 'unit'

  let cellsWithLinks = 0;

  for (const styleCode of Object.keys(styleColorMap)) {
    for (const colorCode of Object.keys(styleColorMap[styleCode])) {
      const cell = styleColorMap[styleCode][colorCode];
      if (cell.mainSkus.length === 0 || cell.accessorySkus.length === 0) continue;

      cellsWithLinks++;

      for (const mainSku of cell.mainSkus) {
        for (const accSku of cell.accessorySkus) {
          const accLabel = deriveAccessoryLabel(accSku.suffix, accSku.product_name);
          const sortOrder = ACCESSORY_SORT_ORDER[accLabel] || 99;

          linkBatch.push([mainSku.id, accSku.id, sortOrder]);
        }
      }

      // Labels and variant_type for each accessory in this cell
      for (const accSku of cell.accessorySkus) {
        const accLabel = deriveAccessoryLabel(accSku.suffix, accSku.product_name);
        labelBatch.push([accSku.id, accLabel]);

        if (accSku.variant_type !== 'accessory' || accSku.sell_by !== 'unit') {
          variantTypeBatch.push(accSku.id);
        }
      }
    }
  }

  console.log(`\nPhase 3 Summary:`);
  console.log(`  Style+color cells with both main & accessory: ${cellsWithLinks}`);
  console.log(`  Links to insert:       ${linkBatch.length}`);
  console.log(`  Labels to set:         ${labelBatch.length}`);
  console.log(`  SKUs needing variant_type fix: ${variantTypeBatch.length}`);

  if (DRY_RUN) {
    // Show sample
    console.log('\n  Sample links (first 15):');
    for (const [parent, acc, sort] of linkBatch.slice(0, 15)) {
      const pSku = findVskuById(parent, Object.values(styleColorMap));
      const aSku = findVskuById(acc, Object.values(styleColorMap));
      console.log(`    ${pSku || parent} → ${aSku || acc} (sort: ${sort})`);
    }
    return { linksCreated: linkBatch.length, labelsSet: labelBatch.length };
  }

  // Write links in batches
  console.log('\nWriting sku_accessories links...');
  const BATCH_SIZE = 500;
  let written = 0;
  for (let i = 0; i < linkBatch.length; i += BATCH_SIZE) {
    const batch = linkBatch.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    for (let j = 0; j < batch.length; j++) {
      const offset = j * 3;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      params.push(batch[j][0], batch[j][1], batch[j][2]);
    }
    await pool.query(`
      INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
      VALUES ${values.join(', ')}
      ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `, params);
    written += batch.length;
    if (written % 2000 === 0 || written === linkBatch.length) {
      console.log(`  ${written}/${linkBatch.length} links written`);
    }
  }

  // Write labels (deduplicated)
  console.log('Writing accessory_label values...');
  const labelMap = new Map();
  for (const [skuId, label] of labelBatch) {
    labelMap.set(skuId, label);
  }
  const dedupedLabels = Array.from(labelMap.entries());

  for (let i = 0; i < dedupedLabels.length; i += BATCH_SIZE) {
    const batch = dedupedLabels.slice(i, i + BATCH_SIZE);
    const ids = batch.map(b => b[0]);
    const caseLines = batch.map((b, j) => `WHEN id = $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ');
    const params = [];
    for (const [skuId, label] of batch) {
      params.push(skuId, label);
    }
    await pool.query(`
      UPDATE skus SET accessory_label = CASE ${caseLines} END, updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($${params.length + 1})
    `, [...params, ids]);
  }
  console.log(`  ${dedupedLabels.length} labels written`);

  // Fix variant_type and sell_by
  if (variantTypeBatch.length > 0) {
    console.log(`Setting variant_type='accessory' and sell_by='unit' on ${variantTypeBatch.length} SKUs...`);
    for (let i = 0; i < variantTypeBatch.length; i += BATCH_SIZE) {
      const batch = variantTypeBatch.slice(i, i + BATCH_SIZE);
      await pool.query(`
        UPDATE skus SET variant_type = 'accessory', sell_by = 'unit', updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
      `, [batch]);
    }
  }

  return { linksCreated: linkBatch.length, labelsSet: dedupedLabels.length };
}

/** Helper to find vendor_sku by ID for dry-run logging */
function findVskuById(id, colorMaps) {
  for (const colorMap of colorMaps) {
    for (const cell of Object.values(colorMap)) {
      for (const s of [...cell.mainSkus, ...cell.accessorySkus]) {
        if (s.id === id) return s.vendor_sku;
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Activate draft products
// ══════════════════════════════════════════════════════════════════════════════

async function phase4_activateDrafts(vendorId) {
  console.log('\n' + '═'.repeat(60));
  console.log('PHASE 4: Activate Draft Products');
  console.log('═'.repeat(60));

  // Count drafts before
  const beforeRes = await pool.query(`
    SELECT COUNT(*) FROM products
    WHERE vendor_id = $1 AND status = 'draft'
  `, [vendorId]);
  const draftsBefore = parseInt(beforeRes.rows[0].count);
  console.log(`Draft products before: ${draftsBefore}`);

  if (draftsBefore === 0) {
    console.log('No drafts to activate.');
    return { activated: 0, draftsBefore: 0 };
  }

  // Find drafts eligible for activation:
  // Must have pricing AND at least one image (product-level or SKU-level)
  const eligibleRes = await pool.query(`
    SELECT p.id, p.name
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND EXISTS (
        SELECT 1 FROM skus s
        JOIN pricing pr ON pr.sku_id = s.id
        WHERE s.product_id = p.id
      )
      AND (
        EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary' AND ma.sku_id IS NULL)
        OR EXISTS (
          SELECT 1 FROM media_assets ma
          JOIN skus s ON s.id = ma.sku_id
          WHERE s.product_id = p.id AND ma.asset_type = 'primary'
        )
        OR EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'lifestyle')
      )
  `, [vendorId]);

  console.log(`Eligible for activation: ${eligibleRes.rows.length}`);

  if (DRY_RUN) {
    for (const row of eligibleRes.rows.slice(0, 20)) {
      console.log(`  [DRY] Would activate: ${row.name}`);
    }
    if (eligibleRes.rows.length > 20) {
      console.log(`  ... and ${eligibleRes.rows.length - 20} more`);
    }
    return { activated: eligibleRes.rows.length, draftsBefore };
  }

  if (eligibleRes.rows.length > 0) {
    const ids = eligibleRes.rows.map(r => r.id);
    await pool.query(`
      UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1)
    `, [ids]);

    // Refresh search vectors
    for (const id of ids) {
      pool.query('SELECT refresh_search_vectors($1)', [id]).catch(() => {});
    }
  }

  const afterRes = await pool.query(`
    SELECT COUNT(*) FROM products
    WHERE vendor_id = $1 AND status = 'draft'
  `, [vendorId]);
  const draftsAfter = parseInt(afterRes.rows[0].count);

  console.log(`Activated: ${eligibleRes.rows.length} products`);
  console.log(`Drafts remaining: ${draftsAfter}`);

  return { activated: eligibleRes.rows.length, draftsBefore, draftsAfter };
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`enrich-ef.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Resolve vendor
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    console.error(`Vendor '${VENDOR_CODE}' not found`);
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

  // Phase 1: Build product map
  const styleColorMap = await phase1_buildProductMap(vendorId);

  // Phase 2: Image assignment from CSV
  const imgStats = await phase2_imageAssignment(vendorId);

  // Phase 3: Cross-product accessory linking
  const accStats = await phase3_accessoryLinking(vendorId, styleColorMap);

  // Phase 4: Activate drafts
  const draftStats = await phase4_activateDrafts(vendorId);

  // Final summary
  console.log('\n' + '═'.repeat(60));
  console.log('FINAL SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Images upserted:       ${imgStats.imagesCreated}`);
  console.log(`  SKUs matched to CSV:   ${imgStats.skusMatched}`);
  console.log(`  Attrs set:             ${imgStats.attrsSet}`);
  console.log(`  Accessory links:       ${accStats.linksCreated}`);
  console.log(`  Accessory labels:      ${accStats.labelsSet}`);
  console.log(`  Products activated:    ${draftStats.activated}`);
  if (DRY_RUN) {
    console.log('\n  *** DRY RUN — no changes written ***');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
