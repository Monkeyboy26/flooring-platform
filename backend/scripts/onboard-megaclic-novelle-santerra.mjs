/**
 * Onboard the two NEW MegaClic collections from the July 13, 2026 price list:
 *
 *   - Santerra  (Waterproof Laminate) — MCST-23xx, 11 colors, $1.99/sqft
 *     14mm AC5, 9.3" x 72" plank, 2mm EVA pad, 5 planks/ctn (23.31 sf), 52 ctn/plt
 *   - Novelle   (SPC Vinyl)           — MCNL-82xx, 15 colors, $1.59/sqft
 *     7mm, 20mil wear layer, 9" x 72", 2mm EVA pad, 4 planks/ctn (17.94 sf), 64 ctn/plt
 *
 * Deliberately scoped: the full import-megaclic.js would also re-import the
 * Athens line that the same price list DISCONTINUED (deactivated 2026-08-26),
 * so do NOT run that importer — this script follows its exact model instead
 * (product per color, molding accessory SKUs on the same product, attributes,
 * megaclicfloors.com images).
 *
 * Images scraped from megaclicfloors.com /project/ pages 2026-08-26:
 * Santerra has plank shots (MCST-xxxx.jpg) + room scenes; Novelle pages carry
 * ONLY room-scene/installation photos, so the room scene doubles as primary.
 *
 * Retail = round-down-.x9(cost x 1.6) with covering floor for planks —
 * matches the platform rule and the existing MegaClic molding retails.
 *
 * Usage:
 *   node backend/scripts/onboard-megaclic-novelle-santerra.mjs           # dry run
 *   node backend/scripts/onboard-megaclic-novelle-santerra.mjs --apply
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const CAT = {
  laminate: '650e8400-e29b-41d4-a716-446655440090',
  lvp:      '650e8400-e29b-41d4-a716-446655440031',
};
const IMG = 'https://www.megaclicfloors.com/wp-content/uploads/2026/04';

const nineDown = (v) => {
  const cents = Math.round(Number(v) * 100);
  return Math.max(9, Math.floor((cents - 9) / 10) * 10 + 9) / 100;
};
const keystoneSqft = (cost) => {
  const floorMin = cost + 0.99;
  let nine = nineDown(Math.max(cost * 1.6, floorMin));
  if (nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
};
const keystoneUnit = (cost) => nineDown(cost * 1.6);

// [suffix, name, cost] — per the July 2026 moldings section
const MOLDINGS = {
  laminate: [
    ['QR', 'Quarter Round', 13.79], ['EC', 'End Cap', 19.99], ['TM', 'T-Mold', 19.99],
    ['RD', 'Reducer', 19.99], ['FSN', 'Flush Stair Nose', 29.99],
  ],
  spc: [
    ['QR', 'Quarter Round', 13.79], ['EC', 'End Cap', 19.99], ['TM', 'T-Mold', 19.99],
    ['RD', 'Reducer', 19.99], ['FSN', 'Flush Stair Nose', 25.99],
  ],
};

const slugify = (code, color) => `${code.toLowerCase()}-${color.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const COLLECTIONS = [
  {
    collection: 'Santerra AC5', catKey: 'laminate', moldingTier: 'laminate',
    cost: 1.99, sqftPerBox: 23.31, pcsPerBox: 5, boxesPerPallet: 52,
    attrs: { Material: 'Laminate', Thickness: '14mm', Width: '9.3"', 'Wear Layer': 'AC5',
             Installation: 'Click-lock', Finish: 'Embossed' },
    // Santerra plank shots: MCST-xxxx.jpg; room scene: MCST-xxxx-room-scene.jpg
    colors: [
      ['MCST-2301', 'Aveline'], ['MCST-2302', 'Cortessa'], ['MCST-2303', 'Cadiz Royale'],
      ['MCST-2305', 'Cedrano'], ['MCST-2306', 'Sanara'], ['MCST-2307', 'Armano'],
      ['MCST-2308', 'Draymont'], ['MCST-2309', 'Montclair'], ['MCST-2310', 'Aurelia'],
      ['MCST-2311', 'Ravello'], ['MCST-2312', 'Valenza'],
    ],
    img: (code, color) => ({
      primary: `${IMG}/${code}.jpg`,
      lifestyle: `${IMG}/${code}-room-scene.jpg`,
    }),
  },
  {
    collection: 'Novelle', catKey: 'lvp', moldingTier: 'spc',
    cost: 1.59, sqftPerBox: 17.94, pcsPerBox: 4, boxesPerPallet: 64,
    attrs: { Material: 'SPC', Thickness: '7mm', Width: '9"', 'Wear Layer': '20mil',
             Installation: 'Click-lock', Finish: 'Embossed' },
    // Novelle has no plank shots on the site — room scene doubles as primary.
    // Exact filenames scraped from the /project/ pages (mixed .jpg/.webp; the
    // site spells 8209 "Somerville" while the price list has "Sommerville").
    img: (code, color) => {
      const NOVELLE_FILES = {
        'MCNL-8201': ['MCNL-8201-Pacific-Marina-Room-Scene.jpg', 'MCNL-8201-Pacific-Marina-Installation-2.jpg'],
        'MCNL-8202': ['MCNL-8202-Embered-Ridge-Room-Scene.webp', 'MCNL-8202-Embered-Ridge-Installation.jpg'],
        'MCNL-8203': ['MCNL-8203-Fairfield-Room-Scene.webp', 'MCNL-8203-Fairfield-Installation.jpg'],
        'MCNL-8205': ['MCNL-8205-Toscana-Room-Scene.webp', 'MCNL-8205-Toscana-Installation.jpg'],
        'MCNL-8206': ['MCNL-8206-Soho-Room-Scene.webp', 'MCNL-8206-Soho-Installation.jpg'],
        'MCNL-8207': ['MCNL-8207-Sugar-Sand-Room-Scene.webp', 'MCNL-8207-Sugar-Sand-Installation.jpg'],
        'MCNL-8208': ['MCNL-8208-Mountain-Air-Room-Scene-scaled.webp', 'MCNL-8208-Mountain-Air-Installation.jpg'],
        'MCNL-8209': ['MCNL-8209-Somerville-Room-Scene.webp', 'MCNL-8209-Somerville-Installation.jpg'],
        'MCNL-8210': ['MCNL-8210-Durham-Room-Scene.webp', 'MCNL-8210-Durham-Installation.jpg'],
        'MCNL-8211': ['MCNL-8211-Santa-Ana-Room-Scene.webp', 'MCNL-8211-Santa-Ana-Installation.jpg'],
        'MCNL-8212': ['MCNL-8212-Jordan-Room-Scene.webp', 'MCNL-8212-Jordan-Installation.jpg'],
        'MCNL-8213': ['MCNL-8213-Alcovy-Room-Scene.webp', 'MCNL-8213-Alcovy-Installation.jpg'],
        'MCNL-8215': ['MCNL-8215-Palm-Mist-Room-Scene.webp', 'MCNL-8215-Palm-Mist-Installation.jpg'],
        'MCNL-8216': ['MCNL-8216-Thompson-Room-Scene.webp', 'MCNL-8216-Thompson-Installation.jpg'],
        'MCNL-8217': ['MCNL-8217-Sahara-Room-Scene.webp', 'MCNL-8217-Sahara-Installation.jpg'],
      };
      const [primary, lifestyle] = NOVELLE_FILES[code];
      return { primary: `${IMG}/${primary}`, lifestyle: `${IMG}/${lifestyle}` };
    },
    colors: [
      ['MCNL-8201', 'Pacific Marina'], ['MCNL-8202', 'Embered Ridge'], ['MCNL-8203', 'Fairfield'],
      ['MCNL-8205', 'Toscana'], ['MCNL-8206', 'Soho'], ['MCNL-8207', 'Sugar Sand'],
      ['MCNL-8208', 'Mountain Air'], ['MCNL-8209', 'Sommerville'], ['MCNL-8210', 'Durham'],
      ['MCNL-8211', 'Santa Ana'], ['MCNL-8212', 'Jordan'], ['MCNL-8213', 'Alcovy'],
      ['MCNL-8215', 'Palm Mist'], ['MCNL-8216', 'Thompson'], ['MCNL-8217', 'Sahara'],
    ],
  },
];

async function upsertAttribute(client, skuId, attrName, attrValue) {
  let attrRes = await client.query(`SELECT id FROM attributes WHERE name = $1`, [attrName]);
  if (!attrRes.rows.length) {
    attrRes = await client.query(
      `INSERT INTO attributes (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [attrName, attrName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]);
  }
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
    [skuId, attrRes.rows[0].id, attrValue]);
}

const { rows: [vendor] } = await pool.query(`SELECT id FROM vendors WHERE code = 'MGC'`);
if (!vendor) { console.error('MegaClic vendor not found'); process.exit(1); }

if (!APPLY) {
  for (const c of COLLECTIONS) {
    console.log(`\n${c.collection} (${c.catKey}) — $${c.cost}/sqft -> retail ${keystoneSqft(c.cost)}, ${c.colors.length} colors, ${MOLDINGS[c.moldingTier].length} moldings each`);
    for (const [code, color] of c.colors) {
      const im = c.img(code, color);
      console.log(`  ${code} ${color.padEnd(16)} ${im.primary.split('/').pop()} + ${im.lifestyle.split('/').pop()}`);
    }
  }
  console.log('\nDRY RUN — re-run with --apply.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let products = 0, skus = 0, accs = 0;
try {
  await client.query('BEGIN');
  for (const c of COLLECTIONS) {
    for (const [code, color] of c.colors) {
      const { rows: [prod] } = await client.query(`
        INSERT INTO products (vendor_id, name, collection, category_id, status)
        VALUES ($1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active', updated_at = CURRENT_TIMESTAMP
        RETURNING id`, [vendor.id, color, c.collection, CAT[c.catKey]]);
      products++;

      const { rows: [sku] } = await client.query(`
        INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
        VALUES ($1, $2, $3, $4, 'sqft', 'active')
        ON CONFLICT (internal_sku) DO UPDATE SET product_id = EXCLUDED.product_id,
          vendor_sku = EXCLUDED.vendor_sku, status = 'active', updated_at = CURRENT_TIMESTAMP
        RETURNING id`, [prod.id, code, `MEGACLIC-${code}`, color]);
      skus++;

      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1, $2, $3, 'per_sqft')
        ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price`,
        [sku.id, c.cost, keystoneSqft(c.cost)]);
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet) VALUES ($1,$2,$3,$4)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box,
          pieces_per_box=EXCLUDED.pieces_per_box, boxes_per_pallet=EXCLUDED.boxes_per_pallet`,
        [sku.id, c.sqftPerBox, c.pcsPerBox, c.boxesPerPallet]);

      const im = c.img(code, color);
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'primary', $3, $3, 0)
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url`,
        [prod.id, sku.id, im.primary]);
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'lifestyle', $3, $3, 1)
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url`,
        [prod.id, sku.id, im.lifestyle]);

      for (const [name, value] of Object.entries(c.attrs)) await upsertAttribute(client, sku.id, name, value);
      await upsertAttribute(client, sku.id, 'Color', color);
      await upsertAttribute(client, sku.id, 'Collection', c.collection);

      let accSort = 0;
      for (const [suffix, accName, accCost] of MOLDINGS[c.moldingTier]) {
        const { rows: [acc] } = await client.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
          VALUES ($1, $2, $3, $4, 'unit', 'accessory', $4, 'active')
          ON CONFLICT (internal_sku) DO UPDATE SET product_id = EXCLUDED.product_id, status = 'active',
            accessory_label = EXCLUDED.accessory_label, updated_at = CURRENT_TIMESTAMP
          RETURNING id`, [prod.id, `${code}-${suffix}`, `MEGACLIC-${code}-${suffix}`, accName]);
        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1, $2, $3, 'per_unit')
          ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price`,
          [acc.id, accCost, keystoneUnit(accCost)]);
        // storefront surfaces accessories via sku_accessories linkage
        await client.query(`
          INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order) VALUES ($1, $2, $3)
          ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [sku.id, acc.id, accSort++]);
        accs++;
      }
    }
  }
  await client.query('COMMIT');
  console.log(`APPLIED: ${products} products, ${skus} plank SKUs, ${accs} molding SKUs.`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
await pool.end();
