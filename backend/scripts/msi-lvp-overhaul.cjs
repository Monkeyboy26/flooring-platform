#!/usr/bin/env node
/**
 * msi-lvp-overhaul.cjs
 *
 * Fixes MSI LVP/vinyl product grouping and image assets:
 *
 *   Phase 1 — Merge products: each collection becomes 1 product instead of 5-14
 *   Phase 2 — Update variant names: "Blonde" → "Akadia", "Brianka", etc.
 *   Phase 3 — Assign CDN images: primary detail images for each SKU
 *
 * Usage:
 *   node backend/scripts/msi-lvp-overhaul.cjs              # dry-run (default)
 *   node backend/scripts/msi-lvp-overhaul.cjs --execute     # apply changes
 *   node backend/scripts/msi-lvp-overhaul.cjs --phase 1     # run specific phase only
 *   node backend/scripts/msi-lvp-overhaul.cjs --verbose      # extra logging
 */

const { Pool } = require('pg');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;
const VERBOSE = process.argv.includes('--verbose');
const phaseIdx = process.argv.indexOf('--phase');
const PHASE_FILTER = phaseIdx !== -1 ? parseInt(process.argv[phaseIdx + 1]) : null;

const VENDOR_CODE = 'MSI';
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const COLOR_ATTR_ID = 'd50e8400-e29b-41d4-a716-446655440001';
const CDN_BASE = 'https://cdn.msisurfaces.com/images';

// ─────────────────────────────────────────────────────────────────────────────
// SKU Color Code → Full Color Name Mapping
// Built from MSI website scraping + CDN probing
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_CODE_MAP = {
  // === Cyrus / Prescott family (VTR prefix, 7X48) ===
  'AKADIA':   'Akadia',
  'AMBFOR':   'Amber Forrester',
  'AUSGRO':   'Austell Grove',
  'BARREL':   'Barrell',
  'BARSTO':   'Barnstorm',
  'BEMBRI':   'Bembridge',
  'BILLIN':   'Billingham',
  'BOSWEL':   'Boswell',
  'BRAHIL':   'Bracken Hill',
  'BRALY':    'Braly',
  'BRIANK':   'Brianka',
  'BROKIN':   'Brookings',
  'BROOKL':   'Brookline',
  'CHEHIL':   'Chester Hills',
  'CRANTO':   'Cranton',
  'DRAVEN':   'Draven',
  'DULTAI':   'Dulcet Taiga',
  'DUNOAK':   'Dunite Oak',
  'EXOTIK':   'Exotika',
  'FAUNA':    'Fauna',
  'FINELY':   'Finely',
  'GRAYTO':   'Grayton',
  'HAWTHO':   'Hawthorne',
  'HONBEL':   'Honey Bella Oak',
  'JENTA':    'Jenta',
  'KARDIG':   'Kardigan',
  'KATASH':   'Katella Ash',
  'LENCRE':   'Lenexa Creek',
  'LUDLOW':   'Ludlow',
  'MEZCLA':   'Mezcla',
  'RUNISL':   'Runmill Isle',
  'RYDER':    'Ryder',
  'SANDIN':   'Sandino',
  'STABLE':   'Stable',
  'VALGRO':   'Valleyview Grove',
  'WALWAV':   'Walnut Waves',
  'WEABRI':   'Weathered Brina',
  'WHTGRA':   'Whitfield Gray',
  'WOBABB':   'Woburn Abbey',
  'WOLFEB':   'Wolfeboro',

  // === XL abbreviated codes (VTRXL prefix, 9X60) ===
  'AKAD':     'Akadia',
  'BARR':     'Barrell',
  'BILL':     'Billingham',
  'BOSW':     'Boswell',
  'BRAH':     'Bracken Hill',
  'BRAL':     'Braly',
  'BRIA':     'Brianka',
  'BROOK':    'Brookline',
  'DUNO':     'Dunite Oak',
  'EXOT':     'Exotika',
  'FAUN':     'Fauna',
  'FINE':     'Finely',
  'GRAY':     'Grayton',
  'HAWT':     'Hawthorne',
  'KARD':     'Kardigan',
  'KATA':     'Katella Ash',
  'LUDL':     'Ludlow',
  'RUNI':     'Runmill Isle',
  'SAND':     'Sandino',
  'STAB':     'Stable',
  'WALW':     'Walnut Waves',
  'WHTG':     'Whitfield Gray',
  'WOBA':     'Woburn Abbey',
  'WOLF':     'Wolfeboro',

  // === Andover (VTR prefix) ===
  'ABINGD':   'Abingdale',
  'BAYBLO':   'Bayhill Blonde',
  'BELBRO':   'Bellamy Brooks',
  'BLYTHE':   'Blythe',
  'BRIHAV':   'Briar Haven',
  'DAKWOR':   'Dakworth',
  'DARUMB':   'Daria Umber',
  'HATFIE':   'Hatfield',
  'HIGGRE':   'Highcliffe Greige',
  'KINGRA':   'Kingsdown Gray',
  'VINTAJ':   'Vintaj',
  'WHITBY':   'Whitby White',
  'WILTON':   'Wilton',

  // === Glenridge (VTG prefix) ===
  'AGEHIC':   'Aged Hickory',
  'BLEELM':   'Bleached Elm',
  'BURACA':   'Burnished Acacia',
  'CHAOAK':   'Charcoal Oak',
  'COAMIX':   'Coastal Mix',
  'ELMASH':   'Elmwood Ash',
  'JATOBA':   'Jatoba',
  'LIMOAK':   'Lime Washed Oak',
  'MIDMAP':   'Midnight Maple',
  'RECOAK':   'Reclaimed Oak',
  'SADOAK':   'Saddle Oak',
  'TAWBIR':   'Tawny Birch',
  'TWIOAK':   'Twilight Oak',
  'WOODGR':   'Woodrift Gray',

  // === Smithcliffs (VTL prefix) ===
  'AVEASH':   'Avery Ash',
  'BROCKT':   'Brockton',
  'CLOLAN':   'Cloudland',
  'DELRAY':   'Delray',
  'DOVVIL':   'Doverville',
  'DRIFTW':   'Driftway',
  'EMRIDG':   'Emridge',
  'GLEOAK':   'Glenbury Oak',
  'HILLSD':   'Hillsdale',
  'LANOAK':   'Lanston Oak',
  'MALTON':   'Malton',
  'SUNVAL':   'Sunnyvale',

  // === Shorecliffs (VTL prefix) ===
  'BRUWOO':   'Brundinson',
  'HOUTRA':   'Houston Trail',
  'ROGHAN':   'Roghan',
  'SCHOAK':   'Schertz Oak',
  'SUNSHA':   'Sunny Shake',
  'WALBLO':   'Wallingford Blonde',
  'WIXVAL':   'Wixom Valley',

  // === Katavia (VTG prefix — shares some Glenridge colors) ===
  // (Katavia uses Glenridge color codes; those are already mapped above)

  // === Wilmont (VTG prefix — shares some Glenridge colors) ===
  // (Wilmont uses Glenridge color codes; those are already mapped above)

  // === Nove / Nove Plus / Nove Reserve (VTG prefix) ===
  'BAYBUF':   'Bayside Buff',
  'FALLON':   'Fallonton',
  'SCANDI':   'Scandi',
  'SELBOU':   'Selbourne',

  // === Studio (VTR prefix) ===
  'ADLAR':    'Adlar',
  'BOZEMA':   'Bozeman',
  'DOACK':    'Doack',
  'LARK':     'Lark',
  'MALDEN':   'Malden',
  'QUILLI':   'Quillian',
  'ROSWEL':   'Roswell',
  'SWILCA':   'Swilcan',
  'TAOS':     'Taos',
  'TIFTON':   'Tifton',

  // === XL Studio abbreviated codes ===
  'BOZMAN':   'Bozeman',
  'QUIIAN':   'Quillian',
  'SWICAN':   'Swilcan',

  // === Ashton (VTR prefix) ===
  'BERHIL':   'Bergen Hills',
  'COLPAR':   'Colston Park',
  'LOTHIL':   'Loton Hill',
  'MARBRO':   'Maracay Brown',
  'YORGRA':   'York Gray',

  // === XL Ashton abbreviated codes ===
  'BERH':     'Bergen Hills',
  'COLPA':    'Colston Park',
  'LOTH':     'Loton Hill',
  'MARB':     'Maracay Brown',
  'YORG':     'York Gray',

  // === Ashton 2.0 (VTR prefix) ===
  'BECBRU':   'Beckley Bruno',
  'BENBLO':   'Benton Blonde',
  'DILFOG':   'Dillion Fog',
  'STABLETON': 'Stableton',
  'SUNSET':   'Sunnyset',
  'BAYGRO':   'Bayside Grove',
  'BAYLIN':   'Baylin',
  'BAYSTO':   'Baystone',
  'DUNMER':   'Dunmere',
  'MILHAV':   'Millhaven',
  'SANDRE':   'Sandridge',

  // === Laurel (VTR prefix) ===
  'CABANA':   'Cabana',
  'COACOT':   'Coastal Cottage',
  'FLAXEN':   'Flaxen',
  'HATHILG':  'Hatboro Hills',
  'HONHOL':   'Honey Hollow',
  'HYDHAV':   'Hyde Haven',
  'LARKIN':   'Larkin',
  'LINLOG':   'Linen Loggia',
  'MALTA':    'Malta',
  'PALMIL':   'Palmilla',
  'SADWOO':   'Saddle Wood',
  'SHAGRO':   'Shasta Grove',
  'TRANQU':   'Tranquilla',
  'BAYBUFF':  'Bayside Buff',
  'MEADOW':   'Meadow',
  'VENTAR':   'Ventar',

  // === Wayne Parc (VTR prefix) ===
  'ANDAZ':    'Andaz',
  'BLUFFV':   'Bluffview',
  'ELWOOD':   'Elwood',
  'MACLAN':   'Macland',
  'MELSHI':   'Mellshire',
  'WALDRO':   'Waldron',
  // VTT trim versions use full names
  'BLUFFVIEW': 'Bluffview',

  // === Trecento (VTR prefix) ===
  'CALLEG':   'Calacatta Legend',
  'CALMAR':   'Calacatta Marbello',
  'CALSER':   'Calacatta Serra',
  'CALVEN':   'Calacatta Venosa Gold',
  'CARAVE':   'Carrara Avell',
  'IVOREL':   'Ivorelle',
  'MOUGRA':   'Mountains Gray',
  'QUARTJ':   'Quarzo Taj',
  'STOBOU':   'Stormbound',
  'WHTOCE':   'White Ocean',
  'WINCRE':   'Windsor Crest',
  'WINISL':   'Windsor Isle',

  // === XL Trecento abbreviated codes ===
  'CAAV':     'Carrara Avell',
  'CALE':     'Calacatta Legend',
  'CALM':     'Calacatta Marbello',
  'CASE':     'Calacatta Serra',
  'CAVE':     'Calacatta Venosa Gold',
  'MOUG':     'Mountains Gray',
  'QUTA':     'Quarzo Taj',
  'WHIO':     'White Ocean',
  'KENTAZA':  'Kentazza',

  // === Kallum (VTG prefix — shares many Cyrus/Prescott colors) ===
  'BLEACH':   'Bleached',

  // === Acclima (VTG prefix) ===
  'AYLA':     'Ayla',
  'LOUHIL':   'Louise Hill',
  'MTSAND':   'Mountain Sand',
  'WALDOR':   'Waldorf',
  'WHARTO':   'Wharton',

  // === Lofterra (VTR prefix) ===
  'ALYBLA':   'Alyssa Blanc',
  'ALYCRE':   'Alyssa Crema',
  'CALBEI':   'Calacatta Beige',
  'CALCRE':   'Calacatta Crema',
  'LUMBLA':   'Lumina Blanc',
  'LUMCRE':   'Lumina Crema',
  'SERBEI':   'Serra Beige',
  'SERGRA':   'Serra Gray',

  // === Woodhills (VTW prefix) ===
  'AARBLO':   'Aaran Blonde',
  'AURGOL':   'Aurora Gold',
  'BALBUF':   'Baltic Buff',
  'BROTIM':   'Brookhaven Timber',
  'CHEHEI':   'Chelsea Heights',
  'CORASH':   'Corning Ash',
  'DOROAK':   'Doral Oak',
  'ESTOAK':   'Eston Oak',
  'KINBUF':   'Kingston Buff',
  'LIORA':    'Liora',
  'MOORVI':   'Moorville',

  // === Ladson / Mccarran (VTW prefix — shared colors) ===
  'ADROAK':   'Adriel Oak',
  'ATWOOD':   'Atwood',
  'BOURLAND': 'Bourland',
  'BRAMLETT': 'Bramlett',
  'CLAYBORNE': 'Clayborne',
  'HINTON':   'Hinton',
  'KENOAK':   'Kentsea Oak',
  'LEAOAK':   'Leander Oak',
  'MABLE':    'Mable',
  'MILLEDGE': 'Milledge',
  'MONOAK':   'Montevideo Oak',
  'NORTHCUTT': 'Northcutt',
  'SCABUF':   'Scarborough Buff',
  'THORNBURG': 'Thornburg',
  'TUABLO':   'Tualatin Blonde',
  'WAYLAND':  'Wayland',
  'WHITLOCK': 'Whitlock',

  // === Mccarran Reserve (VTW prefix — hyphenated codes) ===
  'ADR-RES':  'Adriel Oak',
  'ARDV-RES': 'Ardmore Valley',
  'BRA-RES':  'Bramlett',
  'LEA-RES':  'Leander Oak',
  'MAB-RES':  'Mable',
  'NOR-RES':  'Northcutt',
  'TUA-RES':  'Tualatin Blonde',
  'WHI-RES':  'Whitlock',

  // === Kelmore (VTW prefix) ===
  'DUNOVA':   'Dunova',
  'LAZURA':   'Lazura',
  'MESRID':   'Mesa Ridge',
  'SANDOR':   'Sandora',
  'SUNDEL':   'Sundelle',
  'VEXTON':   'Vexton',

  // === Folk (NWG prefix) ===
  'FOLCHA':   'Charcoal',
  'FOLPEA':   'Pearl',
  'FOLSIL':   'Silver',
  'FOLSKY':   'Sky Blue',

  // === Mountains (VTR prefix with HD) ===
  'HDMOUGRA': 'Mountains Gray',

  // === VTT trim versions using full/alternate color codes ===
  'MACLAND':  'Macland',
  'WALDRON':  'Waldron',
  'WEARBRI':  'Weathered Brina',

  // === Alternate spellings/codes across collections ===
  'WHIWHI':   'Whitby White',
  'WHIOCE':   'White Ocean',
  'QUATAJ':   'Quarzo Taj',
  'CALVEGO':  'Calacatta Venosa Gold',
  'LIMWAS':   'Lime Washed Oak',
  'WOOGRA':   'Woodrift Gray',
  'HATHIL':   'Hatboro Hills',

  // === Newer Cyrus 2.0 colors ===
  'TIMBRA':   'Timbra',
  'WHITMOO':  'Whitmore',

  // === Harvested collection ===
  'HDHARMAR': 'Harbor Marble',
};

// Collection → CDN slug mapping
const COLLECTION_CDN_SLUG = {
  'Cyrus':              'cyrus',
  'Cyrus 2.0':          'cyrus',      // shares CDN images with Cyrus
  'XL Cyrus':           'xl-cyrus',
  'Prescott':           'prescott',
  'XL Prescott':        'xl-prescott',
  'Andover':            'andover',
  'Glenridge':          'glenridge',
  'Smithcliffs':        'smithcliffs',
  'Shorecliffs':        'shorecliffs',
  'Katavia':            'katavia',
  'Wilmont':            'wilmont',
  'Nove':               'nove',
  'Nove Plus':          'nove-plus',
  'Nove Reserve':       'nove-reserve',
  'Studio':             'studio',
  'XL Studio':          'xl-studio',
  'Ashton':             'ashton',
  'Ashton 2.0':         'ashton-2-0',
  'XL Ashton':          'xl-ashton',
  'Laurel':             'laurel',
  'Laurel Reserve':     'laurel-reserve',
  'Wayne Parc':         'wayne-parc',
  'Wayne Parc Reserve': 'wayne-parc-reserve',
  'Trecento':           'trecento',
  'XL Trecento':        'xl-trecento',
  'Kallum':             'kallum',
  'Acclima':            'acclima',
  'Ladson':             'ladson',
  'Kelmore':            'kelmore',
  'Woodhills':          'woodhills',
  'Mccarran':           'mccarran',
  'Mccarran Reserve':   'mccarran-reserve',
  'Lofterra':           'lofterra',
  'Sunnyvale':          'sunnyvale',
  'Mountains':          'mountains',
  'Folk':               'folk',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCase(str) {
  return (str || '').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Extract color code from a vendor_sku.
 * VTR{COLOR}7X48-5MM-12MIL  → COLOR
 * VTRXL{COLOR}9X60-5MM-20MIL → COLOR
 * VTG{COLOR}6X36-...         → COLOR
 * VTG{COLOR}12X24-...        → COLOR
 * VTL{COLOR}7X48-...         → COLOR
 * VTW{COLOR}7X48-...         → COLOR
 * VTT{COLOR}-EC              → COLOR (trim/accessory)
 */
function extractColorCode(vendorSku) {
  if (!vendorSku) return null;
  const sku = vendorSku.toUpperCase();

  // Trim/accessories: VTT{COLOR}-{TRIM_TYPE}
  let m = sku.match(/^VTT(.+?)-(EC|ECL|FSN|FSNL|OSN|QR|SR|SRL|ST|RT|T|4-IN-1)(-EE|-SR|-W)?(\s|$)/);
  if (m) return m[1];

  // XL planks: VTRXL{COLOR}{SIZE} — size can have decimals (e.g., 9X60, 18X36)
  m = sku.match(/^VTRXL(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Standard planks: VTR{COLOR}{SIZE} — size like 7X48, 9X60, 24X48, 9X72, 12X24
  m = sku.match(/^VTR(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Glue-down: VTG{COLOR}{SIZE} — size like 6X36, 9X48, 7X48, 12X24
  m = sku.match(/^VTG(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Laminate-style: VTL{COLOR}{SIZE} — size like 7X48, 7X50, 9X87
  m = sku.match(/^VTL(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Wood/engineered: VTW{COLOR}{SIZE} — size like 6.5X48, 7.5X75, 9.5X86
  m = sku.match(/^VTW(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Folk wall tile: NWG{COLOR}{SIZE}
  m = sku.match(/^NWG(.+?)[-]?\d+\.?\d*X\d+/);
  if (m) return m[1];

  // Legacy LVP: LPAVN{COLOR}{DIGITS}
  m = sku.match(/^LPAVN(.+?)\d{3,}/);
  if (m) return m[1];

  return null;
}

/**
 * HEAD-check a URL to see if it returns 200.
 */
function probeUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Rate-limited probe (avoid hammering CDN)
let _lastProbe = 0;
async function rateLimitedProbe(url) {
  const now = Date.now();
  const wait = Math.max(0, _lastProbe + 50 - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastProbe = Date.now();
  return probeUrl(url);
}

/**
 * Generate CDN URL candidates for a color in a collection.
 */
// CDN slug overrides: when color name → slug doesn't match CDN file naming
const CDN_SLUG_OVERRIDES = {
  'Dulcet Taiga':   'dulles-tails',
  'Honey Bella Oak': 'honey-bella-oak',
};

function cdnCandidates(collectionSlug, colorName) {
  const cs = CDN_SLUG_OVERRIDES[colorName] || slugify(colorName);
  if (!cs || !collectionSlug) return [];

  const urls = [];

  // Primary pattern: /lvt/detail/{collection}-{color}-vinyl-flooring.jpg
  urls.push(`${CDN_BASE}/lvt/detail/${collectionSlug}-${cs}-vinyl-flooring.jpg`);

  // Without collection prefix (works for some Andover colors)
  urls.push(`${CDN_BASE}/lvt/detail/${cs}-vinyl-flooring.jpg`);

  // Colornames with collection suffix
  urls.push(`${CDN_BASE}/colornames/${cs}-${collectionSlug}.jpg`);

  // Colornames plain
  urls.push(`${CDN_BASE}/colornames/${cs}.jpg`);

  // Engineered hardwood patterns (Ladson, Mccarran, Kelmore, Woodhills)
  urls.push(`${CDN_BASE}/hardwood/detail/${collectionSlug}-${cs}-engineered-hardwood.jpg`);
  urls.push(`${CDN_BASE}/hardwood/detail/${cs}-engineered-hardwood.jpg`);
  urls.push(`${CDN_BASE}/hardwood/${collectionSlug}-${cs}.jpg`);

  // Waterproof hybrid (Smithcliffs, Shorecliffs)
  urls.push(`${CDN_BASE}/lvt/detail/${collectionSlug}-${cs}-waterproof-flooring.jpg`);

  return [...new Set(urls.filter(u => !u.includes('--') && !u.endsWith('-.jpg')))];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Merge Products
// ─────────────────────────────────────────────────────────────────────────────

async function phaseMergeProducts(client) {
  console.log('\n═══ Phase 1: Merge Products ═══');

  // Get all LVP products grouped by collection
  const { rows: products } = await client.query(`
    SELECT p.id, p.name, p.collection, p.display_name, p.slug, p.category_id, p.status,
           COUNT(s.id) as sku_count
    FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND (c.slug = 'lvp-plank' OR c.name ILIKE '%vinyl%' OR c.name ILIKE '%lvp%')
    GROUP BY p.id, p.name, p.collection, p.display_name, p.slug, p.category_id, p.status
    ORDER BY p.collection, p.name
  `, [VENDOR_ID]);

  // Group by collection
  const byCollection = new Map();
  for (const p of products) {
    const coll = p.collection || 'Unknown';
    if (!byCollection.has(coll)) byCollection.set(coll, []);
    byCollection.get(coll).push(p);
  }

  let mergedCount = 0;
  let deactivatedCount = 0;

  for (const [collection, prods] of byCollection) {
    if (prods.length <= 1) continue; // Already single product

    // Sort: most SKUs first, then lowest ID as tiebreaker
    prods.sort((a, b) => parseInt(b.sku_count) - parseInt(a.sku_count) || a.id.localeCompare(b.id));

    const keeper = prods[0];
    const others = prods.slice(1);

    const totalSkus = prods.reduce((s, p) => s + parseInt(p.sku_count), 0);
    console.log(`\n  ${collection}: ${prods.length} products → 1 (keeper: "${keeper.name}", ${totalSkus} total SKUs)`);

    if (VERBOSE) {
      for (const p of prods) {
        console.log(`    ${p.id === keeper.id ? '✓' : '✗'} "${p.name}" (${p.sku_count} SKUs)`);
      }
    }

    if (DRY_RUN) {
      mergedCount += others.length;
      deactivatedCount += others.length;
      continue;
    }

    const otherIds = others.map(p => p.id);

    // Move all SKUs to the keeper product
    const { rowCount: movedSkus } = await client.query(
      `UPDATE skus SET product_id = $1 WHERE product_id = ANY($2::uuid[])`,
      [keeper.id, otherIds]
    );
    console.log(`    Moved ${movedSkus} SKUs to keeper`);

    // Move SKU-level media assets to keeper product
    const { rowCount: movedMedia } = await client.query(
      `UPDATE media_assets SET product_id = $1 WHERE product_id = ANY($2::uuid[]) AND sku_id IS NOT NULL`,
      [keeper.id, otherIds]
    );
    if (movedMedia > 0) console.log(`    Moved ${movedMedia} SKU-level media assets`);

    // Delete product-level media from merged-away products (generic color-bucket images)
    const { rowCount: deletedMedia } = await client.query(
      `DELETE FROM media_assets WHERE product_id = ANY($1::uuid[]) AND sku_id IS NULL`,
      [otherIds]
    );
    if (deletedMedia > 0) console.log(`    Removed ${deletedMedia} product-level media from merged products`);

    // Soft-delete the other products
    await client.query(
      `UPDATE products SET is_active = false, status = 'discontinued' WHERE id = ANY($1::uuid[])`,
      [otherIds]
    );
    console.log(`    Deactivated ${otherIds.length} products`);

    // Clean up keeper: rename to just the collection name
    const cleanName = collection;
    const cleanSlug = slugify(collection);
    const displayName = `${collection} Luxury Vinyl Plank`;

    // Use savepoint to handle potential slug/name conflicts gracefully
    await client.query('SAVEPOINT rename_keeper');
    try {
      await client.query(
        `UPDATE products SET name = $1, display_name = $2, slug = $3 WHERE id = $4`,
        [cleanName, displayName, cleanSlug, keeper.id]
      );
      await client.query('RELEASE SAVEPOINT rename_keeper');
      console.log(`    Renamed keeper to "${cleanName}"`);
    } catch (renameErr) {
      await client.query('ROLLBACK TO SAVEPOINT rename_keeper');
      // Try with a more specific slug
      const fallbackSlug = `${cleanSlug}-lvp`;
      try {
        await client.query('SAVEPOINT rename_keeper2');
        await client.query(
          `UPDATE products SET name = $1, display_name = $2, slug = $3 WHERE id = $4`,
          [cleanName, displayName, fallbackSlug, keeper.id]
        );
        await client.query('RELEASE SAVEPOINT rename_keeper2');
        console.log(`    Renamed keeper to "${cleanName}" (slug: ${fallbackSlug})`);
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT rename_keeper2');
        console.log(`    ⚠ Could not rename keeper (constraint conflict), keeping original name`);
      }
    }

    mergedCount += others.length;
    deactivatedCount += others.length;
  }

  console.log(`\n  Summary: ${mergedCount} products merged, ${deactivatedCount} deactivated`);
  return { mergedCount, deactivatedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Update Variant Names
// ─────────────────────────────────────────────────────────────────────────────

async function phaseUpdateVariantNames(client) {
  console.log('\n═══ Phase 2: Update Variant Names ═══');

  // Get all active LVP SKUs
  const { rows: skus } = await client.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.variant_type, p.collection, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND s.status = 'active'
      AND (c.slug = 'lvp-plank' OR c.name ILIKE '%vinyl%' OR c.name ILIKE '%lvp%')
    ORDER BY p.collection, s.vendor_sku
  `, [VENDOR_ID]);

  let updatedCount = 0;
  let unmappedCodes = new Set();

  for (const sku of skus) {
    const colorCode = extractColorCode(sku.vendor_sku);
    if (!colorCode) {
      if (VERBOSE) console.log(`    ? Cannot parse color from ${sku.vendor_sku}`);
      continue;
    }

    const fullName = COLOR_CODE_MAP[colorCode];
    if (!fullName) {
      unmappedCodes.add(`${colorCode} (${sku.vendor_sku}, collection: ${sku.collection})`);
      continue;
    }

    // Determine variant_type for trims
    let variantType = sku.variant_type || null;
    if (sku.vendor_sku.startsWith('VTT')) {
      variantType = 'accessory';
    }

    // Build a descriptive variant name for accessories
    let newVariantName = fullName;
    if (sku.vendor_sku.startsWith('VTT')) {
      // Extract trim type
      const trimMatch = sku.vendor_sku.match(/-(EC|ECL|FSN|FSNL|OSN|QR|SR|SRL|ST|RT|T|4-IN-1)(-EE|-SR|-W)?/);
      if (trimMatch) {
        const trimNames = {
          'EC': 'End Cap', 'ECL': 'End Cap Long', 'FSN': 'Flush Stair Nose',
          'FSNL': 'Flush Stair Nose Long', 'OSN': 'Overlapping Stair Nose',
          'QR': 'Quarter Round', 'SR': 'Reducer', 'SRL': 'Reducer Long',
          'ST': 'Stair Tread', 'RT': 'Riser Tread', 'T': 'T-Molding',
          '4-IN-1': '4-in-1 Transition',
        };
        const trimName = trimNames[trimMatch[1]] || trimMatch[1];
        newVariantName = `${fullName} ${trimName}`;
      }
    }

    const currentType = sku.variant_type || null;
    if (sku.variant_name === newVariantName && variantType === currentType) continue;

    if (VERBOSE) {
      console.log(`    ${sku.vendor_sku}: "${sku.variant_name}" → "${newVariantName}"`);
    }

    if (!DRY_RUN) {
      // Update variant_name; only update variant_type if it changed
      if (variantType !== currentType) {
        await client.query(
          `UPDATE skus SET variant_name = $1, variant_type = $2 WHERE id = $3`,
          [newVariantName, variantType, sku.id]
        );
      } else {
        await client.query(
          `UPDATE skus SET variant_name = $1 WHERE id = $2`,
          [newVariantName, sku.id]
        );
      }

      // Upsert the color attribute with the actual color name
      await client.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
      `, [sku.id, COLOR_ATTR_ID, fullName]);
    }

    updatedCount++;
  }

  console.log(`\n  Updated: ${updatedCount} SKU variant names`);

  if (unmappedCodes.size > 0) {
    console.log(`\n  ⚠ Unmapped color codes (${unmappedCodes.size}):`);
    for (const code of [...unmappedCodes].sort()) {
      console.log(`    - ${code}`);
    }
  }

  return { updatedCount, unmappedCodes: unmappedCodes.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Assign CDN Images
// ─────────────────────────────────────────────────────────────────────────────

async function phaseAssignImages(client) {
  console.log('\n═══ Phase 3: Assign CDN Images ═══');

  // Get all active LVP SKUs that don't already have a primary image
  const { rows: skus } = await client.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.product_id,
           p.collection, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND s.status = 'active'
      AND (c.slug = 'lvp-plank' OR c.name ILIKE '%vinyl%' OR c.name ILIKE '%lvp%')
      AND s.vendor_sku NOT LIKE 'VTT%'
      AND ma.id IS NULL
    ORDER BY p.collection, s.vendor_sku
  `, [VENDOR_ID]);

  console.log(`  ${skus.length} SKUs without primary images`);

  // Build a cache of probed URLs to avoid re-checking
  const probeCache = new Map();

  let assignedCount = 0;
  let failedCount = 0;
  const failedSkus = [];

  // Group SKUs by collection+color for efficient probing
  const skuGroups = new Map();
  for (const sku of skus) {
    const colorCode = extractColorCode(sku.vendor_sku);
    const colorName = colorCode ? COLOR_CODE_MAP[colorCode] : null;
    if (!colorName) continue;

    const key = `${sku.collection}|||${colorName}`;
    if (!skuGroups.has(key)) {
      skuGroups.set(key, { collection: sku.collection, colorName, skus: [] });
    }
    skuGroups.get(key).skus.push(sku);
  }

  console.log(`  ${skuGroups.size} unique collection+color combinations to probe\n`);

  let groupIdx = 0;
  for (const [key, group] of skuGroups) {
    groupIdx++;
    const collSlug = COLLECTION_CDN_SLUG[group.collection];
    if (!collSlug) {
      if (VERBOSE) console.log(`    ? No CDN slug for collection "${group.collection}"`);
      failedCount += group.skus.length;
      continue;
    }

    const candidates = cdnCandidates(collSlug, group.colorName);
    let foundUrl = null;

    for (const url of candidates) {
      if (probeCache.has(url)) {
        if (probeCache.get(url)) { foundUrl = url; break; }
        continue;
      }
      const ok = await rateLimitedProbe(url);
      probeCache.set(url, ok);
      if (ok) { foundUrl = url; break; }
    }

    // Also try without collection prefix as fallback
    if (!foundUrl) {
      const colorSlug = slugify(group.colorName);
      const fallback = `${CDN_BASE}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`;
      if (!probeCache.has(fallback)) {
        const ok = await rateLimitedProbe(fallback);
        probeCache.set(fallback, ok);
        if (ok) foundUrl = fallback;
      } else if (probeCache.get(fallback)) {
        foundUrl = fallback;
      }
    }

    if (foundUrl) {
      if (groupIdx <= 20 || VERBOSE) {
        console.log(`    ✓ ${group.collection} / ${group.colorName} → ${foundUrl.split('/').pop()} (${group.skus.length} SKUs)`);
      }

      if (!DRY_RUN) {
        for (const sku of group.skus) {
          await client.query(`
            INSERT INTO media_assets (id, product_id, sku_id, url, original_url, asset_type, sort_order)
            VALUES ($1, $2, $3, $4, $4, 'primary', 0)
            ON CONFLICT DO NOTHING
          `, [uuidv4(), sku.product_id, sku.sku_id, foundUrl]);
        }
      }

      assignedCount += group.skus.length;
    } else {
      if (VERBOSE) {
        console.log(`    ✗ ${group.collection} / ${group.colorName} — no CDN image found`);
      }
      failedCount += group.skus.length;
      failedSkus.push(`${group.collection} / ${group.colorName}`);
    }
  }

  if (groupIdx > 20 && !VERBOSE) {
    console.log(`    ... and ${groupIdx - 20} more (use --verbose to see all)`);
  }

  console.log(`\n  Assigned: ${assignedCount} SKUs, Failed: ${failedCount} SKUs`);
  if (failedSkus.length > 0 && failedSkus.length <= 30) {
    console.log(`\n  Missing CDN images for:`);
    for (const s of failedSkus) console.log(`    - ${s}`);
  }

  return { assignedCount, failedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MSI LVP Overhaul — ${DRY_RUN ? 'DRY RUN' : 'EXECUTING'}`);
  console.log(`${'═'.repeat(60)}`);

  if (DRY_RUN) {
    console.log('\n  ℹ  This is a dry run. No changes will be made.');
    console.log('  ℹ  Use --execute to apply changes.\n');
  }

  const client = await pool.connect();
  const results = {};

  try {
    if (!DRY_RUN) await client.query('BEGIN');

    if (!PHASE_FILTER || PHASE_FILTER === 1) {
      results.phase1 = await phaseMergeProducts(client);
    }

    if (!PHASE_FILTER || PHASE_FILTER === 2) {
      results.phase2 = await phaseUpdateVariantNames(client);
    }

    if (!PHASE_FILTER || PHASE_FILTER === 3) {
      results.phase3 = await phaseAssignImages(client);
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\n  ✓ All changes committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    console.error('\n  ✗ Error — rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Summary');
  console.log(`${'═'.repeat(60)}`);
  if (results.phase1) {
    console.log(`  Phase 1: ${results.phase1.mergedCount} products merged, ${results.phase1.deactivatedCount} deactivated`);
  }
  if (results.phase2) {
    console.log(`  Phase 2: ${results.phase2.updatedCount} variant names updated, ${results.phase2.unmappedCodes} unmapped codes`);
  }
  if (results.phase3) {
    console.log(`  Phase 3: ${results.phase3.assignedCount} images assigned, ${results.phase3.failedCount} failed`);
  }
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
