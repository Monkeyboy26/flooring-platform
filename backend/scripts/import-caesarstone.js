#!/usr/bin/env node

/**
 * Import Caesarstone product data from 2025 Price List.
 * Effective October 1, 2025 (V 12.16.2025, added Travina 2cm).
 *
 * Product lines:
 *   1. Quartz Surfaces — 6 tiers, ~58 colors
 *   2. Mineral Surfaces — ≤40% silica versions of select Quartz colors
 *   3. Advanced Fusion (ICON) — Crystalline Silica-Free (<1%), plus new 8xxx series
 *   4. Porcelain — 4 tiers, different slab sizes/thicknesses
 *
 * Pricing: PDF lists "suggested retail pricing". Cost = retail / 2.0.
 * Slabs sold per sqft; packaging stores slab sqft for carton rounding.
 *
 * Slab sizes:
 *   Standard Slab: 120" x 56.5" = 47.08 sqft
 *   Jumbo Slab:    131.5" x 64.6" = 58.9 sqft
 *   Porcelain:     124.5" x 61.5" = 53.17 sqft
 *
 * Usage: docker compose exec api node scripts/import-caesarstone.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Categories ====================
const CAT_QUARTZ    = '650e8400-e29b-41d4-a716-446655440041';
const CAT_PORCELAIN = '650e8400-e29b-41d4-a716-446655440045';

// ==================== Slab sqft ====================
const STD_SLAB_SQFT  = 47.08;
const JUMBO_SLAB_SQFT = 58.9;
const PORC_SLAB_SQFT = 53.17;

// ==================== Tier pricing (per sqft, retail) ====================
// S2=Standard 2cm, S3=Standard 3cm, J2=Jumbo 2cm, J3=Jumbo 3cm
const TIER_PRICES = {
  'Essentials':          { S2: 28.76, S3: 35.72, J2: 28.74, J3: 35.71 },
  'Standard':            { S2: 32.65, S3: 41.85, J2: 32.70, J3: 41.74 },
  'Premium':             { S2: 42.56, S3: 55.17, J2: 42.59, J3: 55.12 },
  'Supernatural':        { S2: 48.45, S3: 62.36, J2: 48.24, J3: 62.10 },
  'Outdoor':             { J2: 56.18, J3: 72.25 },
  'Supernatural Ultra':  { S2: 66.49, S3: 85.23, J2: 66.43, J3: 85.28 },
  // ICON sub-tiers (8xxx series premium)
  'Supernatural+':       { J2: 50.66, J3: 65.20 },
  'Supernatural Ultra+': { J2: 69.75, J3: 89.54 },
};

// Porcelain pricing: keyed by thickness in mm
const PORC_PRICES = {
  'Standard':           { 12: 23.02 },
  'Premium':            { 12: 34.51, 20: 43.69 },
  'Supernatural':       { 12: 36.81, 20: 48.45 },
  'Supernatural Ultra': { 12: 46.00, 20: 51.91 },
};

// ==================== Finish labels ====================
const FINISH_MAP = {
  P: 'Polished', N: 'Natural', H: 'Honed', R: 'Rough', C: 'Concrete',
  UR: 'Ultra Rough', S: 'Silk', ST: 'Stone',
};

// ==================== QUARTZ SURFACES ====================
// [item#, name, finishCode, availVariants (comma-sep), tier]
const QUARTZ = [
  // --- Essentials ---
  ['3100', 'Jet Black',       'P', 'J2,J3', 'Essentials'],
  ['6141', 'Ocean Foam',      'P', 'J2,J3', 'Essentials'],
  ['9141', 'Ice Snow',        'P', 'J2,J3', 'Essentials'],
  // --- Standard ---
  ['2003', 'Concrete',        'P', 'S2,S3',         'Standard'],
  ['2141', 'Blizzard',        'P', 'J2,J3',         'Standard'],
  ['4030', 'Pebble',          'P', 'J2,J3',         'Standard'],
  ['4120', 'Raven',           'P', 'J2,J3',         'Standard'],
  ['4141', 'Misty Carrera',   'P', 'J2,J3',         'Standard'],
  ['4600', 'Organic White',   'P', 'J2,J3',         'Standard'],
  ['4601', 'Frozen Terra',    'C', 'S2,S3',         'Standard'],
  ['6270', 'Atlantic Salt',   'P', 'S2,S3,J2,J3',   'Standard'],
  ['6600', 'Nougat',          'P', 'J2,J3',         'Standard'],
  // --- Premium ---
  ['1141', 'Pure White',      'P', 'S3,J2,J3',      'Premium'],
  ['4001', 'Fresh Concrete',  'C', 'J2,J3',         'Premium'],
  ['4003', 'Sleek Concrete',  'C', 'J2,J3',         'Premium'],
  ['4004', 'Raw Concrete',    'C', 'J2,J3',         'Premium'],
  ['4043', 'Primordia',       'R', 'J2,J3',         'Premium'],
  ['5110', 'Alpine Mist',     'P', 'J2,J3',         'Premium'],
  ['5111', 'Statuario Nuvo',  'P', 'J2,J3',         'Premium'],
  ['5112', 'Aterra Blanca',   'P', 'J2,J3',         'Premium'],
  ['5122', 'Aterra Verity',   'P', 'J2,J3',         'Premium'],
  ['5130', 'Cosmopolitan White','P','S2,J2,J3',     'Premium'],
  ['5132', 'Celestial Sky',   'P', 'J2,J3',         'Premium'],
  ['5133', 'Symphony Grey',   'P', 'S2,S3,J2,J3',   'Premium'],
  ['5143', 'White Attica',    'P', 'J2,J3',         'Premium'],
  ['5212', 'Taj Royale',      'P', 'S2,S3',         'Premium'],
  ['6003', 'Coastal Grey',    'P', 'S2,S3',         'Premium'],
  ['6046', 'Moorland Fog',    'P', 'S2,S3',         'Premium'],
  ['6134', 'Georgian Bluffs', 'P', 'S2,J2,J3',      'Premium'],
  ['6313', 'Turbine Grey',    'P', 'S2,S3',         'Premium'],
  ['6611', 'Himalayan Moon',  'P', 'J2,J3',         'Premium'],
  // --- Supernatural ---
  ['1111', 'Vivid White',         'P', 'J2,J3',  'Supernatural'],
  ['4011', 'Cloudburst Concrete', 'R', 'J2,J3',  'Supernatural'],
  ['4033', 'Rugged Concrete',     'R', 'J2,J3',  'Supernatural'],
  ['4044', 'Airy Concrete',       'R', 'J2,J3',  'Supernatural'],
  ['5000', 'London Grey',         'P', 'J2,J3',  'Supernatural'],
  ['5003', 'Piatra Grey',         'P', 'S2,S3',  'Supernatural'],
  ['5031', 'Statuario Maximus',   'P', 'J2,J3',  'Supernatural'],
  ['5100', 'Vanilla Noir',        'P', 'J2,J3',  'Supernatural'],
  ['5141', 'Frosty Carrina',      'P', 'J2,J3',  'Supernatural'],
  ['5115', 'Calacatta Stillstorm','P', 'J2,J3',  'Supernatural'],
  ['5116', 'Calacatta Nectar',    'P', 'J2,J3',  'Supernatural'],
  ['5140', 'Dreamy Carrara',      'H', 'S2,S3',  'Supernatural'],
  ['5144', 'Rossa Nova',          'P', 'J2,J3',  'Supernatural'],
  ['5152', 'Goldfinch',           'P', 'J2,J3',  'Supernatural'],
  ['5310', 'Brillianza',          'P', 'S2,S3',  'Supernatural'],
  ['5810', 'Black Tempal',        'N', 'J2,J3',  'Supernatural'],
  ['5820', 'Darcrest',            'H', 'S2,S3',  'Supernatural'],
  ['6131', 'Bianco Drift',        'P', 'J2,J3',  'Supernatural'],
  // --- Outdoor ---
  ['405', 'Midday',      'C', 'J2,J3', 'Outdoor'],
  ['406', 'Clearskies',  'C', 'J2,J3', 'Outdoor'],
  ['515', 'Palm Shade',  'H', 'J2,J3', 'Outdoor'],
  // --- Supernatural Ultra ---
  ['5101', 'Empira Black',     'P', 'J2,J3',  'Supernatural Ultra'],
  ['5113', 'Solenna',          'P', 'S2,S3',  'Supernatural Ultra'],
  ['5118', 'Calacatta Scoria', 'P', 'J2,J3',  'Supernatural Ultra'],
  ['5131', 'Calacatta Nuvo',   'P', 'J2,J3',  'Supernatural Ultra'],
  ['5151', 'Empira White',     'P', 'J2,J3',  'Supernatural Ultra'],
  ['5171', 'Arabetto',         'P', 'S2,S3',  'Supernatural Ultra'],
];

// ==================== MINERAL SURFACES ====================
const MINERAL = [
  // --- Standard ---
  ['6270', 'Atlantic Salt',   'P', 'S2,S3',  'Standard'],
  // --- Premium ---
  ['5130', 'Cosmopolitan White','P','S2,S3',  'Premium'],
  ['5133', 'Symphony Grey',   'P', 'S2,S3',  'Premium'],
  ['6134', 'Georgian Bluffs', 'P', 'S2,S3',  'Premium'],
  ['6313', 'Turbine Grey',    'P', 'S2,S3',  'Premium'],
  // --- Supernatural ---
  ['4011', 'Cloudburst Concrete','R','J2,J3', 'Supernatural'],
  ['4033', 'Rugged Concrete', 'R', 'J2,J3',  'Supernatural'],
  ['4044', 'Airy Concrete',   'R', 'J2,J3',  'Supernatural'],
  ['5003', 'Piatra Grey',     'P', 'S2,S3',  'Supernatural'],
  ['5100', 'Vanilla Noir',    'P', 'S2,S3',  'Supernatural'],
  ['5140', 'Dreamy Carrara',  'H', 'S2,S3',  'Supernatural'],
  ['5310', 'Brillianza',      'P', 'S2,S3',  'Supernatural'],
  ['5810', 'Black Tempal',    'N', 'J2,J3',  'Supernatural'],
  // --- Supernatural Ultra ---
  ['5113', 'Solenna',   'P', 'J2,J3', 'Supernatural Ultra'],
  ['5171', 'Arabetto',  'P', 'J2,J3', 'Supernatural Ultra'],
];

// ==================== ADVANCED FUSION (ICON) ====================
const ICON = [
  // --- Premium (Jumbo only) ---
  ['4001', 'Fresh Concrete',  'C', 'J2,J3', 'Premium'],
  ['5110', 'Alpine Mist',     'P', 'J2,J3', 'Premium'],
  ['5112', 'Aterra Blanca',   'P', 'J2,J3', 'Premium'],
  ['5122', 'Aterra Verity',   'P', 'J2,J3', 'Premium'],
  ['5132', 'Celestial Sky',   'P', 'J2,J3', 'Premium'],
  ['6313', 'Turbine Grey',    'P', 'J2,J3', 'Premium'],
  // --- Supernatural ---
  ['5140', 'Dreamy Carrara',  'H', 'J2,J3', 'Supernatural'],
  ['5144', 'Rossa Nova',      'P', 'J2,J3', 'Supernatural'],
  ['5152', 'Goldfinch',       'P', 'J2,J3', 'Supernatural'],
  ['5310', 'Brillianza',      'P', 'J2,J3', 'Supernatural'],
  // --- Supernatural (8xxx premium sub-tier) ---
  ['8100', 'Calacatta Lacebound','P','J2,J3','Supernatural+'],
  ['8101', 'Clearlight',      'P', 'J2,J3', 'Supernatural+'],
  ['8151', 'Moonflow',        'P', 'J2,J3', 'Supernatural+'],
  // --- Supernatural Ultra ---
  ['5113', 'Solenna',         'P', 'J2,J3', 'Supernatural Ultra'],
  ['5131', 'Calacatta Nuvo',  'P', 'J2,J3', 'Supernatural Ultra'],
  ['5171', 'Arabetto',        'P', 'J2,J3', 'Supernatural Ultra'],
  // --- Supernatural Ultra (8xxx premium sub-tier) ---
  ['8103', 'Calacatta Nobella','P','J2,J3', 'Supernatural Ultra+'],
  ['8104', 'Calacatta Thyme', 'P', 'J2,J3', 'Supernatural Ultra+'],
];

// ==================== PORCELAIN ====================
// [item#, name, [[thicknessMM, finishCode], ...], tier]
const PORCELAIN = [
  // --- Standard (12mm only) ---
  ['110', 'Whitenna', [['12','H']], 'Standard'],
  ['220', 'Magnate',  [['12','UR']], 'Standard'],
  // --- Premium ---
  ['410', 'Aluminous',    [['12','UR']], 'Premium'],
  ['411', 'Concrita',     [['12','UR']], 'Premium'],
  ['412', 'Beige Ciment', [['12','UR']], 'Premium'],
  ['413', 'White Ciment', [['12','UR']], 'Premium'],
  ['543', 'Marenstone',   [['12','ST']], 'Premium'],
  ['581', 'Lucillia',     [['12','S'],['20','S']], 'Premium'],
  // --- Supernatural ---
  ['501', 'Snowdrift',    [['12','H'],['20','S']],  'Supernatural'],
  ['502', 'Sleet',        [['12','H'],['12','S'],['20','S']], 'Supernatural'],
  ['503', 'Circa',        [['12','H'],['20','S']],  'Supernatural'],
  ['504', 'Lumena',       [['12','H']],  'Supernatural'],
  ['510', 'Impermia',     [['12','H']],  'Supernatural'],
  ['514', 'Emprada',      [['12','UR']], 'Supernatural'],
  ['516', 'Locura',       [['12','H']],  'Supernatural'],
  ['540', 'Monumental',   [['12','UR']], 'Supernatural'],
  ['542', 'Mosstone',     [['12','ST']], 'Supernatural'],
  ['544', 'Auralux',      [['12','ST']], 'Supernatural'],
  ['545', 'Fossillia',    [['12','H']],  'Supernatural'],
  ['551', 'Travina',      [['12','ST'],['20','ST']], 'Supernatural'],
  ['583', 'Crestone',     [['12','H']],  'Supernatural'],
  ['550', 'Silvax',       [['12','ST']], 'Supernatural'],
  ['580', 'Fume',         [['12','H']],  'Supernatural'],
  // --- Supernatural Ultra ---
  ['505', 'Archetta',     [['12','H']],  'Supernatural Ultra'],
  ['506', 'Mirabel',      [['12','H'],['12','S'],['20','S']], 'Supernatural Ultra'],
  ['509', 'Onyxa',        [['12','H']],  'Supernatural Ultra'],
  ['534', 'Everline',     [['12','H']],  'Supernatural Ultra'],
  ['535', 'Goldesse',     [['12','H']],  'Supernatural Ultra'],
  ['536', 'Antikella',    [['12','H']],  'Supernatural Ultra'],
  ['582', 'Dolcivio',     [['12','S'],['20','S']], 'Supernatural Ultra'],
  ['507', 'Marbannova',   [['12','S'],['20','S']], 'Supernatural Ultra'],
  ['508', 'Isobellia',    [['12','S']],  'Supernatural Ultra'],
  ['511', 'Smokestone',   [['12','UR']], 'Supernatural Ultra'],
  ['512', 'Transcenda',   [['12','UR']], 'Supernatural Ultra'],
  ['513', 'Striata',      [['12','UR']], 'Supernatural Ultra'],
  ['531', 'Libretta',     [['12','H']],  'Supernatural Ultra'],
  ['533', 'Silverdrop',   [['12','H']],  'Supernatural Ultra'],
];

// ==================== Helpers ====================

async function upsertProduct(vendor_id, { name, collection, category_id, description_short }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
    VALUES ($1, $2, $3, $4, 'draft', $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendor_id, name, collection || '', category_id || null, description_short || null]);
  return result.rows[0];
}

async function upsertSku(product_id, { vendor_sku, internal_sku, variant_name, sell_by }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = COALESCE(EXCLUDED.sell_by, skus.sell_by),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft']);
  return result.rows[0];
}

async function upsertPricing(sku_id, { cost, retail_price, price_basis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [sku_id, cost, retail_price, price_basis || 'per_sqft']);
}

async function upsertPackaging(sku_id, sqft_per_box) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box)
    VALUES ($1, $2)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box)
  `, [sku_id, sqft_per_box]);
}

async function setAttr(sku_id, slug, value) {
  if (!value) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

function variantLabel(code) {
  const labels = { S2: 'Standard Slab 2cm', S3: 'Standard Slab 3cm', J2: 'Jumbo Slab 2cm', J3: 'Jumbo Slab 3cm' };
  return labels[code] || code;
}

function slabSqft(code) {
  return code.startsWith('S') ? STD_SLAB_SQFT : JUMBO_SLAB_SQFT;
}

function thicknessFromCode(code) {
  return code.endsWith('2') ? '2cm' : '3cm';
}

function tierDisplay(tier) {
  // Strip internal sub-tier markers
  return tier.replace('+', '');
}

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'CAESARSTONE'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Caesarstone', 'CAESARSTONE', 'https://www.caesarstoneus.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Caesarstone (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Caesarstone (${vendorId})`);
  }

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;

  // --- Process Quartz / Mineral / ICON (slab-based, 2cm/3cm) ---
  const SLAB_LINES = [
    { name: 'Quartz Surfaces',  prefix: 'CS',  collection: 'Quartz Surfaces',  category: CAT_QUARTZ,    material: 'Quartz',           colors: QUARTZ },
    { name: 'Mineral Surfaces', prefix: 'CSM', collection: 'Mineral Surfaces', category: CAT_QUARTZ,    material: 'Mineral (≤40% Silica)', colors: MINERAL },
    { name: 'Advanced Fusion',  prefix: 'CSI', collection: 'Advanced Fusion',  category: CAT_QUARTZ,    material: 'Advanced Fusion (Silica-Free)', colors: ICON },
  ];

  for (const line of SLAB_LINES) {
    console.log(`\n=== ${line.name} (${line.colors.length} colors) ===`);

    for (const [item, name, finishCode, availStr, tier] of line.colors) {
      const finish = FINISH_MAP[finishCode] || finishCode;
      const desc = `${name} — Caesarstone ${line.name} ${tierDisplay(tier)}, ${finish} finish`;

      const prod = await upsertProduct(vendorId, {
        name,
        collection: line.collection,
        category_id: line.category,
        description_short: desc,
      });
      if (prod.is_new) productsCreated++; else productsUpdated++;

      const variants = availStr.split(',');
      for (const v of variants) {
        const prices = TIER_PRICES[tier];
        if (!prices || !prices[v]) {
          console.log(`  [WARN] No price for ${name} variant ${v} tier ${tier}`);
          continue;
        }
        const retailPerSqft = prices[v];
        const costPerSqft = (retailPerSqft / 2.0).toFixed(2);

        const internalSku = `${line.prefix}-${item}-${v}`;
        const sku = await upsertSku(prod.id, {
          vendor_sku: item,
          internal_sku: internalSku,
          variant_name: variantLabel(v),
          sell_by: 'sqft',
        });
        if (sku.is_new) skusCreated++; else skusUpdated++;

        await upsertPricing(sku.id, {
          cost: costPerSqft,
          retail_price: retailPerSqft,
          price_basis: 'per_sqft',
        });

        await upsertPackaging(sku.id, slabSqft(v));

        await setAttr(sku.id, 'material', line.material);
        await setAttr(sku.id, 'finish', finish);
        await setAttr(sku.id, 'thickness', thicknessFromCode(v));
        await setAttr(sku.id, 'color', name);
        await setAttr(sku.id, 'size', v.startsWith('S') ? '120" x 56.5"' : '131.5" x 64.6"');
        await setAttr(sku.id, 'collection', `${tierDisplay(tier)}`);
      }

      console.log(`  ${prod.is_new ? '+' : '~'} ${name} (${item}) — ${variants.length} SKUs [${tierDisplay(tier)}]`);
    }
  }

  // --- Process Porcelain ---
  console.log(`\n=== Porcelain (${PORCELAIN.length} colors) ===`);

  for (const [item, name, skuDefs, tier] of PORCELAIN) {
    const finishLabels = [...new Set(skuDefs.map(([, fc]) => FINISH_MAP[fc] || fc))].join(' / ');
    const desc = `${name} — Caesarstone Porcelain ${tier}, ${finishLabels} finish`;

    const prod = await upsertProduct(vendorId, {
      name,
      collection: 'Porcelain',
      category_id: CAT_PORCELAIN,
      description_short: desc,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    for (const [thickMM, finishCode] of skuDefs) {
      const prices = PORC_PRICES[tier];
      const retailPerSqft = prices?.[Number(thickMM)];
      if (!retailPerSqft) {
        console.log(`  [WARN] No price for ${name} ${thickMM}mm tier ${tier}`);
        continue;
      }
      const costPerSqft = (retailPerSqft / 2.0).toFixed(2);
      const finish = FINISH_MAP[finishCode] || finishCode;
      const internalSku = `CSP-${item}-${thickMM}${finishCode}`;

      const sku = await upsertSku(prod.id, {
        vendor_sku: item,
        internal_sku: internalSku,
        variant_name: `${thickMM}mm ${finish}`,
        sell_by: 'sqft',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      await upsertPricing(sku.id, {
        cost: costPerSqft,
        retail_price: retailPerSqft,
        price_basis: 'per_sqft',
      });

      await upsertPackaging(sku.id, PORC_SLAB_SQFT);

      await setAttr(sku.id, 'material', 'Porcelain');
      await setAttr(sku.id, 'finish', finish);
      await setAttr(sku.id, 'thickness', `${thickMM}mm`);
      await setAttr(sku.id, 'color', name);
      await setAttr(sku.id, 'size', '124.5" x 61.5"');
      await setAttr(sku.id, 'collection', tier);
    }

    console.log(`  ${prod.is_new ? '+' : '~'} ${name} (${item}) — ${skuDefs.length} SKU(s) [${tier}]`);
  }

  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs: ${skusCreated} created, ${skusUpdated} updated`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
