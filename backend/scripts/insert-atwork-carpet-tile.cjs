#!/usr/bin/env node
/**
 * insert-atwork-carpet-tile.cjs
 *
 * Creates @work carpet tile products, SKUs, images, and pricing in the database.
 * Data sources:
 *   - Website: atworkcarpettile.squarespace.com (images, colors, specs)
 *   - EDI 832: /tmp/triwest_832/triwest_832_combined.json (pricing, vendor_sku, packaging)
 *
 * Usage:
 *   node backend/scripts/insert-atwork-carpet-tile.cjs --dry-run
 *   node backend/scripts/insert-atwork-carpet-tile.cjs
 */

const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440008'; // Tri-West
const CATEGORY_ID = '650e8400-e29b-41d4-a716-446655440100'; // Carpet Tile

// ── Website-scraped collection data ──────────────────────────────────────────
const COLLECTIONS = [
  {
    name: 'Confidence',
    productName: '@work Confidence Carpet Tile 24x24',
    size: '24" x 24"',
    fiber: 'Solution Q® Nylon',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Preparation', itemNum: '42L73BG42Z', vendorSku832: 'SHA42L73BG42Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352096862-4F70HIR3Y49V1SOLSUJZ/AtWorkCarpetTile_Confidence_S42L73BG42Z_+Preperation_swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352093744-VGF48HFZBTRIJ5IOQ1YO/AtWorkCarpetTile_Confidence_S42L73BG42Z_Preperation_room+scene.png' },
      { color: 'Belief', itemNum: '42L73BG43Z', vendorSku832: 'SHA42L73BG43Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352264831-8DPYQCJ01FAIURZ6G4UV/AtWorkCarpetTile_Confidence_SS42L73BG43Z_Belief_swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352192353-ETKMW4P91D7JUC40GJ9G/AtWorkCarpetTile_Confidence_S42L73BG43Z_+Belief+room+scene.png' },
      { color: 'Success', itemNum: '42L73BG44Z', vendorSku832: 'SHA42L73BG44Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352327061-2YE5HTMJF0LPNF2PE691/AtWorkCarpetTile_Confidence_S42L73BG44Z_+Success_swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352328998-ZT3UU96KS0MH4ONPQMXN/S42L73BG44Z+-+Success+room+scene.png' },
      { color: 'Ability', itemNum: '42L73BG45Z', vendorSku832: 'SHA42L73BG45Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352383690-OV9HK34ZULMKLOPYY4AK/AtWorkCarpetTile_Confidence_S42L73BG45Z_+Ability_swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597352379607-A54WBCSEQARWDN2VKK58/AtWorkCarpetTile_Confidence_S42L73BG45Z_+Ability+room+scene.png' },
    ],
  },
  {
    name: 'Determination',
    productName: '@work Determination Carpet Tile 24x24',
    size: '24" x 24"',
    fiber: 'Solution Q® Nylon',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Indefinite', itemNum: '42L74BG46Z', vendorSku832: 'SHA42L74BG46Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355278951-KUPDTWZM3CJ4YQ52KFGA/AtWorkCarpetTile_Determination_S42L74BG46Z_Indefinite+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597354183820-AUA933NUXSY98ZT2T1TO/AtWorkCarpetTile_Determination_S42L74BG46Z_+Indefinite+room+scene.png' },
      { color: 'Relative', itemNum: '42L74BG47Z', vendorSku832: 'SHA42L74BG47Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355349624-4MB619EJ0CV9M7U2X09I/AtWorkCarpetTile_Determination_S42L74BG47Z_+Relative+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355347021-44DO5HQ85GX0OOUV5PL9/AtWorkCarpetTile_Determination_S42L74BG47Z_+Relative+room+scene.png' },
      { color: 'Absolute', itemNum: '42L74BG48Z', vendorSku832: 'SHA42L74BG48Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355938353-UXC65ATUR9IB8Q2YDIB5/AtWorkCarpetTile_Determination_S42L74BG48Z_+Absolute+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355468590-3CEE7NBF1H8TY33OBVH9/AtWorkCarpetTile_Determination_S42L74BG48Z_Absolute+room+scene.png' },
      { color: 'Singular', itemNum: '42L74BG49Z', vendorSku832: 'SHA42L74BG49Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355997296-Q7N6SNM1Z72F1BNA2YIY/AtWorkCarpetTile_Determination_S42L74BG49Z_+Singular+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597355586282-VQ3YEC7ZIST9VB5J6W6Y/S42L74BG49Z+-+Singular+room+scene.png' },
    ],
  },
  {
    name: 'Commitment',
    productName: '@work Commitment Carpet Tile 24x24',
    size: '24" x 24"',
    fiber: 'Solution Q® Nylon',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Boisterous', itemNum: '42L75BG50Z', vendorSku832: 'SHA42L75BG50Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597351675845-5K9BONWKFSFN1T751JYH/AtWorkCarpetTile_Commitment_S42L75BG50Z+-+Boisterous+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597351677578-QBWDPRZKMLBWUR91STUW/AtWorkCarpetTile_Commitment_S42L75BG50Z+-+Boisterous+room+scene.png' },
      { color: 'Audacious', itemNum: '42L75BG51Z', vendorSku832: 'SHA42L75BG51Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597351784141-LHA8KZJE0CI26FY7Q0J8/AtWorkCarpetTile_Commitment_S42L75BG51Z_+Audacious+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597351785815-B5OLQCKB0K44UG407D0B/AtWorkCarpetTile_Commitment_S42L75BG51Z_Audacious+room+scene.png' },
      { color: 'Bold', itemNum: '42L75BG52Z', vendorSku832: 'SHA42L75BG52Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597856432548-LLT1VVRKHYX3F4E5DOGS/AtWorkCarpetTile_Commitment_S42L75BG52Z_+Bold+swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597856432274-7DSFA3LJGY30N8ZQCGGV/AtWorkCarpetTile_Commitment_S42L75BG52Z_Bold+room+scene.png' },
      { color: 'Binding', itemNum: '42L75BG53Z', vendorSku832: 'SHA42L75BG53Z',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597856291364-1D82DKMN7H2XGSOHGY2X/AtWorkCarpetTile_Commitment_S42L75BG53Z_Binding_swatch.png',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597856309013-F85WODUMH3AQQKI6781X/AtWorkCarpetTile_Commitment_S42L75BG53Z_Binding+room+scene.png' },
    ],
  },
  {
    name: 'Rubicon',
    productName: '@work Rubicon Carpet Tile',
    size: '19.69" x 19.69"',
    fiber: '100% BCF Polypropylene',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Lead', itemNum: '707103', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504155357723-U6NQY2K40H9YHDXV5CA1/AtWorkCarpetTile_Rubicon_707103_Lead.jpg',
        room: null },
      { color: 'Ebony', itemNum: '707106', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504155461071-P3V94OYFOTNP97AP971S/AtWorkCarpetTile_Rubicon_707106_Ebony.jpg',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504155470557-SABFZKHPEVIK8NP1BFFS/AtWorkCarpetTile_Rubicon_RoomScene_Ebony.jpg' },
      { color: 'Navy', itemNum: '707107', vendorSku832: 'KRA707107',
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504155579239-U4BG9D7MQLTJGOFCPUGI/AtWorkCarpetTile_Rubicon_707107_Navy.jpg',
        room: null },
    ],
  },
  {
    name: 'Buckingham',
    productName: '@work Buckingham Carpet Tile',
    size: '19.69" x 19.69"',
    fiber: '100% BCF Polypropylene',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Silver', itemNum: '707231', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504139403502-QKDSOQP981V80UUF9FHB/AtWorkCarpet_Buckingham_707231_Silver.jpg',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504042524122-EDCF62CTXD0XE6NMVFDJ/AtWorkCarpetTile_Buckingham+707231+Silver+Room+Scene.jpg' },
      { color: 'Blue Pewter', itemNum: '707232', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504139446258-EGBMIKF4V2B8JREZMHQR/AtWorkCarpet_Buckingham_707232_Blue_Pewter.jpg',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504042649446-9UJP5PZWUKE1TUR828BX/AtWorkCarpetTile_Buckingham+707232+Blue+Pewter+Room+Scene.jpg' },
      { color: 'Cavern', itemNum: '707234', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504139488617-OBJ5PRLRG64WZLOL8S48/AtWorkCarpet_Buckingham_707234_Cavern.jpg',
        room: null },
      { color: 'Slate', itemNum: '707235', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1504139517452-8V3GVHQMRWWPUW57M13K/AtWorkCarpet_Buckingham_707235_Slate.jpg',
        room: null },
    ],
  },
  {
    name: 'Westminster',
    productName: '@work Westminster Carpet Tile',
    size: '19.69" x 19.69"',
    fiber: '100% BCF Polypropylene',
    construction: 'Carpet Tile',
    colors: [
      { color: 'Cork', itemNum: '707001', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597455492195-3ZJ7NJPNKQRSP2L6YK88/AtWorkCarpetTile_Westminster_707001_Cork.jpg',
        room: null },
      { color: 'Nickel Blue', itemNum: '707008', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597455706830-TAELJT1EN1KF17J5W3Y6/AtWorkCarpetTile_Westminster_707008_NickleBlue.jpg',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597455944657-4FT49RD3YCVUGQTVJUY7/AtWorkCarpetTile_Westminster_707008_NickelBlue_RoomScene.jpg' },
      { color: 'Wrought Iron', itemNum: '707009', vendorSku832: null,
        swatch: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597455872613-OC8N4GUHR2JJMX5QCIK3/AtWorkCarpetTile_Westminster_707009_WroughtIron.jpg',
        room: 'https://images.squarespace-cdn.com/content/v1/59a5b729b8a79b5f57cb0e41/1597455910526-F4P1E3NO50LB2UEGVBQA/AtWorkCarpetTile_Westminster_707009_WroughtIron_RoomScene.jpg' },
    ],
  },
];

// Additional @work products from 832 EDI only (not on website)
const EXTRA_832_PRODUCTS = [
  { productName: '@work Fog Carpet Tile', size: '19.69" x 19.69"', fiber: 'Polypropylene', construction: 'Carpet Tile',
    colors: [{ color: 'Mist', itemNum: '3321403', vendorSku832: 'KRA3321403' }] },
  { productName: '@work Rain Carpet Tile', size: '19.69" x 19.69"', fiber: 'Polypropylene', construction: 'Carpet Tile',
    colors: [{ color: 'Torrent', itemNum: '3321306', vendorSku832: 'KRA3321306' }] },
  { productName: '@work Yosemite Carpet Tile', size: '19.69" x 19.69"', fiber: 'Polyester', construction: 'Carpet Tile',
    colors: [{ color: 'Mineral Gray', itemNum: '707503', vendorSku832: 'KRA707503' }] },
  { productName: '@work Zion Accent Carpet Plank', size: '12" x 48"', fiber: 'Nylon', construction: 'Carpet Tile',
    colors: [{ color: 'Accent Tree Branch', itemNum: '707306', vendorSku832: 'KRA707306' }] },
  { productName: '@work Aberdeen Carpet Tile 12x48', size: '12" x 48"', fiber: 'Nylon', construction: 'Carpet Tile',
    colors: [{ color: 'Geary', itemNum: 'I045500525', vendorSku832: 'SHAI045500525' }] },
  { productName: '@work Mid Century Mad Carpet Tile 24x24', size: '24" x 24"', fiber: 'Nylon', construction: 'Carpet Tile',
    colors: [{ color: 'Atomic', itemNum: 'I038000590', vendorSku832: 'SHAI038000590' }] },
  { productName: '@work Paseo Carpet Tile 24x24', size: '24" x 24"', fiber: 'Nylon', construction: 'Carpet Tile',
    colors: [{ color: 'Opal', itemNum: 'I031600123', vendorSku832: 'SHAI031600123' }] },
];

// ── Load 832 pricing data ────────────────────────────────────────────────────
let pricingMap = new Map();
try {
  const ediData = JSON.parse(fs.readFileSync('/tmp/triwest_832/triwest_832_combined.json', 'utf8'));
  for (const item of ediData.items) {
    if (item.category === 'carpet-tile') {
      pricingMap.set(item.vendor_sku, {
        cost: item.cost,
        retail_price: item.retail_price,
        map_price: item.map_price,
        sell_by: item.sell_by || 'sqft',
        sqft_per_box: item.sqft_per_box,
        weight_per_box_lbs: item.weight_per_box_lbs,
      });
    }
  }
  console.log(`Loaded ${pricingMap.size} carpet-tile pricing entries from 832`);
} catch (e) {
  console.log('Warning: Could not load 832 data:', e.message);
}

async function main() {
  const client = await pool.connect();
  try {
    if (!DRY_RUN) await client.query('BEGIN');

    let productsCreated = 0, skusCreated = 0, imagesAdded = 0, pricingSet = 0, packagingSet = 0;

    const allCollections = [...COLLECTIONS, ...EXTRA_832_PRODUCTS];

    for (const col of allCollections) {
      // 1. Check if product already exists
      const existCheck = await client.query(
        `SELECT id FROM products WHERE name = $1 AND vendor_id = $2`,
        [col.productName, VENDOR_ID]
      );

      let productId;
      if (existCheck.rows.length > 0) {
        productId = existCheck.rows[0].id;
        console.log(`Product already exists: ${col.productName} (${productId})`);
      } else if (DRY_RUN) {
        productId = null;
        productsCreated++;
        console.log(`CREATE product: ${col.productName}`);
      } else {
        const res = await client.query(`
          INSERT INTO products (vendor_id, category_id, name, status, collection)
          VALUES ($1, $2, $3, 'active', '@work Carpet Tile')
          RETURNING id
        `, [VENDOR_ID, CATEGORY_ID, col.productName]);
        productId = res.rows[0].id;
        productsCreated++;
        console.log(`CREATE product: ${col.productName} → ${productId}`);
      }

      // 2. Create SKUs for each color
      for (const colorInfo of col.colors) {
        const vsku = colorInfo.vendorSku832 || colorInfo.itemNum;
        const pricing = colorInfo.vendorSku832 ? pricingMap.get(colorInfo.vendorSku832) : null;

        if (DRY_RUN) {
          skusCreated++;
          console.log(`  CREATE SKU: ${colorInfo.color} [${vsku}]`);
          if (colorInfo.swatch) { imagesAdded++; console.log(`    ADD primary image`); }
          if (colorInfo.room) { imagesAdded++; console.log(`    ADD lifestyle image`); }
          if (pricing) {
            pricingSet++;
            if (pricing.sqft_per_box) packagingSet++;
            console.log(`    SET pricing: cost=$${pricing.cost}, ${pricing.sqft_per_box || 'n/a'} sqft/box`);
          }
          continue;
        }

        // Check if SKU exists
        const skuCheck = await client.query(
          `SELECT id FROM skus WHERE product_id = $1 AND variant_name = $2`,
          [productId, colorInfo.color]
        );

        let skuId;
        if (skuCheck.rows.length > 0) {
          skuId = skuCheck.rows[0].id;
          console.log(`  SKU exists: ${colorInfo.color} (${skuId})`);
        } else {
          const internalSku = 'TW-' + vsku;
          const res = await client.query(`
            INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, status, sell_by)
            VALUES ($1, $2, $3, $4, 'active', 'sqft')
            RETURNING id
          `, [productId, vsku, internalSku, colorInfo.color]);
          skuId = res.rows[0].id;
          skusCreated++;
          console.log(`  CREATE SKU: ${colorInfo.color} [${vsku}] → ${skuId}`);
        }

        // 3. Insert images (swatch = primary, room = lifestyle)
        if (colorInfo.swatch) {
          const imgCheck = await client.query(
            `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`,
            [skuId]
          );
          if (imgCheck.rows.length === 0) {
            await client.query(`
              INSERT INTO media_assets (product_id, sku_id, url, asset_type, sort_order)
              VALUES ($1, $2, $3, 'primary', 0)
            `, [productId, skuId, colorInfo.swatch]);
            imagesAdded++;
            console.log(`    ADD primary image`);
          }
        }

        if (colorInfo.room) {
          const roomCheck = await client.query(
            `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'lifestyle'`,
            [skuId]
          );
          if (roomCheck.rows.length === 0) {
            await client.query(`
              INSERT INTO media_assets (product_id, sku_id, url, asset_type, sort_order)
              VALUES ($1, $2, $3, 'lifestyle', 1)
            `, [productId, skuId, colorInfo.room]);
            imagesAdded++;
            console.log(`    ADD lifestyle image`);
          }
        }

        // 4. Set pricing from 832 data
        if (pricing) {
          const priceCheck = await client.query(
            `SELECT sku_id FROM pricing WHERE sku_id = $1`,
            [skuId]
          );
          if (priceCheck.rows.length === 0) {
            // retail_price is NOT NULL — use 2.5x cost markup if no retail price from 832
            const retailPrice = pricing.retail_price || (pricing.cost * 2.5);
            await client.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, map_price)
              VALUES ($1, $2, $3, $4)
            `, [skuId, pricing.cost, retailPrice, pricing.map_price]);
            pricingSet++;
            console.log(`    SET pricing: cost=$${pricing.cost}`);
          }

          if (pricing.sqft_per_box) {
            const pkgCheck = await client.query(
              `SELECT sku_id FROM packaging WHERE sku_id = $1`,
              [skuId]
            );
            if (pkgCheck.rows.length === 0) {
              await client.query(`
                INSERT INTO packaging (sku_id, sqft_per_box, weight_per_box_lbs)
                VALUES ($1, $2, $3)
              `, [skuId, pricing.sqft_per_box, pricing.weight_per_box_lbs]);
              packagingSet++;
              console.log(`    SET packaging: ${pricing.sqft_per_box} sqft/box`);
            }
          }
        }

        // 5. Set SKU attributes (fiber, size, construction) — use existing attribute IDs
        const attrMap = {
          'Fiber': '46e7147f-213d-4d1c-9199-a50bde5d0736',
          'Size': 'd50e8400-e29b-41d4-a716-446655440004',
          'Construction': '4398ccdc-2308-43ae-8d29-1e3f310f9952',
        };
        for (const [attrName, attrVal] of [['Fiber', col.fiber], ['Size', col.size], ['Construction', col.construction]]) {
          if (!attrVal || !attrMap[attrName]) continue;
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
          `, [skuId, attrMap[attrName], attrVal]);
        }
      }
    }

    if (!DRY_RUN) await client.query('COMMIT');

    console.log(`\n--- Summary ${DRY_RUN ? '(DRY RUN)' : ''} ---`);
    console.log(`Products created: ${productsCreated}`);
    console.log(`SKUs created: ${skusCreated}`);
    console.log(`Images added: ${imagesAdded}`);
    console.log(`Pricing entries: ${pricingSet}`);
    console.log(`Packaging entries: ${packagingSet}`);

  } catch (e) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
