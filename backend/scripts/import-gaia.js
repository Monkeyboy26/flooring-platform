/**
 * Gaia Flooring — Full Vendor Import
 *
 * Source: Gaia Q-3-2025 Price List (Revised 05/20/2025) + website catalog
 * Three product lines: eTERRA (SPC), Nearwood (Laminate/Engineered/Hybrid)
 *
 * Prices are dealer/wholesale cost. Retail = cost × 2.
 *
 * Usage: docker compose exec api node scripts/import-gaia.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const CAT = {
  lvp:      '650e8400-e29b-41d4-a716-446655440031', // LVP (Plank)
  laminate: '650e8400-e29b-41d4-a716-446655440090', // Laminate
  eng:      '650e8400-e29b-41d4-a716-446655440021', // Engineered Hardwood
};

const ATTR = {
  color:   'd50e8400-e29b-41d4-a716-446655440001',
  size:    'd50e8400-e29b-41d4-a716-446655440004',
};

const MARKUP = 2.0;

// Accessory types and their prices per series
// [endcap, overlapNosing, quarterRound, reducer, stairNose, tMolding]
const ACC_TYPES = ['Endcap','Overlap Nosing','Quarter Round','Reducer','Stair Nose','T-Molding'];
const ACC_SUFFIXES = ['EC','ON','QR','RD','SN','TM'];

const COLLECTIONS = [
  // ─── eTERRA White Series (SPC) ───
  {
    name: 'eTERRA White Series', cat: 'lvp',
    desc: 'eSPC/SPC, 6.5mm, 7.2"x48", Waterproof',
    size: '6.5mm x 7.2" x 48"',
    sfBox: 19.23, sfPlt: 1153.80,
    accPrices: [19.00, 28.00, 14.00, 19.00, 37.00, 19.00],
    colors: [
      ['Alpaca','GA655701'],
      ['American Cherry','GA651011'],
      ['American Hickory','GA651115'],
      ['American Maple','GA650190'],
      ['American Walnut','GA658410'],
      ['Elk Horn','GA657508'],
      ['Grey Fox','GA652310'],
      ['Impala','GA652313'],
      ['River Shoal','GA652306'],
      ['Sand Dollar','GA652312'],
    ],
    costSqft: 2.39,
  },
  // ─── eTERRA Red Series (SPC) ───
  {
    name: 'eTERRA Red Series', cat: 'lvp',
    desc: 'eSPC/SPC, 8.0mm, 9.0"x60", Waterproof',
    size: '8.0mm x 9.0" x 60"',
    sfBox: 18.86, sfPlt: 980.72,
    accPrices: [19.00, 28.00, 14.00, 19.00, 37.00, 19.00],
    colors: [
      ['Calabria','GA805342'],
      ['Picchi','GA805314'],
      ['Riva','GA805310'],
      ['Sole','GA805311'],
      ['Torino','GA805313'],
      ['Torre','GA812601'],
      ['Villa','GA812608'],
      ['Volare','GA805343'],
    ],
    costSqft: 3.19,
  },
  // ─── eTERRA Red Series Herringbone (SPC) ───
  {
    name: 'eTERRA Red Herringbone', cat: 'lvp',
    desc: 'eSPC/SPC Herringbone, 8.0mm, 5.90"x28.3", Waterproof',
    size: '8.0mm x 5.90" x 28.3"',
    sfBox: 13.95, sfPlt: 1004.40,
    accPrices: [19.00, 28.00, 14.00, 19.00, 37.00, 19.00],
    colors: [
      ['Bella Sala','GA85310AB'],
      ['Dolce Luna','GA85311AB'],
      ['Nota Alta','GA85313AB'],
      ['Otto Mare','GA85314AB'],
    ],
    costSqft: 3.39,
  },
  // ─── eTERRA Black Series (SPC) ───
  {
    name: 'eTERRA Black Series', cat: 'lvp',
    desc: 'eSPC/SPC, 10.0mm, 9.05"x70.87", Waterproof, Premium',
    size: '10.0mm x 9.05" x 70.87"',
    sfBox: 17.81, sfPlt: 997.36,
    accPrices: [19.00, 28.00, 14.00, 19.00, 37.00, 19.00],
    colors: [
      ['Athena','GA10857'],
      ['Atticus','GA10856'],
      ['Cleo','GA10854'],
      ['Eyre','GA10858'],
      ['Joy','GA10855'],
      ['Matilda','GA22402'],
      ['Rhea','GA22401'],
      ['Sawyer','GA10859'],
    ],
    costSqft: 4.19,
  },
  // ─── Nearwood White Series (Laminate) ───
  {
    name: 'Nearwood White Series', cat: 'laminate',
    desc: 'Laminate, 12mm, 7.6"x59.6"',
    size: '12mm x 7.6" x 59.6"',
    sfBox: 18.88, sfPlt: 1132.80,
    accPrices: [23.00, 30.00, 19.00, 23.00, 40.00, 23.00],
    colors: [
      ['Natura Cherry','GA129342'],
      ['Natura Hickory','GA129351'],
      ['Natura Maple','GA129341'],
      ['Perennial','GA129372'],
      ['Sable','GA129373'],
      ['Sandhill','GA129371'],
    ],
    costSqft: 2.39,
  },
  // ─── Nearwood Red Series (Engineered) ───
  {
    name: 'Nearwood Red Series', cat: 'eng',
    desc: 'Engineered Hardwood, 15mm, 9.25"x72.27"',
    size: '15mm x 9.25" x 72.27"',
    sfBox: 27.84, sfPlt: 1113.60,
    accPrices: [23.00, 30.00, 19.00, 23.00, 40.00, 23.00],
    colors: [
      ['Amato','GA159335'],
      ['La Moda','GA159334'],
      ['Milan','GA159333'],
      ['Palermo','GA159331'],
      ['Urbano','GA159336'],
      ['Vista','GA159332'],
    ],
    costSqft: 2.99,
  },
  // ─── Nearwood White Series Wide Plank (Laminate) ───
  // Added from website catalog — wider plank (9.25") variant
  // TODO: Verify dealer cost from updated price list
  {
    name: 'Nearwood White Wide', cat: 'laminate',
    desc: 'Laminate Wide Plank, 12mm, 9.25"x59.6"',
    size: '12mm x 9.25" x 59.6"',
    sfBox: 19.16, sfPlt: 1149.60,
    accPrices: [23.00, 30.00, 19.00, 23.00, 40.00, 23.00],
    colors: [
      ['Seaside Mist','GA121522'],
      ['Haven','GA121527'],
      ['Driftwood','GA121521'],
      ['Stillwater','GA121526'],
      ['Burnished Trail','GA121528'],
    ],
    costSqft: 2.39, // estimated — same as White Series until confirmed
  },
  // ─── Nearwood Black Series (Hybrid Engineered) ───
  // Added from website catalog — premium hybrid wood line
  // TODO: Verify dealer cost from updated price list
  {
    name: 'Nearwood Black Series', cat: 'eng',
    desc: 'Hybrid Engineered Wood, 15.5mm, 9.05"x74.8"',
    size: '15.5mm x 9.05" x 74.8"',
    sfBox: 28.22, sfPlt: 1128.80,
    accPrices: [23.00, 30.00, 19.00, 23.00, 40.00, 23.00],
    colors: [
      ['Clara','GA152411'],
      ['Apollo','GA152410'],
      ['Hickory Reserve','GA152409'],
      ['Walnut Reserve','GA152404'],
      ['Varuna','GA152408'],
      ['Selene','GA152407'],
      ['Atlas','GA152406'],
      ['Helios','GA152405'],
    ],
    costSqft: 3.49, // estimated — premium over Red Series until confirmed
  },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Gaia Flooring', 'GAIA', 'https://gaiafloor.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Gaia Flooring (${vendorId})\n`);

    let totalProducts = 0, totalSkus = 0, totalAcc = 0, totalPricing = 0, totalPkg = 0;

    for (const col of COLLECTIONS) {
      let colSkus = 0, colAcc = 0;

      // One product per collection
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, col.name, col.name, CAT[col.cat]]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      for (const [color, sku] of col.colors) {
        // Flooring SKU (one per color)
        const internalSku = 'GAIA-' + sku;
        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET product_id = $1, variant_name = EXCLUDED.variant_name, sell_by = 'sqft', status = 'active'
          RETURNING id
        `, [productId, sku, internalSku, `${color} ${col.size}`]);
        const skuId = skuRes.rows[0].id;
        colSkus++;

        // Pricing
        const cost = col.costSqft.toFixed(2);
        const retail = (col.costSqft * MARKUP).toFixed(2);
        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
          VALUES ($1, $2, $3, 'sqft')
          ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
        `, [skuId, cost, retail]);
        totalPricing++;

        // Packaging
        const boxesPerPallet = Math.round(col.sfPlt / col.sfBox);
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box,
            boxes_per_pallet = EXCLUDED.boxes_per_pallet
        `, [skuId, col.sfBox, boxesPerPallet]);
        totalPkg++;

        // Attributes
        await upsertAttr(client, skuId, ATTR.color, color);
        await upsertAttr(client, skuId, ATTR.size, col.size);

        // Accessories (6 types per color)
        for (let i = 0; i < ACC_TYPES.length; i++) {
          const accVendorSku = sku + '-' + ACC_SUFFIXES[i];
          const accInternal = 'GAIA-' + accVendorSku;
          const accCost = col.accPrices[i];
          const accRetail = (accCost * MARKUP).toFixed(2);

          const accRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET product_id = $1, variant_name = EXCLUDED.variant_name, sell_by = 'unit',
                         variant_type = 'accessory', status = 'active'
            RETURNING id
          `, [productId, accVendorSku, accInternal, `${color} ${ACC_TYPES[i]}`]);
          const accSkuId = accRes.rows[0].id;
          colAcc++;

          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'unit')
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [accSkuId, accCost.toFixed(2), accRetail]);
          totalPricing++;
        }
      }

      totalSkus += colSkus;
      totalAcc += colAcc;
      console.log(`  ${col.name}: ${colSkus} flooring SKUs + ${colAcc} accessories`);
    }

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Flooring SKUs: ${totalSkus}`);
    console.log(`Accessory SKUs: ${totalAcc}`);
    console.log(`Total SKUs: ${totalSkus + totalAcc}`);
    console.log(`Pricing records: ${totalPricing}`);
    console.log(`Packaging records: ${totalPkg}`);

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
