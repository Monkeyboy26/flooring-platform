#!/usr/bin/env node
/**
 * create-missing-shaw-accessories.cjs
 *
 * Creates missing Shaw accessory SKUs for unresolved companion codes.
 * Maps known prefix patterns to accessory product types, derives variant names
 * from parent products, and inserts pricing.
 *
 * Usage:
 *   node backend/scripts/create-missing-shaw-accessories.cjs --dry-run
 *   node backend/scripts/create-missing-shaw-accessories.cjs
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ── Prefix → product mapping ──────────────────────────────────────────
// Each entry: [regex, { productName, label, retail, cost }]
// productName is used to find the existing product ID
const PREFIX_MAP = [
  // Hardwood T-Molding
  [/^TMH78/i,  { productName: 'T Molding', label: 'T-Molding', retail: 94.60, cost: 47.30 }],
  [/^AATMH/i,  { productName: 'T Molding', label: 'T-Molding', retail: 94.60, cost: 47.30 }],
  [/^TMHS/i,   { productName: 'T Molding', label: 'T-Molding', retail: 94.60, cost: 47.30 }],

  // Hardwood Quarter Round
  [/^QTR96/i,  { productName: 'Quarter Rnd EVP', label: 'Quarter Round', retail: 49.19, cost: 24.60 }],
  [/^AQTR4/i,  { productName: 'Quarter Rnd EVP', label: 'Quarter Round', retail: 49.19, cost: 24.60 }],
  [/^AAQTR/i,  { productName: 'Quarter Rnd EVP', label: 'Quarter Round', retail: 49.19, cost: 24.60 }],

  // Hardwood Threshold
  [/^SCH38/i,  { productName: 'Threshold', label: 'Threshold', retail: 103.00, cost: 51.50 }],
  [/^ATHH2/i,  { productName: 'Threshold', label: 'Threshold', retail: 103.00, cost: 51.50 }],

  // Hardwood Reducer
  [/^ARH12/i,  { productName: 'Flush Reducer Handscraped 3 8', label: 'Reducer', retail: 98.62, cost: 49.31 }],

  // Hardwood Stairnose
  [/^ASH12/i,  { productName: 'Flush Stairnose Handscraped 3 8', label: 'Flush Stairnose', retail: 115.88, cost: 57.94 }],

  // Hardwood Stair Riser
  [/^SRH38/i,  { productName: 'Round Stair Tread', label: 'Stair Tread', retail: 192.94, cost: 96.47 }],

  // LVT Quarter Round
  [/^QTRHS/i,  { productName: 'Quarter Rnd LVT', label: 'Quarter Round', retail: 52.36, cost: 26.18 }],
  [/^PCQTR/i,  { productName: 'Quarter Rnd LVT', label: 'Quarter Round', retail: 52.36, cost: 26.18 }],
  [/^VSQTR/i,  { productName: 'Quarter Rnd LVT', label: 'Quarter Round', retail: 52.36, cost: 26.18 }],

  // LVT T-Molding
  [/^VSTMD/i,  { productName: 'T Molding WPC', label: 'T-Molding', retail: 89.02, cost: 44.51 }],

  // LVT Stairnose
  [/^VSSN/i,   { productName: 'Stairnose WPC', label: 'Stairnose', retail: 109.26, cost: 54.63 }],
  [/^VFSN/i,   { productName: 'Flush Stairnose', label: 'Flush Stairnose', retail: 154.68, cost: 77.34 }],
  [/^SQSN/i,   { productName: 'Stairnose', label: 'Stairnose', retail: 124.10, cost: 62.05 }],

  // HS-series accessories
  [/^R10HS/i,  { productName: 'Flush Reducer', label: 'Reducer', retail: 96.50, cost: 48.25 }],
  [/^RD3HS/i,  { productName: 'Flush Reducer', label: 'Reducer', retail: 96.50, cost: 48.25 }],
  [/^T10HS/i,  { productName: 'T Molding', label: 'T-Molding', retail: 94.60, cost: 47.30 }],
  [/^TR2HS/i,  { productName: 'Threshold', label: 'Threshold', retail: 103.00, cost: 51.50 }],
  [/^F12HS/i,  { productName: 'Flush Stairnose', label: 'Flush Stairnose', retail: 154.68, cost: 77.34 }],
  [/^B10HS/i,  { productName: 'Baby Threshold', label: 'Baby Threshold', retail: 111.34, cost: 55.67 }],

  // Overlap Stairnose
  [/^SOSS/i,   { productName: 'Overlap Stairnose Handscraped 3 8', label: 'Overlap Stairnose', retail: 107.88, cost: 53.94 }],

  // Sample Squares/Boards (COREtec + others)
  [/^SQ7CT/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQ4CT/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQ5CT/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQ6CT/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQ1HS/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQ7HS/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^SQTHS/i,  { productName: null, label: 'Sample Square', retail: 3.50, cost: 1.75, isSample: true }],
  [/^BT7CT/i,  { productName: null, label: 'Sample Board', retail: 5.00, cost: 2.50, isSample: true }],
  [/^BT3HU/i,  { productName: null, label: 'Sample Board', retail: 5.00, cost: 2.50, isSample: true }],

  // LVT misc
  [/^VSUN/i,   { productName: null, label: null, retail: null, cost: null, skip: true }], // unknown
  [/^VSQT\d/i, { productName: 'Quarter Rnd LVT', label: 'Quarter Round', retail: 52.36, cost: 26.18 }],

  // Casino tile trim
  [/^CS24F/i,  { productName: null, label: 'Bullnose', retail: 12.00, cost: 6.00, isTileTrim: true }],
  [/^CS39V/i,  { productName: null, label: 'Pencil Liner', retail: 8.00, cost: 4.00, isTileTrim: true }],
  [/^CS40Z/i,  { productName: null, label: 'Quarter Round Trim', retail: 10.00, cost: 5.00, isTileTrim: true }],
  [/^CS41Z/i,  { productName: null, label: 'Chair Rail', retail: 12.00, cost: 6.00, isTileTrim: true }],
  [/^CS90Z/i,  { productName: null, label: 'Mosaic', retail: 15.00, cost: 7.50, isTileTrim: true }],
  [/^CS91Z/i,  { productName: null, label: 'Mosaic', retail: 15.00, cost: 7.50, isTileTrim: true }],
];

async function main() {
  const client = await pool.connect();
  try {
    console.log('\n' + '='.repeat(60));
    console.log(`  SHAW MISSING ACCESSORY CREATION ${DRY_RUN ? '(DRY RUN)' : ''}`);
    console.log('='.repeat(60) + '\n');

    // Step 1: Collect all unresolved companion codes with parent info
    console.log('Phase 1: Collecting unresolved companion codes...');
    const { rows: unresolvedRows } = await client.query(`
      WITH companion_data AS (
        SELECT s.id as parent_id, p.name as parent_product, p.vendor_id,
               s.variant_name, s.vendor_sku as parent_vsku,
               upper(trim(unnest(string_to_array(ska.value, ',')))) as code
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        JOIN sku_attributes ska ON ska.sku_id = s.id
        JOIN attributes a ON a.id = ska.attribute_id
        WHERE v.name ILIKE '%shaw%'
          AND a.slug = 'companion_skus'
          AND s.variant_type IS DISTINCT FROM 'accessory'
      )
      SELECT DISTINCT cd.code, cd.variant_name, cd.vendor_id, cd.parent_product
      FROM companion_data cd
      LEFT JOIN skus s ON upper(s.vendor_sku) = cd.code
      LEFT JOIN products p ON upper(p.name) = cd.code
      WHERE s.id IS NULL AND p.id IS NULL
      ORDER BY cd.code
    `);

    console.log(`  Found ${unresolvedRows.length} unresolved companion code references`);

    // Deduplicate by code (same code may appear with different parents)
    const codeMap = new Map(); // code → { variant_name, vendor_id, parent_product }
    for (const row of unresolvedRows) {
      if (!codeMap.has(row.code)) {
        codeMap.set(row.code, {
          variant_name: row.variant_name,
          vendor_id: row.vendor_id,
          parent_product: row.parent_product,
        });
      }
    }
    console.log(`  Unique companion codes: ${codeMap.size}`);

    // Get Shaw vendor ID (needed for scoping product lookups)
    const { rows: [shawVendor] } = await client.query(`
      SELECT id FROM vendors WHERE name ILIKE '%shaw%' LIMIT 1
    `);
    const shawVendorId = shawVendor?.id;

    // Step 2: Look up target product IDs
    console.log('\nPhase 2: Resolving target products...');
    const productNames = [...new Set(
      PREFIX_MAP.filter(([, cfg]) => cfg.productName).map(([, cfg]) => cfg.productName)
    )];
    const { rows: productRows } = await client.query(`
      SELECT id, name FROM products WHERE name = ANY($1) AND vendor_id = $2
    `, [productNames, shawVendorId]);

    const productIdMap = {};
    for (const r of productRows) {
      // Handle duplicates — pick the one with most SKUs (more established)
      if (!productIdMap[r.name]) productIdMap[r.name] = r.id;
    }
    console.log(`  Resolved ${Object.keys(productIdMap).length} target products`);

    // For sample products, find existing sample product IDs by prefix
    const { rows: sampleProducts } = await client.query(`
      SELECT p.id, p.name, p.vendor_id FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE s.vendor_sku ~ '^(SQ7CT|SQ4CT|BT7CT|BT3HU)'
        AND p.vendor_id = $1
      GROUP BY p.id, p.name, p.vendor_id
    `, [shawVendorId]);
    const sampleProductMap = {};
    for (const r of sampleProducts) {
      sampleProductMap[r.name.toUpperCase()] = r.id;
    }

    // Get category ID for Installation & Sundries
    const { rows: [sundCat] } = await client.query(`
      SELECT id FROM categories WHERE name = 'Installation & Sundries' LIMIT 1
    `);
    const sundriesCatId = sundCat?.id;

    // Step 3: Create missing SKUs
    console.log('\nPhase 3: Creating missing accessory SKUs...');

    let skuInserts = [];
    let pricingInserts = [];
    let skipped = 0;
    let unmapped = 0;
    const prefixStats = {};

    for (const [code, info] of codeMap) {
      // Find matching prefix config
      let config = null;
      for (const [re, cfg] of PREFIX_MAP) {
        if (re.test(code)) {
          config = cfg;
          break;
        }
      }

      if (!config) {
        unmapped++;
        continue;
      }
      if (config.skip) {
        skipped++;
        continue;
      }

      // Find target product ID
      let productId = null;
      if (config.productName) {
        productId = productIdMap[config.productName];
      } else if (config.isSample) {
        // For samples, create under existing sample product or a new generic one
        // Match by prefix pattern to find existing product
        const prefix = code.match(/^[A-Z]+/)?.[0];
        if (prefix) {
          // Find product named like the prefix pattern
          const key = Object.keys(sampleProductMap).find(k =>
            k.toUpperCase().startsWith(prefix.toLowerCase().replace(/^sq/, 'Sq').replace(/^bt/, 'Bt'))
          );
          if (key) productId = sampleProductMap[key];
        }
      }

      // For tile trim and samples without existing product, we'll create under a generic product
      if (!productId && (config.isTileTrim || config.isSample)) {
        // Create SKU under a new or existing product based on the code prefix
        const codeLower = code.toLowerCase();
        // Look for product named after the code
        const { rows: existing } = await client.query(
          `SELECT p.id FROM products p WHERE upper(p.name) = $1 AND p.vendor_id = $2`, [code, shawVendorId]
        );
        if (existing.length > 0) {
          productId = existing[0].id;
        }
        // If still no product, skip tile trim (can't create without more info)
        if (!productId) {
          skipped++;
          continue;
        }
      }

      if (!productId) {
        skipped++;
        continue;
      }

      const skuId = crypto.randomUUID();
      const prefix = code.match(/^[A-Z]+/)?.[0] || code.slice(0, 4);
      if (!prefixStats[prefix]) prefixStats[prefix] = 0;
      prefixStats[prefix]++;

      skuInserts.push({
        id: skuId,
        product_id: productId,
        vendor_sku: code,
        internal_sku: `SHAW-${code}`,
        variant_name: info.variant_name,
        variant_type: 'accessory',
        sell_by: 'unit',
        accessory_label: config.label,
        status: 'active',
      });

      if (config.retail && config.cost) {
        pricingInserts.push({
          sku_id: skuId,
          retail_price: config.retail,
          cost: config.cost,
        });
      }
    }

    console.log(`  SKUs to create: ${skuInserts.length}`);
    console.log(`  Skipped (unknown/no-product): ${skipped}`);
    console.log(`  Unmapped prefixes: ${unmapped}`);
    console.log('\n  By prefix:');
    for (const [prefix, count] of Object.entries(prefixStats).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${prefix}: ${count}`);
    }

    if (DRY_RUN) {
      console.log('\n  Sample SKUs (first 10):');
      for (const s of skuInserts.slice(0, 10)) {
        console.log(`    ${s.vendor_sku} → ${s.accessory_label} | ${s.variant_name}`);
      }
      console.log(`\nDry run — no changes applied.`);
    } else {
      // Insert SKUs
      if (skuInserts.length > 0) {
        console.log('\n  Inserting SKUs...');
        const BATCH = 100;
        for (let i = 0; i < skuInserts.length; i += BATCH) {
          const batch = skuInserts.slice(i, i + BATCH);
          const values = [];
          const params = [];
          let paramIdx = 1;
          for (const s of batch) {
            values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
            params.push(s.id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type, s.sell_by, s.accessory_label, s.status);
          }
          await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, variant_type, sell_by, accessory_label, status)
            VALUES ${values.join(', ')}
            ON CONFLICT (id) DO NOTHING
          `, params);
        }
        console.log(`    Inserted up to ${skuInserts.length} SKUs`);
      }

      // Insert pricing
      if (pricingInserts.length > 0) {
        console.log('  Inserting pricing...');
        const BATCH = 100;
        for (let i = 0; i < pricingInserts.length; i += BATCH) {
          const batch = pricingInserts.slice(i, i + BATCH);
          const values = [];
          const params = [];
          let paramIdx = 1;
          for (const p of batch) {
            values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
            params.push(p.sku_id, p.retail_price, p.cost);
          }
          await client.query(`
            INSERT INTO pricing (sku_id, retail_price, cost)
            VALUES ${values.join(', ')}
          `, params);
        }
        console.log(`    Inserted up to ${pricingInserts.length} pricing rows`);
      }

      console.log('\nDone!');
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
