// Bel Air Wood Flooring (vendor BAW) — laminate + SPC/WPC side of the 8/28/2026
// dealer price list (MVS.pdf). Companion to import-belair-engineered.mjs, which
// created the vendor; this adds:
//   Laminate (category `laminate`): Vivid, Fiji, Bergamo, 7 Kingdoms, Imperial,
//     Royal Palace — 32 colors
//   WPC (category `lvp-plank`): Rocky Mountain — 5 colors
//   SPC (category `lvp-plank`): Golden Elegance, Silver Luster, Oasis, Isla,
//     Mediterranean Sea, Gulf Shores, Horizon Harmony, Rio Grande — 48 colors
//   Laminate/vinyl trim (accessories, $14.99-26.99)
//
// Cost/packaging from the price list; images + vendor item codes from
// belairwoodfloor.com product pages (hotlinked, then mirrored). Color names
// follow the PRICE LIST where it and the site disagree (Albino/Luzzano/
// Verdellino, Puerto Vallarta); "Polished Platinum" fixes the list's "Platinun"
// typo (site agrees). Site-only items NOT on the list (Cascade collection,
// Gulf Shores Tulum) are skipped. Retail = 1.70x cost, charm 9-ending,
// $0.99-over-cost floor — same math as the engineered script.
//
//   node scripts/import-belair-laminate-spc.mjs --dry-run
//   node scripts/import-belair-laminate-spc.mjs [--no-mirror]
//
// Run inside the api container:
//   docker exec flooring-api node scripts/import-belair-laminate-spc.mjs

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_MIRROR = process.argv.includes('--no-mirror');

const VENDOR_CODE = 'BAW';
const IMG = 'https://belairwoodfloor.com/wp-content/uploads';

// type: 'laminate' → category `laminate`; 'spc'/'wpc' → category `lvp-plank`.
const COLLECTIONS = [
  // ---------------- Waterproof laminate (AC4, EIR) ----------------
  {
    collection: 'Vivid', abbr: 'VIV', type: 'laminate', cost: 2.35,
    sfBox: 18.99, bxPallet: 65, wtBox: 47,
    thickness: '12.3 mm', width: '7.75"', length: '59"', edge: 'Painted V-Groove',
    blurb: 'A 12.3 mm 100% waterproof laminate, AC4 residential grade, embossed in register with a painted V-groove. 7.75" × 59" planks.',
    colors: [
      { name: 'Jewel', img: `${IMG}/2025/01/product-jewel.jpg` },
      { name: 'Magic', img: `${IMG}/2025/01/product-magic.jpg` },
      { name: 'Miracle', img: `${IMG}/2025/01/product-miracle.jpg` },
      { name: 'Nature Beauty', img: `${IMG}/2025/01/product-nature-beauty-1.jpg` },
      { name: 'Rhapsody', img: `${IMG}/2025/01/product-rhapsody.jpg` },
      { name: 'Spectrum', img: `${IMG}/2025/01/product-spectrum.jpg` },
      { name: 'Symphony', img: `${IMG}/2025/01/product-symphony.jpg` },
    ],
  },
  {
    collection: 'Fiji', abbr: 'FIJ', type: 'laminate', cost: 1.95,
    sfBox: 15.58, bxPallet: 65, wtBox: 48,
    thickness: '12.3 mm', width: '7.75"', length: '48"', edge: 'Painted V-Groove',
    blurb: 'A 12.3 mm 100% waterproof laminate with an AC4 wear rating, embossed in register with a painted V-groove. 7.75" × 48" planks.',
    colors: [
      { name: 'Gau', img: `${IMG}/2024/04/Gau-1000.jpg` }, // site shows a 7-Kingdoms code here — mint ours
      { name: 'Kadavu', img: `${IMG}/2024/04/Kadavu-1000.jpg` },
      { name: 'Koro', img: `${IMG}/2024/04/Koro-1000.jpg` },
      { name: 'Moala', img: `${IMG}/2024/04/Moala-1000.jpg` },
      { name: 'Nadi', img: `${IMG}/2025/01/product-nadi.jpg` },
      { name: 'Tokoriki', img: `${IMG}/2024/04/Tokoriki-1000.jpg` },
      { name: 'Vanua', img: `${IMG}/2025/01/product-vanua.jpg` },
    ],
  },
  {
    collection: 'Bergamo', abbr: 'BRG', type: 'laminate', cost: 1.95,
    sfBox: 22.99, bxPallet: 52, wtBox: 48,
    thickness: '12 mm', width: '7.75"', length: '60"', edge: 'Painted V-Groove',
    blurb: 'A 12 mm 100% waterproof laminate with an AC4 wear rating, embossed in register with a painted V-groove. 7.75" × 60" planks.',
    colors: [
      { name: 'Albino', img: `${IMG}/2025/12/bergamo-collection-albina-large.jpg` },
      { name: 'Brescia', img: `${IMG}/2025/12/bergamo-collection-brescia-large.jpg` },
      { name: 'Lurano', img: `${IMG}/2025/12/bergamo-collection-lurano-large.jpg` },
      { name: 'Luzzano', img: `${IMG}/2025/12/bergamo-collection-luzzana-large.jpg` },
      { name: 'Morengo', img: `${IMG}/2025/12/bergamo-collection-morengo-large.jpg` },
      { name: 'Selvino', img: `${IMG}/2025/12/bergamo-collection-selvino-large.jpg` },
      { name: 'Verdellino', img: `${IMG}/2025/12/bergamo-collection-vedelino.jpg` },
    ],
  },
  {
    collection: '7 Kingdoms', abbr: 'KGD', type: 'laminate', cost: 1.95,
    sfBox: 21.61, bxPallet: 48, wtBox: 47,
    thickness: '12.3 mm', width: '9.5"', length: '48"', edge: 'Painted V-Groove',
    blurb: 'A 12.3 mm 100% waterproof laminate with an AC4 wear rating, embossed in register with a painted V-groove. Wide 9.5" × 48" planks.',
    colors: [
      { name: 'Castle Rock', vsku: '67KINDCASR', img: `${IMG}/2020/04/7Kingdoms-CastleRock-web-CC.jpg` },
      { name: 'Dorne', vsku: '67KINDDON', img: `${IMG}/2020/04/7Kingdoms-Dorne-web-CC.jpg` },
      { name: 'High-Gardens', vsku: '67KINDHIGD', img: `${IMG}/2020/04/7Kingdoms-HighGardens-web-CC.jpg` },
      { name: 'Riverlands', vsku: '67KINDRILN', img: `${IMG}/2020/04/7Kingdoms-Riverlands-web-CC-1.jpg` },
      { name: 'Winter-Fall', vsku: '67KINDWINFAL', img: `${IMG}/2020/04/7Kingdoms-WinterFall-web-CC.jpg` },
    ],
  },
  {
    collection: 'Imperial', abbr: 'IMP', type: 'laminate', cost: 2.15,
    sfBox: 17.16, bxPallet: 78, wtBox: 37,
    thickness: '12 mm', width: '6.5"', length: '48"', edge: 'Painted V-Groove',
    blurb: 'A 12 mm 100% waterproof laminate, AC4 residential grade, embossed in register with a painted V-groove. 6.5" × 48" planks.',
    colors: [
      { name: 'Chelsea Oak', vsku: '6IMCHOA', img: `${IMG}/2025/01/product-chelsea-oak.jpg` },
      { name: 'Hampton Oak', vsku: '6IMHAOA', img: `${IMG}/2025/01/product-hampton-oak.jpg` },
      { name: 'Newport Oak', vsku: '6IMNEOA', img: `${IMG}/2025/01/product-newport-oak.jpg` },
      { name: 'Royal Oak', vsku: '6IMROOA', img: `${IMG}/2025/01/product-royal-oak.jpg` },
    ],
  },
  {
    collection: 'Royal Palace', abbr: 'RPL', type: 'laminate', cost: 1.95,
    sfBox: 20.51, bxPallet: 50, wtBox: 44,
    thickness: '12 mm', width: '9"', length: '48"', edge: 'Painted 4V-Groove',
    blurb: 'A 12 mm 100% waterproof laminate, AC4 residential grade, embossed in register with a painted 4V-groove. 9" × 48" planks.',
    colors: [
      { name: 'Buckingham', vsku: '6ROYPALBUCK', img: `${IMG}/2017/05/buckingham-e1752247284469.jpeg` },
      { name: 'Versailles', vsku: '6ROYPALVER', img: `${IMG}/2017/05/versailles-e1752247396973.jpeg` },
    ],
  },

  // ---------------- Waterproof WPC ----------------
  {
    collection: 'Rocky Mountain', abbr: 'RKM', type: 'wpc', cost: 2.29,
    sfBox: 29.53, bxPallet: 56, wtBox: 47,
    thickness: '8 mm', width: '9"', length: '60"', wear: '20 mil',
    underlayer: '1.5 mm EVA pad', edge: 'V-Groove',
    blurb: 'An 8 mm 100% waterproof WPC plank (6.5 mm core + 1.5 mm EVA pad) with a 20 mil wear layer, embossed in register with a V-groove. 9" × 60" planks.',
    colors: [
      { name: 'Aspen', img: `${IMG}/2018/06/aspen-scaled-e1746600769443.jpeg` },
      { name: 'Boulder', img: `${IMG}/2018/06/RockyMountain-Boulder-web.jpg` },
      { name: 'Cheyenne', img: `${IMG}/2018/06/RockyMountain-Cheyenne-web.jpg` },
      { name: 'Colorado', img: `${IMG}/2018/06/colorado-scaled-e1746600732774.jpeg` },
      { name: 'Denver', img: `${IMG}/2018/06/denver-scaled-e1746600711980.jpeg` },
    ],
  },

  // ---------------- Waterproof SPC ----------------
  {
    collection: 'Golden Elegance', abbr: 'GDE', type: 'spc', cost: 2.09,
    sfBox: 14.73, bxPallet: 48, wtBox: 50,
    thickness: '9 mm', width: '9"', length: '60"', wear: '20 mil',
    underlayer: '2.5 mm EVA pad', edge: 'Micro Beveled',
    blurb: 'A 9 mm 100% waterproof SPC plank (6.5 mm core + 2.5 mm EVA pad) with a 20 mil wear layer, embossed in register with micro-beveled edges and Unilin click. 9" × 60" planks.',
    colors: [
      { name: 'Champagne Shimmer', vsku: '6SPCGOLDEL1400', img: `${IMG}/2024/11/golden-elegance-champagne-shimmer.jpg` },
      { name: 'Gilded Ivory', vsku: '6SPCGOLDEL1100', img: `${IMG}/2024/11/golden-elegance-gilded-ivory.jpg` },
      { name: 'Golden Oakwood', vsku: '6SPCGOLDEL1300', img: `${IMG}/2024/11/golden-elegance-golden-oakwood.jpg` },
      { name: 'Ivory Elegance', vsku: '6SPCGOLDEL1500', img: `${IMG}/2024/11/golden-elegance-ivory-elegance.jpg` },
      { name: 'Opulent Amber Glow', vsku: '6SPCGOLDEL1600', img: `${IMG}/2024/11/golden-elegance-opulent-amber-glow.jpg` },
      { name: 'Royal Gold Dust', vsku: '6SPCGOLDEL1200', img: `${IMG}/2024/11/golden-elegance-royal-gold-dust.jpg` },
      { name: 'Satin Goldstone', vsku: '6SPCGOLDEL1700', img: `${IMG}/2024/11/golden-elegance-satin-goldstone.jpg` },
    ],
  },
  {
    collection: 'Silver Luster', abbr: 'SLV', type: 'spc', cost: 1.95,
    sfBox: 18.41, bxPallet: 52, wtBox: 47,
    thickness: '7 mm', width: '9"', length: '60"', wear: '20 mil',
    underlayer: '2 mm IXPE pad', edge: 'Micro Beveled',
    blurb: 'A 7 mm 100% waterproof SPC plank (5 mm core + 2 mm IXPE pad) with a 20 mil wear layer, embossed in register with micro-beveled edges and Unilin click. 9" × 60" planks.',
    colors: [
      { name: 'Elegant Filigree', vsku: '6SPCSILLUS1500', img: `${IMG}/2024/11/elegant-filigree.jpg` },
      { name: 'Moonlit Mercury', vsku: '6SPCSILLUS1200', img: `${IMG}/2024/11/moonlit-mercury.jpg` },
      { name: 'Polished Platinum', vsku: '6SPCSILLUS1100', img: `${IMG}/2024/11/polished-platinum.jpg` },
      { name: 'Satin Veil', vsku: '6SPCSILLUS1400', img: `${IMG}/2024/11/satin-veil.jpg` },
      { name: 'Sterling Silver Sands', vsku: '6SPCSILLUS1300', img: `${IMG}/2024/11/sterling-silver-sands.jpg` },
    ],
  },
  {
    collection: 'Oasis', abbr: 'OAS', type: 'spc', cost: 1.95,
    sfBox: 22.09, bxPallet: 44, wtBox: 47,
    thickness: '7 mm', width: '9"', length: '70.8"', wear: '20 mil',
    underlayer: '2 mm IXPE pad', edge: 'Micro Beveled',
    blurb: 'A 7 mm 100% waterproof SPC plank (5 mm core + 2 mm IXPE pad) with a 20 mil wear layer, embossed in register with micro-beveled edges. Extra-long 9" × 70.8" planks.',
    colors: [
      { name: 'Caravan', vsku: 'OASISCAR', img: `${IMG}/2020/11/oasis-caravan.jpg` },
      { name: 'Founte', vsku: 'OASISFOU', img: `${IMG}/2020/11/oasis-founte.jpg` },
      { name: 'Haze', vsku: 'OASISHAZ', img: `${IMG}/2020/11/oasis-haze.jpg` },
      { name: 'Lush', vsku: 'OASISLUS', img: `${IMG}/2020/11/lush-e1746600351891.jpeg` },
      { name: 'Mirage', vsku: 'OASISMIR', img: `${IMG}/2020/11/oasis-mirage.jpg` },
      { name: 'Morgana', vsku: 'OASISMOR', img: `${IMG}/2020/11/oasis-morgana.jpg` },
      { name: 'Serenity', vsku: 'OASISSER', img: `${IMG}/2020/11/oasis-serenity.jpg` },
    ],
  },
  {
    collection: 'Isla', abbr: 'ISL', type: 'spc', cost: 1.95,
    sfBox: 22.64, bxPallet: 60, wtBox: 50,
    thickness: '7 mm', width: '9"', length: '60"', wear: '20 mil',
    underlayer: '2 mm IXPE pad', edge: 'V-Groove',
    blurb: 'A 7 mm 100% waterproof SPC plank (5 mm core + 2 mm IXPE pad) with a 20 mil wear layer, embossed in register with a V-groove. 9" × 60" planks.',
    colors: [
      { name: 'Antigua', vsku: '6ISLAANTG', img: `${IMG}/2020/03/Isla-Antiqua-web.jpg` },
      { name: 'Bali', vsku: '6ISLABAL', img: `${IMG}/2020/03/Isla-Bali-web.jpg` },
      { name: 'Bora Bora', vsku: '6ISLABORB', img: `${IMG}/2020/03/Isla-BoraBora-web.jpg` },
      { name: 'Capri', vsku: '6ISLACAP', img: `${IMG}/2020/03/isla-capri.jpeg` },
      { name: 'Maui', vsku: '6ISLAMAU', img: `${IMG}/2020/03/Isla-Maui-web.jpg` },
      { name: 'Santorini', vsku: '6ISLASANT', img: `${IMG}/2020/03/Isla-Santorini-web.jpg` },
      { name: 'Tahiti', vsku: '6ISLATAH', img: `${IMG}/2020/03/Isla-Tahiti-web.jpg` },
    ],
  },
  {
    collection: 'Mediterranean Sea', abbr: 'MED', type: 'spc', cost: 1.95,
    sfBox: 22.64, bxPallet: 60, wtBox: 50,
    thickness: '7 mm', width: '9"', length: '60"', wear: '20 mil',
    underlayer: '2 mm IXPE pad', edge: 'V-Groove',
    blurb: 'A 7 mm 100% waterproof SPC plank (5 mm core + 2 mm IXPE pad) with a 20 mil wear layer, embossed in register with a V-groove. 9" × 60" planks.',
    colors: [
      { name: 'Andros', vsku: '6MEDSEAND', img: `${IMG}/2020/03/mediterranean-andros.jpg` },
      { name: 'Crete', vsku: '6MEDSELIP', img: `${IMG}/2020/03/mediterranean-crete.jpg` },
      { name: 'Elba', vsku: '6MEDSEELB', img: `${IMG}/2020/03/mediterranean-elba.jpg` },
      { name: 'Ibiza', vsku: '6MEDSEIBI', img: `${IMG}/2020/03/mediterranean-ibiza.jpg` },
      { name: 'Mykonos', vsku: '6MEDSESMYK', img: `${IMG}/2020/03/mediterranean-mykonos.jpg` },
      { name: 'Pantelleria', vsku: '6MEDSEPANT', img: `${IMG}/2020/03/mediterranean-pantelleria.jpg` },
    ],
  },
  {
    collection: 'Gulf Shores', abbr: 'GLF', type: 'spc', cost: 2.69,
    sfBox: 20.34, bxPallet: 72, wtBox: 50,
    thickness: '6.5 mm', width: '12"', length: '60"', wear: '20 mil',
    underlayer: '1.5 mm EVA pad', edge: 'V-Groove',
    blurb: 'A 6.5 mm 100% waterproof SPC plank (5 mm core + 1.5 mm EVA pad) with a 20 mil wear layer, embossed in register with a V-groove. Extra-wide 12" × 60" planks.',
    colors: [
      { name: 'Acapulco', vsku: 'SPCGULACA81800', img: `${IMG}/2022/03/image00005-scaled-e1647941744816.jpeg` },
      { name: 'Cabo', vsku: 'SPCGULCAB81800', img: `${IMG}/2022/03/image00006-scaled-e1647941774404.jpeg` },
      { name: 'Cancun', vsku: 'SPCGULCAN81800', img: `${IMG}/2022/03/image00007-scaled-e1647941809202.jpeg` },
      { name: 'Cozumel', vsku: 'SPCGULCOZ81800', img: `${IMG}/2022/03/image00003-scaled-e1647941691454.jpeg` },
      { name: 'La Paz', vsku: 'SPCGULLAP81800', img: `${IMG}/2022/03/la-paz-e1746600581733.jpeg` },
      { name: 'Puerto Vallarta', vsku: 'SPCGULPUR81800', img: `${IMG}/2022/03/image00001-scaled-e1647941620612.jpeg` },
    ],
  },
  {
    collection: 'Horizon Harmony', abbr: 'HZH', type: 'spc', cost: 1.59,
    sfBox: 22.09, bxPallet: 52, wtBox: 51,
    thickness: '5 mm', width: '9"', length: '60"', wear: '12 mil',
    underlayer: '1 mm EVA pad', edge: 'Micro Beveled',
    blurb: 'A 5 mm 100% waterproof SPC plank (4 mm core + 1 mm EVA pad) with a 12 mil wear layer, micro-beveled with Unilin click. 9" × 60" planks.',
    colors: [
      { name: 'Dawn Mist Gray', vsku: '6SPCHORHAR1100', img: `${IMG}/2024/11/horizon-harmony-dawn-mist-gray-2026.jpg` },
      { name: 'Daybreak Sandstone', vsku: '6SPCHORHAR1200', img: `${IMG}/2024/11/horizon-harmony-daybreak.jpg` },
      { name: 'Horizon Gold Dust', vsku: '6SPCHORHAR1300', img: `${IMG}/2024/11/horizon-harmony-horizon-gold-dust.jpg` },
      { name: 'Horizon Lavender Haze', vsku: '6SPCHORHAR1400', img: `${IMG}/2024/11/horizon-harmony-horizon-lavender-haze.jpg` },
      { name: 'Sunset Amber Glow', vsku: '6SPCHORHAR1500', img: `${IMG}/2024/11/horizon-harmony-sunset-amber-glow.jpg` },
    ],
  },
  {
    collection: 'Rio Grande', abbr: 'RIO', type: 'spc', cost: 1.49,
    sfBox: 30.18, bxPallet: 60, wtBox: 51,
    thickness: '5 mm', width: '9"', length: '60"', wear: '12 mil',
    underlayer: '1 mm EVA pad', edge: 'Micro Beveled',
    blurb: 'A 5 mm 100% waterproof SPC plank (4 mm core + 1 mm EVA pad) with a 12 mil wear layer and micro-beveled edges. 9" × 60" planks.',
    colors: [
      { name: 'Amazon', img: `${IMG}/2018/09/amazon.jpg` },
      { name: 'Congo', img: `${IMG}/2018/09/congo.jpg` },
      { name: 'Danube', img: `${IMG}/2018/09/danube.jpg` },
      { name: 'Nile', img: `${IMG}/2018/09/nile.jpg` },
      { name: 'Yukon', img: `${IMG}/2018/09/yukon-e1746600849477.jpeg` },
    ],
  },
];

// Laminate/vinyl trim from the bottom of the laminate & SPC pages.
const TRIMS = {
  collection: 'Trim & Moldings', name: 'Laminate & Vinyl Trim',
  blurb: 'Color-matched trim for Bel Air laminate, SPC, and WPC flooring.',
  skus: [
    { label: 'Quarter Round', code: 'QTR-ROUND', cost: 14.99 },
    { label: 'End Cap', code: 'END-CAP', cost: 14.99 },
    { label: 'Reducer', code: 'REDUCER', cost: 14.99 },
    { label: 'T-Molding', code: 'TMOLD', cost: 14.99 },
    { label: 'Stair Nose', code: 'STAIR-NOSE', cost: 19.99 },
    { label: 'Square Flush Stair Nose', code: 'SQFLUSH-SN', cost: 26.99 },
  ],
};

const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const codeify = (s) => slugify(s).toUpperCase().replace(/-/g, '');

// Retail = 1.70x cost, charm 9-ending, floored at cost+$0.99 (mirrors base.js
// upsertPricing for non-tile categories).
function retailFor(cost) {
  const target = Math.max(cost * 1.70, cost + 0.99);
  const cents = Math.round(target * 100);
  let nine = Math.max(9, Math.floor((cents - 9) / 10) * 10 + 9) / 100;
  if (nine < cost + 0.99 - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
}

async function attrId(slug) {
  const r = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!r.rows.length) throw new Error(`missing attribute: ${slug}`);
  return r.rows[0].id;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');

  const v = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!v.rows.length) throw new Error('BAW vendor not found — run import-belair-engineered.mjs first');
  const vendorId = v.rows[0].id;

  const cats = {};
  for (const slug of ['laminate', 'lvp-plank']) {
    const r = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (!r.rows.length) throw new Error(`${slug} category not found`);
    cats[slug] = r.rows[0].id;
  }
  const catFor = (type) => type === 'laminate' ? cats['laminate'] : cats['lvp-plank'];

  const A = {
    color: await attrId('color'), brand: await attrId('brand'),
    thickness: await attrId('thickness'), plank_width: await attrId('plank_width'),
    plank_length: await attrId('plank_length'), wear_layer: await attrId('wear_layer'),
    underlayer: await attrId('underlayer'), edge: await attrId('edge'),
    surface_texture: await attrId('surface_texture'), material: await attrId('material'),
    abrasion_resistance: await attrId('abrasion_resistance'),
  };

  let nProd = 0, nSku = 0;
  const mediaRowsToMirror = [];

  for (const c of COLLECTIONS) {
    const material = c.type === 'laminate' ? 'Laminate' : c.type === 'wpc' ? 'WPC' : 'SPC';
    for (const col of c.colors) {
      const internalSku = `BAW-${c.abbr}-${codeify(col.name)}`;
      const vendorSku = col.vsku || `${c.abbr}-${slugify(col.name).toUpperCase()}`;
      const slug = `bel-air-${slugify(c.collection)}-${slugify(col.name)}`;
      const retail = retailFor(c.cost);

      if (DRY_RUN) {
        console.log(`  ${internalSku.padEnd(24)} ${c.collection} ${col.name}  [${material}]  $${c.cost}→$${retail}/sf`);
        nProd++; nSku++; continue;
      }

      const desc = `Bel Air ${c.collection} — ${col.name}. ${c.blurb}`;
      const prodRes = await pool.query(`
        INSERT INTO products (vendor_id, name, collection, category_id, category_source,
                              status, is_active, slug, description_short, content_status)
        VALUES ($1,$2,$3,$4,'manual','active',true,$5,$6,'reviewed')
        ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
          category_id = EXCLUDED.category_id,
          status = 'active', is_active = true,
          slug = COALESCE(products.slug, EXCLUDED.slug),
          description_short = EXCLUDED.description_short,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id`, [vendorId, col.name, c.collection, catFor(c.type), slug, desc]);
      const productId = prodRes.rows[0].id;
      nProd++;

      const skuRes = await pool.query(`
        INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
        VALUES ($1,$2,$3,$4,'box','active')
        ON CONFLICT (internal_sku) DO UPDATE SET
          product_id = EXCLUDED.product_id, vendor_sku = EXCLUDED.vendor_sku,
          variant_name = EXCLUDED.variant_name, sell_by = 'box', status = 'active',
          updated_at = CURRENT_TIMESTAMP
        RETURNING id`, [productId, vendorSku, internalSku, col.name]);
      const skuId = skuRes.rows[0].id;
      nSku++;

      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1,$2,$3,'per_sqft')
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = EXCLUDED.cost,
          retail_price = CASE WHEN pricing.retail_locked THEN GREATEST(pricing.retail_price, EXCLUDED.retail_price) ELSE EXCLUDED.retail_price END,
          price_basis = EXCLUDED.price_basis`, [skuId, c.cost, retail]);

      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet, sqft_per_pallet, weight_per_box_lbs)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = EXCLUDED.sqft_per_box, boxes_per_pallet = EXCLUDED.boxes_per_pallet,
          sqft_per_pallet = EXCLUDED.sqft_per_pallet, weight_per_box_lbs = EXCLUDED.weight_per_box_lbs`,
        [skuId, c.sfBox, c.bxPallet, Math.round(c.sfBox * c.bxPallet * 100) / 100, c.wtBox]);

      const attrs = [
        [A.color, col.name], [A.brand, 'Bel Air'], [A.material, material],
        [A.thickness, c.thickness], [A.plank_width, c.width], [A.plank_length, c.length],
        [A.edge, c.edge], [A.surface_texture, 'Embossed In Register (EIR)'],
      ];
      if (c.type === 'laminate') attrs.push([A.abrasion_resistance, 'AC4']);
      if (c.wear) attrs.push([A.wear_layer, c.wear]);
      if (c.underlayer) attrs.push([A.underlayer, c.underlayer]);
      for (const [aid, val] of attrs) {
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
          [skuId, aid, val]);
      }

      await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
      const m = await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1,$2,'primary',$3,$3,0) RETURNING id, url, original_url`,
        [productId, skuId, col.img]);
      mediaRowsToMirror.push(m.rows[0]);

      console.log(`  ✓ ${internalSku.padEnd(24)} ${c.collection} ${col.name}  $${c.cost}→$${retail}/sf`);
    }
  }

  // ---- laminate/vinyl trim accessories ----
  if (!DRY_RUN) {
    const prodRes = await pool.query(`
      INSERT INTO products (vendor_id, name, collection, category_id, category_source,
                            status, is_active, slug, description_short, content_status)
      VALUES ($1,$2,$3,$4,'manual','active',true,$5,$6,'reviewed')
      ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
        status = 'active', is_active = true,
        description_short = EXCLUDED.description_short,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id`,
      [vendorId, TRIMS.name, TRIMS.collection, cats['laminate'],
       'bel-air-laminate-vinyl-trim', `Bel Air ${TRIMS.name}. ${TRIMS.blurb}`]);
    const productId = prodRes.rows[0].id;
    nProd++;
    for (const t of TRIMS.skus) {
      const r = await pool.query(`
        INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
        VALUES ($1,$2,$3,$4,'unit','accessory',$5,'active')
        ON CONFLICT (internal_sku) DO UPDATE SET
          product_id = EXCLUDED.product_id, vendor_sku = EXCLUDED.vendor_sku,
          variant_name = EXCLUDED.variant_name, sell_by = 'unit',
          variant_type = 'accessory', accessory_label = EXCLUDED.accessory_label,
          status = 'active', updated_at = CURRENT_TIMESTAMP
        RETURNING id`, [productId, t.code, `BAW-LTR-${t.code}`, t.label, t.label]);
      const skuId = r.rows[0].id;
      nSku++;
      const retail = retailFor(t.cost);
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1,$2,$3,'per_unit')
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = EXCLUDED.cost,
          retail_price = CASE WHEN pricing.retail_locked THEN GREATEST(pricing.retail_price, EXCLUDED.retail_price) ELSE EXCLUDED.retail_price END,
          price_basis = EXCLUDED.price_basis`, [skuId, t.cost, retail]);
      await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, A.brand, 'Bel Air']);
      console.log(`  ✓ BAW-LTR-${t.code.padEnd(14)} ${t.label}  $${t.cost}→$${retail}/ea`);
    }
  } else {
    for (const t of TRIMS.skus) {
      console.log(`  BAW-LTR-${t.code.padEnd(14)} ${t.label}  $${t.cost}→$${retailFor(t.cost)}/ea`);
      nSku++;
    }
    nProd++;
  }

  console.log(`\nUpserted: ${nProd} products, ${nSku} skus`);

  if (!DRY_RUN && !NO_MIRROR && mediaRowsToMirror.length) {
    console.log(`\nMirroring ${mediaRowsToMirror.length} images…`);
    let ok = 0, skip = 0;
    for (const row of mediaRowsToMirror) {
      try { (await mirrorMediaRow(pool, row)) ? ok++ : skip++; }
      catch { skip++; }
    }
    console.log(`  mirrored ${ok}, kept vendor url ${skip}`);
  }

  console.log('\n=== Bel Air laminate/SPC/WPC onboarding complete ===');
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
