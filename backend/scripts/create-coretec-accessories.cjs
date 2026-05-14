/**
 * create-coretec-accessories.cjs
 *
 * Creates missing COREtec transition accessory SKUs for companion codes
 * that use the numeric 01V/02V/03Z/04V format.
 *
 * Code → Type mapping (confirmed via retailer sites):
 * 01V02/04/06/09/19/20 = Baby Threshold (End Cap)
 * 01V27/29/31/35/46    = Quarter Round
 * 01V52/54/56/59/70    = Reducer
 * 01V76/78/80/83/95    = Stair Cap (Overlap Stairnose)
 * 02V01/04/06/10/17    = Flush Stair Nose
 * 02V24/26/28/37-50/62 = T-Molding
 * 03ZSQ                = Square Stair Tread
 * 03Z70                = Stair Tread
 * 04V48                = Quarter Round (Pro Enhanced 7″ specific)
 * 04V50                = Stair Cap (Pro Enhanced 7″ specific)
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Type definitions with pricing (from existing Shaw/COREtec accessories in DB)
const ACCESSORY_TYPES = {
  'baby_threshold': {
    label: 'Baby Threshold',
    productName: 'Baby Threshold COREtec',
    retail: 115.92,
    cost: 57.96,
    prefixes: ['01V02','01V04','01V06','01V09','01V19','01V20'],
  },
  'quarter_round': {
    label: 'Quarter Round',
    productName: 'Quarter Round COREtec',
    retail: 52.36,
    cost: 26.18,
    prefixes: ['01V27','01V29','01V31','01V35','01V46','04V48'],
  },
  'reducer': {
    label: 'Reducer',
    productName: 'Reducer COREtec',
    retail: 96.50,
    cost: 48.25,
    prefixes: ['01V52','01V54','01V56','01V59','01V70'],
  },
  'stair_cap': {
    label: 'Stair Cap',
    productName: 'Stair Cap COREtec',
    retail: 147.28,
    cost: 73.64,
    prefixes: ['01V76','01V78','01V80','01V83','01V95','04V50'],
  },
  'flush_stair_nose': {
    label: 'Flush Stairnose',
    productName: 'Flush Stair Nose COREtec',
    retail: 154.68,
    cost: 77.34,
    prefixes: ['02V01','02V04','02V06','02V10','02V17'],
  },
  't_molding': {
    label: 'T-Molding',
    productName: 'T-Molding COREtec',
    retail: 94.60,
    cost: 47.30,
    prefixes: ['02V24','02V26','02V28','02V37','02V38','02V39','02V40','02V41','02V42','02V43','02V44','02V45','02V46','02V47','02V48','02V49','02V50','02V62'],
  },
  'square_stair_tread': {
    label: 'Square Stair Tread',
    productName: 'Square Stair Tread COREtec',
    retail: 192.94,
    cost: 96.47,
    prefixes: ['03ZSQ'],
  },
  'stair_tread': {
    label: 'Stair Tread',
    productName: 'Stair Tread COREtec',
    retail: 192.94,
    cost: 96.47,
    prefixes: ['03Z70'],
  },
};

// Build reverse lookup: prefix → type
const PREFIX_TO_TYPE = {};
for (const [typeKey, def] of Object.entries(ACCESSORY_TYPES)) {
  for (const prefix of def.prefixes) {
    PREFIX_TO_TYPE[prefix] = typeKey;
  }
}

function classifyCode(code) {
  // Try exact 5-char prefix first (e.g., 03ZSQ, 03Z70, 04V48, 04V50)
  const p5 = code.substring(0, 5);
  if (PREFIX_TO_TYPE[p5]) return PREFIX_TO_TYPE[p5];
  // Try 4-char prefix (e.g., 01V02 from "01V0200570")
  const p4 = code.substring(0, 4);
  // The format is: PREFIX(4-5 chars) + COLOR_CODE(5 digits)
  // For 01V/02V: it's "01V" + 2-digit type + 5-digit color = 10 chars
  // So prefix is first 5 chars: "01V02", "02V24", etc.
  if (PREFIX_TO_TYPE[p5]) return PREFIX_TO_TYPE[p5];
  // For 03Z70: "03Z70" + 5-digit color
  // For 03ZSQ: "03ZSQ" + 5-digit color
  return null;
}

function getColorCode(code) {
  // Color code is always the last 5 digits
  return code.slice(-5);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Get Shaw vendor ID
  const vendorRes = await pool.query(`SELECT id FROM vendors WHERE name ILIKE '%shaw%' LIMIT 1`);
  if (vendorRes.rows.length === 0) { console.error('Shaw vendor not found'); process.exit(1); }
  const shawVendorId = vendorRes.rows[0].id;

  // Get all unresolved companion codes for LV products
  const unresolved = await pool.query(`
    WITH lv_no_acc AS (
      SELECT s.id as sku_id, s.vendor_sku, s.variant_name, p.id as product_id, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'active' AND v.name ILIKE '%shaw%' AND c.name = 'Luxury Vinyl'
        AND COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim')
        AND s.is_sample = false
        AND NOT EXISTS (SELECT 1 FROM sku_accessories sa WHERE sa.parent_sku_id = s.id)
    )
    SELECT la.sku_id, la.vendor_sku, la.variant_name, la.product_id, la.product_name,
           sa.value as companion_codes
    FROM lv_no_acc la
    JOIN sku_attributes sa ON sa.sku_id = la.sku_id
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'companion_skus'
  `);

  console.log(`Found ${unresolved.rows.length} LV SKUs with unresolved companion codes`);

  // Collect all codes that need to be created
  const codesToCreate = new Map(); // code → { type, colorCode, parentSkus: [{sku_id, variant_name}] }
  let skipped = 0;

  for (const row of unresolved.rows) {
    const codes = row.companion_codes.split(',').map(c => c.trim());
    for (const code of codes) {
      // Skip sample codes (SQ*, BT*)
      if (/^(SQ|BT)/i.test(code)) continue;

      const typeKey = classifyCode(code);
      if (!typeKey) {
        skipped++;
        continue;
      }

      if (!codesToCreate.has(code)) {
        codesToCreate.set(code, {
          type: typeKey,
          colorCode: getColorCode(code),
          parentSkus: [],
        });
      }
      codesToCreate.get(code).parentSkus.push({
        sku_id: row.sku_id,
        variant_name: row.variant_name,
      });
    }
  }

  console.log(`Codes to create: ${codesToCreate.size} (skipped ${skipped} unclassifiable)`);

  // Check which codes already exist in DB (as vendor_sku or product name)
  const allCodes = [...codesToCreate.keys()];
  const existingRes = await pool.query(`
    SELECT vendor_sku FROM skus WHERE vendor_sku = ANY($1) AND status = 'active'
  `, [allCodes]);
  const existingSet = new Set(existingRes.rows.map(r => r.vendor_sku));

  // Filter out already-existing codes
  for (const code of existingSet) {
    codesToCreate.delete(code);
  }
  console.log(`After filtering existing: ${codesToCreate.size} new codes to create`);

  // Group by type and get or create product records
  const typeGroups = {};
  for (const [code, info] of codesToCreate.entries()) {
    if (!typeGroups[info.type]) typeGroups[info.type] = [];
    typeGroups[info.type].push({ code, ...info });
  }

  console.log('\nBy type:');
  for (const [typeKey, items] of Object.entries(typeGroups)) {
    console.log(`  ${ACCESSORY_TYPES[typeKey].label}: ${items.length} SKUs`);
  }

  if (dryRun) {
    console.log('\nDry run — no changes applied.');
    // Show sample codes
    for (const [typeKey, items] of Object.entries(typeGroups)) {
      console.log(`\n  ${ACCESSORY_TYPES[typeKey].label} samples:`);
      for (const item of items.slice(0, 3)) {
        console.log(`    ${item.code} → ${item.parentSkus[0].variant_name}`);
      }
    }
    await pool.end();
    return;
  }

  // Get LV category ID
  const catRes = await pool.query(`SELECT id FROM categories WHERE slug = 'luxury-vinyl' OR name = 'Luxury Vinyl' LIMIT 1`);
  const lvCategoryId = catRes.rows[0]?.id;

  // Create or find product for each type
  const productIds = {};
  for (const [typeKey, def] of Object.entries(ACCESSORY_TYPES)) {
    if (!typeGroups[typeKey]) continue;

    // Check if product already exists
    let prodRes = await pool.query(`
      SELECT id FROM products WHERE name = $1 AND vendor_id = $2
    `, [def.productName, shawVendorId]);

    if (prodRes.rows.length > 0) {
      productIds[typeKey] = prodRes.rows[0].id;
      console.log(`  Found existing product: ${def.productName} (${productIds[typeKey]})`);
    } else {
      // Create product
      prodRes = await pool.query(`
        INSERT INTO products (id, name, vendor_id, category_id, status, collection, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'active', 'COREtec Accessories', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
      `, [def.productName, shawVendorId, lvCategoryId]);
      productIds[typeKey] = prodRes.rows[0].id;
      console.log(`  Created product: ${def.productName} (${productIds[typeKey]})`);
    }
  }

  // Create SKUs in batch
  let totalCreated = 0;
  for (const [typeKey, items] of Object.entries(typeGroups)) {
    const def = ACCESSORY_TYPES[typeKey];
    const productId = productIds[typeKey];

    for (const item of items) {
      // Use the first parent's variant_name as the color
      const variantName = item.parentSkus[0].variant_name;
      const internalSku = `SHAW-${item.code}`;

      try {
        const skuRes = await pool.query(`
          INSERT INTO skus (id, product_id, variant_name, vendor_sku, internal_sku, sell_by, variant_type, status, is_sample, accessory_label, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active', false, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (internal_sku) DO NOTHING
          RETURNING id
        `, [productId, variantName, item.code, internalSku, def.label]);

        if (skuRes.rows.length > 0) {
          const newSkuId = skuRes.rows[0].id;

          // Add pricing
          await pool.query(`
            INSERT INTO pricing (sku_id, retail_price, cost, price_basis, created_at)
            VALUES ($1, $2, $3, 'per_unit', CURRENT_TIMESTAMP)
            ON CONFLICT (sku_id) DO NOTHING
          `, [newSkuId, def.retail, def.cost]);

          totalCreated++;
        }
      } catch (err) {
        if (!err.message.includes('duplicate')) {
          console.error(`  Error creating ${item.code}: ${err.message}`);
        }
      }
    }
  }

  console.log(`\nCreated ${totalCreated} new accessory SKUs`);

  // Now rebuild the sku_accessories links for the affected parent SKUs
  console.log('\nRebuilding accessory links...');

  // Get all the newly created SKUs by vendor_sku
  const newSkusRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.accessory_label
    FROM skus s
    WHERE s.vendor_sku = ANY($1) AND s.status = 'active'
  `, [allCodes]);

  const skuByCode = {};
  for (const row of newSkusRes.rows) {
    skuByCode[row.vendor_sku] = row;
  }

  // Link parent SKUs to their accessories
  let linksCreated = 0;
  for (const row of unresolved.rows) {
    const codes = row.companion_codes.split(',').map(c => c.trim());
    let sortOrder = 0;

    for (const code of codes) {
      if (/^(SQ|BT)/i.test(code)) continue;

      const accSku = skuByCode[code];
      if (!accSku) continue;

      try {
        await pool.query(`
          INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
          VALUES ($1, $2, $3)
          ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
        `, [row.sku_id, accSku.id, sortOrder]);
        linksCreated++;
        sortOrder++;
      } catch (err) {
        // ignore duplicates
      }
    }
  }

  console.log(`Created ${linksCreated} accessory links`);

  // Final stats
  const coverage = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM sku_accessories sa WHERE sa.parent_sku_id = s.id)) as with_acc
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE s.status = 'active' AND v.name ILIKE '%shaw%' AND c.name = 'Luxury Vinyl'
      AND COALESCE(s.variant_type, '') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim')
      AND s.is_sample = false
  `);

  const total = parseInt(coverage.rows[0].total);
  const withAcc = parseInt(coverage.rows[0].with_acc);
  console.log(`\nFinal LV coverage: ${withAcc}/${total} (${(withAcc/total*100).toFixed(1)}%)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
