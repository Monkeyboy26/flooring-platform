/**
 * Gaia Flooring — Full Vendor Import
 *
 * Source: Gaia Q-3-2025 Price List (Revised 05/20/2025)
 * Two product lines: eTERRA (SPC) and Nearwood (Laminate/Engineered)
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
  lvp:      '650e8400-e29b-41d4-a716-446655440030', // Luxury Vinyl (SPC)
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
      ['Alpaca','GA6S5701'],
      ['American Cherry','GA6S1011'],
      ['American Hickory','GA6S1115'],
      ['American Maple','GA6S0190'],
      ['American Walnut','GA6S8410'],
      ['Elk Horn','GA6S7508'],
      ['Grey Fox','GA6S2310'],
      ['Impala','GA6S2313'],
      ['River Shoal','GA6S2306'],
      ['Sand Dollar','GA6S2312'],
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
      ['Calabria','GA80S342'],
      ['Picchi','GA80S314'],
      ['Riva','GA80S310'],
      ['Sole','GA80S311'],
      ['Torino','GA80S313'],
      ['Torre','GA812601'],
      ['Villa','GA812608'],
      ['Volare','GA80S343'],
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
      ['Bella Sala','GA8S310AB'],
      ['Dolce Luna','GA8S311AB'],
      ['Nota Alta','GA8S313AB'],
      ['Otto Mare','GA8S314AB'],
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
      let colProds = 0, colSkus = 0, colAcc = 0;

      for (const [color, sku] of col.colors) {
        // Product
        const prodRes = await client.query(`
          INSERT INTO products (id, vendor_id, name, collection, category_id, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
          ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
          DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
          RETURNING id
        `, [vendorId, color, col.name, CAT[col.cat]]);
        const productId = prodRes.rows[0].id;
        colProds++;

        // Flooring SKU
        const internalSku = 'GAIA-' + sku;
        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'sqft', status = 'active'
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

        // Accessories (6 types)
        for (let i = 0; i < ACC_TYPES.length; i++) {
          const accVendorSku = sku + '-' + ACC_SUFFIXES[i];
          const accInternal = 'GAIA-' + accVendorSku;
          const accCost = col.accPrices[i];
          const accRetail = (accCost * MARKUP).toFixed(2);

          const accRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'unit',
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

      totalProducts += colProds;
      totalSkus += colSkus;
      totalAcc += colAcc;
      console.log(`  ${col.name}: ${colProds} products, ${colSkus} flooring SKUs + ${colAcc} accessories`);
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
