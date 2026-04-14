/**
 * MSI Quartz Countertop Pricelist Import
 * Source: 2025 QZ PriceList - CAOR - Oct'25.pdf
 *
 * Prices are $/sq ft. Bundle = dealer cost, Contractor = retail.
 * Each group has 2cm and 3cm pricing.
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Group pricing: [bundle_2cm, bundle_3cm, contractor_2cm, contractor_3cm]
const GROUP_PRICES = {
  0: [8.74, 11.86, 11.06, 14.55],
  1: [9.99, 13.78, 12.19, 16.11],
  2: [12.15, 15.85, 14.21, 18.19],
  3: [15.09, 18.80, 18.26, 22.52],
  4: [17.81, 22.12, 21.54, 26.40],
  5: [20.70, 26.20, 24.43, 30.48],
  6: [22.39, 28.39, 26.12, 32.68],
  7: [26.04, 32.98, 30.87, 38.37],
  8: [30.05, 38.06, 36.01, 44.57],
};

// SKU stem → group mapping (from PDF)
// Stem is the part between QSL- and -2CM/-3CM
const STEM_TO_GROUP = {
  // Group 0
  'ARUCAWHT': 0, 'BAYSHRSND': 0, 'BIANPEPPER': 0, 'FRSTWHT': 0,
  'ICEDWHT': 0, 'ICEDGRY': 0, 'MACABOGRY': 0, 'PEBROCK': 0, 'SPRWHT': 0,
  // Group 1
  'ARCWHT': 1, 'CARDELPHI': 1, 'CARMIKSA': 1, 'CARTRIGATO': 1,
  'MANHATGRY': 1, 'PEPPERWHT': 1, 'SNOWHTE': 1,
  // Group 2
  'CALAALTO': 2, 'CALABELAROS': 2, 'CARBREVE': 2, 'CALADUOLINA': 2,
  'CALARUSTA': 2, 'CARMARMI': 2, 'CARRMIST': 2, 'CARMORRO': 2,
  'FOSGRY': 2, 'MARFITAJ': 2, 'MERIGRY': 2, 'MIDMAJ': 2,
  'MYSTGRY': 2, 'NEWCALALAZA': 2, 'NEWCARMARMI': 2, 'SPRBLK': 2, 'STELLARWHT': 2,
  // Group 3
  'ALABWHT': 3, 'CALABALI': 3, 'CALAELYSIO': 3, 'CALAIDILLIO': 3,
  'CALALAVASA': 3, 'CALALAZA': 3, 'CALANUVINA': 3, 'CALASIERRA': 3,
  'CALARIVESSA': 3, 'CALAULTRA': 3, 'CALAVENICE': 3, 'CALICOWHT': 3,
  'CARLUMOS': 3, 'CASHTAJ': 3, 'CONCERTO': 3, 'FAIWHT': 3,
  'GRYLAGOON': 3, 'MARBLNC': 3, 'MONTCLRWHT': 3,
  // Group 3 book-match variants
  'CALACLSQUE': 3, // default for unbook-match; book-match is Group4
  'STACLSQUE': 3,
  'CALAVERONA': 3,
  // Group 4
  'BABYLONGRY': 4, 'BLANARA': 4, 'BLANSTAT': 4, 'CALAADONIA': 4,
  'CALABOTNICA': 4, 'CALAFIORESSA': 4, 'CALAKARMELO': 4,
  'CALALEON': 4, 'CALAPRADO': 4, 'CALAPREMATA': 4, 'CALASAFYRA': 4,
  'CASHCARR': 4, 'NEWCALALAZAGOLD': 4, 'PERWHT': 4, 'PREPLUWHT': 4,
  'SPSTNMETROPOLIS': 4, 'SPSTNMIST': 4,
  // Group 5
  'AURATAJ': 5, 'CALAAIDANA': 5, 'CALAAZULEAN': 5, 'CALADELIOS': 5,
  'CALAJADIRA': 5, 'CALALEONGOLD': 5, 'CALAMONACO': 5,
  'CALAMONTAGE': 5, 'CHAKBEI': 5, 'EROLUNA': 5, 'GALANTGRAY': 5,
  'GLACIERWHT': 5, 'MARQMID': 5, 'MIDCORVO': 5, 'PORTCRM': 5,
  'ROLLFOG': 5, 'SMKPEARL': 5,
  // Group 6
  'CALAARNO': 6, 'CALACLARA': 6, 'CALALAZAGRIGIO': 6,
  'CALALAZAORO': 6, 'CALALUMANYX': 6, 'CALAMIRAGGIO': 6,
  'CALATREVI': 6, 'CALAVALENTIN': 6, 'CALAVERNELLO': 6, 'VENCRBONA': 6,
  // Group 7
  'CALAAZAI': 7, 'CALACINELA': 7, 'CALAGOA': 7,
  'CALAMIRCOVE': 7, 'CALAMIRDUO': 7, 'CALAMIRCIELO': 7,
  'CALAMIRGOLD': 7, 'CALAMIRLUSSO': 7, 'CALAMIRSIENNA': 7,
  'CALAMIRSEAGLASS': 7, 'CALAOCELLIO': 7, 'CALAVERSA': 7,
  // Group 8
  'AZURMATT': 8, 'CALAVIRALDI': 8, 'LUMATAJ': 8,
};

// Individual pricing for special SKUs: [cost, retail] per sqft
const INDIVIDUAL_PRICES = {
  // Q Plus
  'QSL-CALAANAVA-2CM-QP': [23.30, 31.15],
  'QSL-CALACASTANA-2CM-QP': [23.30, 33.69],
  'QSL-CALALAPIZA-2CM-QP': [25.53, 33.37],
  'QSL-IVORITAJ-2CM-QP': [25.53, 33.37],
  'QSL-IVORITAJ-3CM-QP': [28.11, 35.95],
  'QSL-IVORITAJ-2CM-QP-BR': [27.58, 35.42],
  'QSL-IVORITAJ-3CM-QP-BR': [30.16, 38.00],
  'QSL-SOLITAJ-2CM-QP': [25.53, 33.37],
  'QSL-SOLITAJ-3CM-QP': [28.11, 35.95],
  'QSL-SOLITAJ-2CM-QP-BR': [27.58, 35.42],
  'QSL-SOLITAJ-3CM-QP-BR': [30.16, 38.00],
  // Matte / Concrete finishes
  'QSL-BABYLONGRY-2CM-CONCRT': [22.25, 25.98],
  'QSL-BABYLONGRY-3CM-CONCRT': [24.33, 28.61],
  'QSL-CALAMIRAGGIO-2CM-H': [24.44, 28.17],
  'QSL-CALAMIRAGGIO-3CM-H': [30.44, 34.73],
  'QSL-CALAMIRCIELO-2CM-H': [28.09, 32.92],
  'QSL-CALAMIRCIELO-3CM-H': [35.03, 40.42],
  'QSL-CALAMIRCOVE-2CM-H': [28.09, 32.92],
  'QSL-CALAMIRCOVE-3CM-H': [35.03, 40.42],
  'QSL-CALAMIRDUO-2CM-H': [28.09, 32.92],
  'QSL-CALAMIRDUO-3CM-H': [35.03, 40.42],
  'QSL-CALAMIRGOLD-2CM-H': [28.09, 32.92],
  'QSL-CALAMIRGOLD-3CM-H': [35.03, 40.42],
  'QSL-FOSGRY-2CM-MATTE': [17.42, 19.47],
  'QSL-FOSGRY-3CM-MATTE': [18.06, 20.34],
  'QSL-GRYLAGOON-2CM-CONCRT': [19.80, 22.97],
  'QSL-GRYLAGOON-3CM-CONCRT': [21.01, 24.74],
  'QSL-MIDMAJ-2CM-CONCRT': [17.42, 19.47],
  'QSL-MIDMAJ-3CM-CONCRT': [18.06, 20.34],
  'QSL-SPSTNMETROPOLIS-2CM-CONCRT': [22.25, 25.98],
  'QSL-SPSTNMETROPOLIS-3CM-CONCRT': [24.33, 28.61],
  'QSL-SPSTNMIST-2CM-CONCRT': [22.25, 25.98],
  'QSL-SPSTNMIST-3CM-CONCRT': [24.33, 28.61],
  // 1.5CM Slabs (bundle cost only, no 3cm)
  'QSL-ARCWHT-1.5CM': [8.11, 9.00],
  'QSL-CARMARMI-1.5CM': [8.50, 9.39],
  'QSL-FRSTWHT-1.5CM': [6.30, 7.19],
  'QSL-ICEDWHT-1.5CM': [6.30, 7.19],
  'QSL-MANHATGRY-1.5CM': [7.09, 7.98],
  'QSL-SPRWHT-1.5CM': [6.30, 7.19],
  // Venetian Marble
  'RSL-BIAVENATO': [5.20, 6.24],
  'RSL-POLWHT': [4.59, 5.63],
  'RSL-VANSKY': [5.20, 6.24],
};

// Book-match variants that shift to a higher group
const BOOKMATCH_OVERRIDES = {
  'CALACLSQUE': { 'BK': 4, 'UNBK': 3 },
  'STACLSQUE': { 'BK': 4, 'UNBK': 3 },
  'CALALAZA': { 'BK': 4, default: 3 },
  'CALALUCCIA': { 'BK': 6 },
  'CALAABEZZO': { 'BK': 6 },
  'CALAIZARO': { 'BK': 6 },
  'CALASOLESSIO': { 'BK': 7 },
  'CALALAZANIGHT': { 'BK': 5 },
};

function getGroupForSku(sku) {
  const upper = sku.toUpperCase();

  // Check individual prices first
  if (INDIVIDUAL_PRICES[upper]) return null; // handled separately

  // Extract stem: QSL-{STEM}-2CM or QSL-{STEM}-3CM or PSL-{STEM}...
  let stem = upper
    .replace(/^(QSL|PSL)-/, '')
    .replace(/-(2CM|3CM|1\.5CM).*$/, '')
    .replace(/-\d+.*$/, '')   // PSL size suffixes like 11226
    .replace(/\d{4,}.*$/, ''); // PSL numeric size

  // Check book-match overrides
  for (const [bmStem, groups] of Object.entries(BOOKMATCH_OVERRIDES)) {
    if (stem.startsWith(bmStem)) {
      if (upper.includes('-BK') && !upper.includes('-UNBK') && groups['BK'] != null) return groups['BK'];
      if (upper.includes('-UNBK') && groups['UNBK'] != null) return groups['UNBK'];
      if (groups.default != null) return groups.default;
    }
  }

  // Direct stem lookup
  if (STEM_TO_GROUP[stem] != null) return STEM_TO_GROUP[stem];

  // Try progressively shorter stems for compound names
  const parts = stem.split(/(?=[A-Z])/);
  for (let len = parts.length; len >= 1; len--) {
    const tryStem = parts.slice(0, len).join('');
    if (STEM_TO_GROUP[tryStem] != null) return STEM_TO_GROUP[tryStem];
  }

  return null;
}

function getPricing(sku) {
  const upper = sku.toUpperCase();

  // Individual price?
  if (INDIVIDUAL_PRICES[upper]) {
    const [cost, retail] = INDIVIDUAL_PRICES[upper];
    return { cost, retail, basis: 'per_sqft' };
  }

  const group = getGroupForSku(sku);
  if (group == null) return null;

  const prices = GROUP_PRICES[group];
  if (!prices) return null;

  const is3cm = upper.includes('-3CM');
  const cost = is3cm ? prices[1] : prices[0];
  const retail = is3cm ? prices[3] : prices[2];

  return { cost, retail, basis: 'per_sqft' };
}

async function run() {
  // Load all unpriced QSL/PSL/RSL MSI SKUs
  const result = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id AND v.code = 'MSI'
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.is_active = true
      AND (s.vendor_sku LIKE 'QSL-%' OR s.vendor_sku LIKE 'PSL-%' OR s.vendor_sku LIKE 'RSL-%')
      AND (pr.cost IS NULL OR pr.cost = 0)
    ORDER BY s.vendor_sku
  `);

  console.log(`Unpriced slab SKUs: ${result.rows.length}\n`);

  let updated = 0, skipped = 0;
  const unmatched = [];

  for (const row of result.rows) {
    const pricing = getPricing(row.vendor_sku);

    if (!pricing) {
      skipped++;
      unmatched.push(row.vendor_sku);
      continue;
    }

    await pool.query(`
      INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (sku_id)
      DO UPDATE SET cost = $2, retail_price = $3, price_basis = $4
    `, [row.sku_id, pricing.cost, pricing.retail, pricing.basis]);

    updated++;
    console.log(`  ${row.vendor_sku}: cost=$${pricing.cost} retail=$${pricing.retail}`);
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Unmatched: ${skipped}`);

  if (unmatched.length > 0) {
    console.log(`\nUnmatched SKUs:`);
    for (const u of unmatched) console.log(`  ${u}`);
  }

  // Final check
  const remaining = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id AND v.code = 'MSI'
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.is_active = true AND (pr.cost IS NULL OR pr.cost = 0)
  `);
  console.log(`\nTotal MSI SKUs still unpriced: ${remaining.rows[0].cnt}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
