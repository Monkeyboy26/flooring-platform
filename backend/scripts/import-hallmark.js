/**
 * Hallmark Floors (Big D Supply) — Full Vendor Import
 *
 * Source: Big D Floor Covering Supplies Hallmark Price Sheets Q1-2026
 * Effective: 12/15/2025
 *
 * 15 collections: 14 hardwood + 1 SPC (Courtier)
 * Prices are dealer cost from Big D Supply.
 * Retail = cost × 2 (standard hardwood markup, adjustable in admin).
 *
 * Usage: docker compose exec api node scripts/import-hallmark.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ── Categories ──
const CAT = {
  eng: '650e8400-e29b-41d4-a716-446655440021',   // Engineered Hardwood
  solid: '650e8400-e29b-41d4-a716-446655440022',  // Solid Hardwood
  lvp: '650e8400-e29b-41d4-a716-446655440030',    // Luxury Vinyl (SPC)
};

// ── Attribute IDs ──
const ATTR = {
  color:     'd50e8400-e29b-41d4-a716-446655440001',
  species:   '9042479c-b17d-4353-905b-de75332e74ef',
  size:      'd50e8400-e29b-41d4-a716-446655440004',
  finish:    'd50e8400-e29b-41d4-a716-446655440003',
  thickness: 'd50e8400-e29b-41d4-a716-446655440010',
};

// Accessory prices (same across all hardwood collections)
const ACC_PRICES = { reducer: 74.00, stairNose: 109.00, threshold: 74.00, tMold: 74.00 };

// Retail markup multiplier (cost × MARKUP = retail)
const MARKUP = 2.0;

// ── Collection definitions ──
// Each collection: { name, cat, desc, size, colors: [[species, color, sku, sfCtn, boxPlt, lbsCtn, costSqft], ...] }
// Accessory SKUs are derived: strip trailing "-NN" from flooring SKU, then append RD/SN/TH/TM

const COLLECTIONS = [
  // ─── 1. Alta Vista ───
  {
    name: 'Alta Vista', cat: 'eng',
    desc: '4mm Sawn Cut Face, Lightly Sculpted & Wire Brushed, Handcrafted Bevel, Truecore Hardwood Centerply, Nu Oil Finish',
    size: '5/8" x 7-1/2" x RL-86"',
    colors: [
      ['Oak','Balboa','AV75OBAL-25',27,30,57,6.85],
      ['Oak','Malibu','AV75OMAL-25',27,30,57,6.85],
      ['Oak','Laguna','AV75OLAG-25',27,30,57,6.85],
      ['Oak','Del Mar','AV75ODEL-25',27,30,57,6.85],
      ['Oak','Big Sur','AV75OBIG-25',27,30,57,6.85],
      ['Oak','Cambria','AV75OCAM-25',27,30,57,6.85],
      ['Oak','Pismo','AV75OPIS-25',27,30,57,6.85],
      ['Oak','Santa Monica','AV75OSAN-25',27,30,57,6.85],
      ['Oak','Venice','AV75OVEN-25',27,30,57,6.85],
      ['Oak','Huntington','AV75OHUN-25',27,30,57,6.85],
      ['Oak','Cardiff','AV75OCRD-25',27,30,57,6.85],
      ['Oak','Doheny','AV75ODOH-25',27,30,57,6.85],
    ],
  },
  // ─── 2. Avenue ───
  {
    name: 'Avenue', cat: 'eng',
    desc: '4mm Sawn Cut Face, Wire Brush (Hickory & Oak) / Light Hand Sculpted (Maple), Handcrafted Micro Bevel, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '5/8" x 9-1/2" x 7\'2" RL',
    colors: [
      ['Maple','Pennsylvania','AVE95PENM',22.74,48,48,7.75],
      ['Maple','Lombard','AVE95LOMM',22.74,48,48,7.75],
      ['Oak','Sunset','AVE95SUNO',22.74,48,48,7.75],
      ['Oak','Rodeo','AVE95RODO',22.74,48,48,7.75],
      ['Oak','Ocean Drive','AVE95OCEO',22.74,48,48,7.75],
      ['Oak','Mulholland','AVE95MULO',22.74,48,48,7.75],
      ['Oak','Wilshire','AVE95WILO',22.74,48,48,7.75],
      ['Hickory','Michigan','AVE95MICH',22.74,48,50,7.75],
      ['Hickory','Belle Meade','AVE95BELH',22.74,48,50,7.75],
      ['Hickory','Newbury','AVE95NEWH',22.74,48,50,7.75],
    ],
  },
  // ─── 3. ATC (American Traditional Classics) ───
  // Multiple sub-groups with different sizes/grades
  {
    name: 'ATC', cat: 'eng',
    desc: 'Micro Bevel, Smooth / Glaze Tek Finish, 3mm Sawn Face Wear Layer, Truecore Hardwood Centerply',
    size: '1/2" x 3-1/4" & 5" x RL-7\'2"',
    colors: [
      // 1/2" x 3.25", Select Grade
      ['Red Oak','Natural','ATC325NATRO-S',23.47,60,37,6.49],
      ['White Oak','Natural','ATC325NATWO-S',23.47,60,37,6.49],
      ['Red Oak','Auburn','ATC325AUBRO-S',23.47,60,37,6.49],
      ['White Oak','Saddle','ATC325SADWO-S',23.47,60,37,6.49],
      ['White Oak','Linen','ATC325LINWO-S',23.47,60,37,6.49],
      // 1/2" x 3.25", Country Grade
      ['Walnut','Natural','ATC325NATW-M',23.47,60,37,8.65],
      // 1/2" x 5", Character Grade
      ['Red Oak','Auburn','ATC5AUBRO-C',24.06,60,39,7.05],
      ['White Oak','Saddle','ATC5SADWO-C',24.06,60,39,7.05],
      ['White Oak','Linen','ATC5LINWO-C',24.06,60,39,7.05],
      // 1/2" x 5", Select Grade
      ['Red Oak','Natural','ATC5NATRO-S',24.06,60,39,7.19],
      ['White Oak','Natural','ATC5NATWO-S',24.06,60,39,7.19],
      // 1/2" x 5", Country Grade
      ['Hickory','Buckskin','ATC5BUCH-M',24.06,60,39,7.99],
      ['Hickory','Natural','ATC5NATH-M',24.06,60,39,7.99],
      ['Maple','Haystack','ATC5HAYM-M',24.06,60,39,7.99],
      ['Walnut','Natural','ATC5NATW-M',24.06,60,39,9.09],
    ],
  },
  // ─── 4. Grain & Saw ───
  {
    name: 'Grain & Saw', cat: 'eng',
    desc: 'Lightly Sculpted (Maple & Hickory), Wire Brushed (Oak) with Saw Mark, Handcrafted Micro Bevel, 1.5mm Sliced Face, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '7/16" x 6" x RL-74"',
    colors: [
      ['Maple','Greene','GAS6GREM',24.93,66,34,4.79],
      ['Maple','Tiffany','GAS6TIFM',24.93,66,34,4.79],
      ['Hickory','Hoffman','GAS6HOFH',24.93,66,34,4.79],
      ['Hickory','Larsson','GAS6LARH',24.93,66,34,4.79],
      ['Hickory','Stickley','GAS6STIH',24.93,66,34,4.79],
      ['Oak','Ballentine','GAS6BALO',24.93,66,34,4.79],
      ['Oak','Morris','GAS6MORO',24.93,66,34,4.79],
      ['Oak','Ruskin','GAS6RUSO',24.93,66,34,4.79],
    ],
  },
  // ─── 5. Crestline (Solid) ───
  {
    name: 'Crestline', cat: 'solid',
    desc: '3/4" Solid Hardwood, Light-Medium Hand Scraped, Wire Brushed, Handcrafted Bevel, Nu Oil Finish',
    size: '3/4" x 5" x RL',
    colors: [
      ['Hickory','Sanford','SCR5SANH',22.60,52,73.15,7.85],
      ['Hickory','Rainier','SCR5RAIH',22.60,52,73.15,7.85],
      ['Hickory','Stratton','SCR5STRH',22.60,52,73.15,7.85],
      ['Hickory','Hood','SCR5HOON-20',22.60,52,73.15,7.85],
      ['Oak','Monroe','SCR5MONOF',22.60,52,61.58,7.29],
      ['Oak','Porter','SCR5PORRO',22.60,52,61.58,7.29],
      ['Oak','Augusta','SCR5AUGOF',22.60,52,61.58,7.29],
      ['Oak','Geneva','SCR5GENO-20',22.60,52,61.58,7.29],
      ['Oak','Montblanc','SCR5MONTO-20',22.60,52,61.58,7.29],
      ['Oak','Shasta','SCR5SHAOF-20',22.60,52,61.58,7.29],
    ],
  },
  // ─── 6. Monterey ───
  {
    name: 'Monterey', cat: 'eng',
    desc: 'Lightly Sculpted Hand Scraped & Wire Brushed, Handcrafted Micro Bevel, 2mm Slice Cut Face, Truecore Hardwood Centerply, TrueMark Glaze Tek Finish',
    size: '1/2" x 4, 6, 8" x RL-72"',
    colors: [
      ['Hickory','Casita','MY468CASH',37.50,36,65,5.59],
      ['Hickory','Gaucho','MY468GAUH',37.50,36,65,5.59],
      ['Hickory','Puebla','MY468PUEH',37.50,36,65,5.59],
      ['Hickory','Ranchero','MY468RANH',37.50,36,65,5.59],
      ['Hickory','Palomino','MY468PALH',37.50,36,65,5.59],
      ['Red Oak','Appaloosa','MY468APRO',37.50,36,65,5.59],
      ['Red Oak','Adobe','MY468ADRO',37.50,36,65,5.59],
      ['Red Oak','Cantina','MY468CARO',37.50,36,65,5.59],
      ['Red Oak','Calgary','MY468CGRO',37.50,36,65,5.59],
      ['Oak','Villa','MY468VILO',37.50,36,65,5.59],
      ['Oak','Cheyenne','MY468CHEO',37.50,36,65,5.59],
      ['Oak','Alhambra','MY468ALHO',37.50,36,65,5.59],
    ],
  },
  // ─── 7. Novella ───
  {
    name: 'Novella', cat: 'eng',
    desc: 'Lightly Sculpted Hand Scraped (Maple & Hickory), Wire Brushed (Oak), Handcrafted Micro Bevel, 7/16" 1.5mm Slice Cut Face, Truecore Hardwood Centerply, Nu Oil (Oak) / TrueMark Glaze Tek (Hickory & Maple)',
    size: '7/16" x 6" x RL-74"',
    colors: [
      // Glaze Tek finish
      ['Maple','Frost','NO6FROM-18',24.93,66,38,4.55],
      ['Hickory','Faulkner','NO6FAUH-18',24.93,66,38,4.55],
      ['Hickory','Thoreau','NO6THOH-18',24.93,66,38,4.55],
      ['Hickory','Eliot','NO6ELIH-18',24.93,66,38,4.55],
      ['Maple','Alcott','NO6ALCM-19',24.93,66,38,4.55],
      ['Maple','Williams','NO6WILM-19',24.93,66,38,4.55],
      ['Hickory','Rand','NO6RANH-19',24.93,66,38,4.55],
      ['Hickory','Bradbury','NO6BRAH-25',24.93,66,38,4.55],
      // Nu Oil finish (Oak)
      ['Oak','Hemingway','NO6HEMO-18',24.93,66,38,4.55],
      ['Oak','Twain','NO6TWAO-18',24.93,66,38,4.55],
      ['Oak','Hawthorne','NO6HAWO-18',24.93,66,38,4.55],
      ['Oak','Emerson','NO6EMEO-19',24.93,66,38,4.55],
      ['Oak','Whitman','NO6WHIO-19',24.93,66,38,4.55],
      // Nu Oil (Red Oak) - new colors
      ['Red Oak','Morrison','NO6MORRO-25',24.93,66,38,4.55],
      ['Red Oak','London','NO6LONRO-25',24.93,66,38,4.55],
      ['Red Oak','Salinger','NO6SALRO-25',24.93,66,38,4.55],
      ['Red Oak','Lovecraft','NO6LOVRO-25',24.93,66,38,4.55],
    ],
  },
  // ─── 8. Organic Solid ───
  {
    name: 'Organic Solid', cat: 'solid',
    desc: '3/4" Solid Hardwood, Hand Scraped with Sawn Cut Face, Handcrafted Bevel, Nu Oil Finish',
    size: '3/4" x 3-1/4" & 4" x RL-6\'2"',
    colors: [
      ['Oak','Caraway','SOR34CARO',16.70,55,43,7.99],
      ['Oak','Fennel','SOR34FENO',16.70,55,43,7.99],
      ['Oak','Tarragon','SOR34TARO',16.70,55,43,7.99],
      ['Oak','Sorrel','SO34SORO',16.70,55,43,7.99],
      ['Hickory','Moroccan','SOR34MORH',16.70,55,50,7.99],
      ['Hickory','Tulsi','SOR34TULH',16.70,55,50,7.99],
      ['Hickory','Nutmeg','SOR34NUTH',16.70,55,50,7.99],
      ['Hickory','Turmeric','SOR34TURH',16.70,55,50,7.99],
      ['Walnut','Tamarind','SOR34TAMW',16.70,55,45,8.65],
      ['Red Oak','Poppy Seed','SO34POPR',16.70,55,43,7.99],
    ],
  },
  // ─── 9. Organic Engineered 567 ───
  {
    name: 'Organic 567', cat: 'eng',
    desc: 'Light Hand Scraped, Sawn Texture, Wire Brushed, Handcrafted Bevel, 4mm Sawn Cut Face, Truecore Hardwood Centerply, Nu Oil Finish',
    size: '5/8" x 5, 6, 7-1/2" x RL-6\'2"',
    colors: [
      ['Hickory','Chamomile','EOR567CHAH',19.20,57,41.90,7.19],
      ['Hickory','Darjeeling','EOR567DARH',19.20,57,41.90,7.19],
      ['Hickory','Oolong','EOR567OOLH',19.20,57,41.90,7.19],
      ['Oak','Chai','EOR567CHAO',19.20,57,41.90,7.19],
      ['Oak','Gunpowder','EOR567GUNO',19.20,57,41.90,7.19],
      ['Oak','Pekoe','EOR567PEKO',19.20,57,41.90,7.19],
      ['Oak','Hibiscus','EOR567HIBO',19.20,57,41.90,7.19],
      ['Oak','Marigold','EOR567MARO',19.20,57,41.90,7.19],
      ['Oak','Eucalyptus','EOR567EUCO',19.20,57,41.90,7.19],
      ['Oak','Ginseng','EOR567GINO',19.20,57,41.90,7.19],
      ['Red Oak','Yerba','EOR567YERRO-25',19.20,57,41.90,7.19],
      ['Red Oak','Rosehip','EOR567ROSRO-25',19.20,57,41.90,7.19],
      ['Hickory','Valarian','EOR567VALH-25',19.20,57,41.90,7.19],
    ],
  },
  // ─── 10. Serenity ───
  {
    name: 'Serenity', cat: 'eng',
    desc: '4mm Sawn Cut Face, Light Wirebrush OR Smooth, Micro Bevel, Truecore Hardwood Centerply, GlazeTek Finish',
    size: '5/8" x 7-1/2" x 7\'2" RL',
    colors: [
      ['Oak','Dream','SE75ODRE',27,45,56,7.65],
      ['Oak','Honest','SE75OHON',27,45,56,7.65],
      ['Oak','Tranquil','SE75OTRA',27,45,56,7.65],
      ['Oak','Cozy','SE75OCOZ',27,45,56,7.65],
      ['Oak','Pure','SE75OPUR',27,45,56,7.65],
      ['Oak','Peace','SE75OPEA',27,45,56,7.65],
      ['Oak','Serene','SE75OSER',27,45,56,7.65],
      ['Oak','Bliss','SE75OBLI',27,45,56,7.65],
      ['Oak','Fair','SE75OFAI',27,45,56,7.65],
      ['Oak','Calm','SE75OCAL',27,45,56,7.65],
      ['Oak','Clear','SE75OCLE',27,45,56,7.65],
      ['Oak','Aglow','SE75OAGL',27,45,56,7.65],
    ],
  },
  // ─── 11. Emporium ───
  {
    name: 'Emporium', cat: 'eng',
    desc: '4mm Sawn Cut Face, Light Smooth, Micro Bevel, Truecore Hardwood Centerply, GlazeTek Finish, Herringbone Pattern',
    size: '5/8" x 3.54" x 17.72"',
    colors: [
      ['Oak','Quartz','DE35QUAO',21.8,24,46,7.85],
      ['Oak','Opal','DE35OPAO',21.8,24,46,7.85],
      ['Oak','Crystal','DE35CRYO',21.8,24,46,7.85],
      ['Oak','Amber','DE35AMBO',21.8,24,46,7.85],
      ['Oak','Agate','DE35AGAO',21.8,24,46,7.85],
      ['Oak','Obsidian','DE35OBSO',21.8,24,46,7.85],
    ],
  },
  // ─── 12. True ───
  {
    name: 'True', cat: 'eng',
    desc: 'Replicated Real Driftwood, Barn Wood & Ancient Wood Texture, 3mm Through-Color Wear Layer, Sawn-Cut Grain, Handcrafted Bevel, Truecore2 Core, Nu Oil Super-Matte Finish',
    size: '5/8" x 7-1/2" x 6\'2" RL',
    colors: [
      // Larger carton (31.08 SF/CTN, 40 boxes/pallet)
      ['Oak','Onyx','TR75ONYO-25',23.31,50,49,7.99],
      ['Oak','Gardenia','TR75ORAH-25',23.31,50,49,7.99],
      ['Oak','Neroli','TR75ORRM-25',23.31,50,49,7.99],
      ['Oak','Lemon Grass','TR75AMBP-25',23.31,50,49,7.99],
      ['Oak','Ginger Lilly','TR75GINO',31.08,40,50,7.99],
      ['Oak','Silver Needle','TR75SILO',31.08,40,50,7.99],
      ['Hickory','Orange Blossom','TR75ORAH',31.08,40,50,7.99],
      ['Hickory','Magnolia','TR75MAGH',31.08,40,50,7.99],
      ['Hickory','Jasmine','TR75JASH',31.08,40,50,7.99],
      ['Maple','Juniper','TR75JUNM',31.08,40,50,7.99],
      ['Maple','Orris','TR75ORRM',31.08,40,50,7.99],
      ['Pine','Amber','TR75AMBP',31.08,40,50,7.99],
      // Smaller carton (23.31 SF/CTN, 50 boxes/pallet) - new colors
      ['Oak','Dahlia','TR75DAHO-25',23.31,50,49,7.99],
      ['Hickory','Azalea','TR75AZAH-25',23.31,50,49,7.99],
      ['Oak','Bergamot','TR75BERO-25',23.31,50,49,7.99],
      ['Oak','Lotus','TR75LOTO-25',23.31,50,49,7.99],
    ],
  },
  // ─── 13. Ventura ───
  {
    name: 'Ventura', cat: 'eng',
    desc: 'Wire Brushed with Detailed Coloring, Handcrafted Micro Bevel, 2mm Slice Cut Face, Truecore Hardwood Centerply, Nu Oil (Oak) / TrueMark Glaze Tek (Maple, Hickory & Walnut)',
    size: '1/2" x 7-1/2" x RL-86"',
    colors: [
      ['Oak','Seashell','VE75SEAO-25',36,30,60,5.15],
      ['Oak','Marina','VE75MARO-25',36,30,60,5.15],
      ['Oak','Mangrove','VE75MANO-25',36,30,60,5.15],
      ['Oak','Sandal','VE75SANO-25',36,30,60,5.15],
      ['Oak','Pearl','VE75PEAO-25',36,30,60,5.15],
      ['Hickory','Sandbar','VE75SANH-25',36,30,60,5.15],
      ['Walnut','Maritime','VE75MARW-25',36,30,60,6.55],
      ['Oak','White Cap','VE75WHIO-25',36,30,60,5.15],
      ['Oak','Dune','VE75DUNO-25',36,30,60,5.15],
      ['Oak','Pier','VE75PIEO-25',36,30,60,5.15],
      ['Oak','Wharf','VE75WHAO-25',36,30,60,5.15],
      ['Hickory','Hampton','VE75HAMH-25',36,30,60,5.15],
      ['Hickory','Catamaran','VE75CATH-25',36,30,60,5.15],
    ],
  },
  // ─── 14. Courtier (SPC) ───
  {
    name: 'Courtier', cat: 'lvp',
    desc: 'Rigid EZ LOCK, 5.5mm, Side Painted Bevel, 20Mil Surface Guardian Pro, UV/Waterproof Ceramic Bead Finish',
    size: '9" x 59" x 5.5mm',
    accTypes: ['reducer','stairNose','tMold'], // no threshold for SPC
    colors: [
      ['Oak','Admiral','COADM9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Camarilla','COCAM9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Chancellor','COCHA9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Falconer','COFAL9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Kingsguard','COKIN9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Rohan','COROH9O5MM-19',29.06,60,49.8,2.49],
      ['Oak','Briar','COBRI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Canterbury','COCAN9O5MM',29.06,60,49.8,2.49],
      ['Oak','Charlemagne','COCHR9O5MM',29.06,60,49.8,2.49],
      ['Oak','Durham','CODUR9O5MM',29.06,60,49.8,2.49],
      ['Oak','Ghent','COGHE9O5MM',29.06,60,49.8,2.49],
      ['Oak','Griffith','COGRI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Knight','COKNI9O5MM',29.06,60,49.8,2.49],
      ['Oak','Nightcastle','CONIG9O5MM',29.06,60,49.8,2.49],
      ['Maple','Clyde','COCLY9M5MM',29.06,60,49.8,2.49],
      ['Hickory','Galloway','COCAL9H5MM',29.06,60,49.8,2.49],
    ],
  },
];

// ── Accessory SKU derivation ──
// For most collections: strip trailing "-NN" from flooring SKU and append suffix
// Exception: Courtier SPC has different accessory SKU patterns
function getAccSku(flooringSku, suffix, collectionName) {
  if (collectionName === 'Courtier') {
    // Courtier accessories: base + RD/FSN/TM (different pattern)
    // -19 colors: COADM9O5MM-19RD, COADM9O5MMFSN, COADM9O5MM-19TM
    // non-19 colors: COBRI9O5MMRD, COBRI9O5MMFSN, COBRI9O5MMTM
    const base = flooringSku.replace(/-19$/, '');
    const has19 = flooringSku.endsWith('-19');
    if (suffix === 'SN' || suffix === 'FSN') {
      return base + 'MMFSN'; // stair nose always uses MMFSN pattern
    }
    if (has19) return flooringSku + suffix.replace('FSN', 'SN');
    return base + suffix;
  }
  // Standard: strip "-NN" suffix, append RD/SN/TH/TM
  const base = flooringSku.replace(/-\d+$/, '');
  return base + suffix;
}

// ── Import logic ──
async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert vendor
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Hallmark Floors', 'HALLMARK', 'https://hallmarkfloors.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Hallmark Floors (${vendorId})\n`);

    let totalProducts = 0, totalSkus = 0, totalAccSkus = 0, totalPricing = 0, totalPkg = 0;

    for (const col of COLLECTIONS) {
      let colProducts = 0, colSkus = 0, colAcc = 0;

      for (const [species, color, sku, sfCtn, boxPlt, lbsCtn, costSqft] of col.colors) {
        // Product name = color + species (e.g., "Balboa Oak")
        const productName = `${color} ${species}`;

        // Upsert product
        const prodRes = await client.query(`
          INSERT INTO products (id, vendor_id, name, collection, category_id, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
          ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
          DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
          RETURNING id
        `, [vendorId, productName, col.name, CAT[col.cat]]);
        const productId = prodRes.rows[0].id;
        colProducts++;

        // Internal SKU = HALLMARK- + vendor SKU
        const internalSku = 'HALLMARK-' + sku;

        // Upsert flooring SKU
        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'sqft', status = 'active'
          RETURNING id
        `, [productId, sku, internalSku, `${color} ${species} ${col.size}`]);
        const skuId = skuRes.rows[0].id;
        colSkus++;

        // Pricing: cost = Big D price, retail = cost × markup
        const cost = costSqft.toFixed(2);
        const retail = (costSqft * MARKUP).toFixed(2);
        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
          VALUES ($1, $2, $3, 'sqft')
          ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
        `, [skuId, cost, retail]);
        totalPricing++;

        // Packaging
        const sqftPerBox = sfCtn;
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet, weight_per_box_lbs)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box,
            boxes_per_pallet = EXCLUDED.boxes_per_pallet, weight_per_box_lbs = EXCLUDED.weight_per_box_lbs
        `, [skuId, sqftPerBox, boxPlt, lbsCtn]);
        totalPkg++;

        // Attributes
        await upsertAttr(client, skuId, ATTR.color, color);
        await upsertAttr(client, skuId, ATTR.species, species);
        await upsertAttr(client, skuId, ATTR.size, col.size);

        // ── Accessories ──
        const accTypes = col.accTypes || ['reducer', 'stairNose', 'threshold', 'tMold'];
        const suffixes = { reducer: 'RD', stairNose: 'SN', threshold: 'TH', tMold: 'TM' };

        for (const accType of accTypes) {
          const accSku = getAccSku(sku, suffixes[accType], col.name);
          const accInternal = 'HALLMARK-' + accSku;
          const accName = accType === 'stairNose' ? 'Stair Nose'
            : accType === 'tMold' ? 'T-Mold'
            : accType.charAt(0).toUpperCase() + accType.slice(1);
          const accCost = ACC_PRICES[accType];
          const accRetail = (accCost * MARKUP).toFixed(2);

          const accSkuRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'unit',
                         variant_type = 'accessory', status = 'active'
            RETURNING id
          `, [productId, accSku, accInternal, `${color} ${accName}`]);
          const accSkuId = accSkuRes.rows[0].id;
          colAcc++;

          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'unit')
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [accSkuId, accCost.toFixed(2), accRetail]);
          totalPricing++;
        }
      }

      totalProducts += colProducts;
      totalSkus += colSkus;
      totalAccSkus += colAcc;
      console.log(`  ${col.name}: ${colProducts} products, ${colSkus} flooring SKUs + ${colAcc} accessories`);
    }

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Flooring SKUs: ${totalSkus}`);
    console.log(`Accessory SKUs: ${totalAccSkus}`);
    console.log(`Total SKUs: ${totalSkus + totalAccSkus}`);
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
