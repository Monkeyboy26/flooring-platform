#!/usr/bin/env node
/**
 * Build backend/data/parliament/catalog.json for the Parliament Floors onboarding
 * from the January 2025 dealer price lists (Parliament / Elevate / Visions PDFs).
 *
 * Parliament Floors (109 N McKinley St, Corona CA 92879) is one NEW vendor with
 * three brands: Parliament (SPC rigid core + WPC "Generations" + EX laminate
 * collections + WPL waterproof laminate), Elevate Premium Hardwood (engineered
 * European Oak), and Visions (engineered hardwood — Cornerstone / Designer /
 * Traditional series).  See [[vendor-sub-brands]].
 *
 * Pricing: every PDF "PRICE PER SF" is Roma's COST (wholesale/dealer). Retail =
 * cost x 1.6 nickel keystone — applied in import-parliament.js, not here.  This
 * file only carries costs + specs.  Moldings & underlayment costs likewise come
 * straight from the price lists.
 *
 * Output: backend/data/parliament/catalog.json  (consumed by import-parliament.js)
 * Usage:  node backend/scripts/build-parliament-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'parliament');

const products = [];
const num = (item) => { const m = String(item).match(/(\d{4})/); return m ? m[1] : null; };

// ============================================================
// PARLIAMENT — SPC RIGID CORE  (category lvp-plank)
// Each block: shared spec (thickness/wear/size/packaging/cost) + list of colors.
// A color = one product / one SKU.  Per-row exceptions via {n,c,over:{...}}.
// ============================================================
// SPC collection = the numbered Series Parliament uses on parliamentfloors.com
// (1000-1900 Series), derived from the item number's hundreds digit.
const spcSeries = (n) => `${Math.floor(parseInt(n, 10) / 100) * 100} Series`;
const SPC_COMMON = {
  brand: 'PARLIAMENT', category: 'lvp-plank',
  material: 'SPC Vinyl', construction: 'Rigid Core (SPC)', surface_texture: 'Embossed-in-Register Wood Grain',
  finish: 'Painted Bevel', underlayer: 'Attached 1.5mm Antimicrobial IXPE Acoustic Pad', acc: 'SPC',
};
const SPC_BLOCKS = [
  { thickness: '5.5 mm', wear_layer: '20 mil', width: '7 in', length: '60 in', lbs: 54.20, sqft: 29.53, pallet: 65, cost: 1.95,
    colors: [['SPC-1122-B','Coronado'],['SPC-1123-B','Mesquite'],['SPC-1124-B','Boulder'],['SPC-1150-B','Monterey'],['SPC-1151-B','Morro Bay'],['SPC-1155-B','Saratoga'],
             ['SPC-1154-VN','Sonoma',{thickness:'6.5 mm',sqft:23.25}]] },
  { thickness: '6.0 mm', wear_layer: '20 mil', width: '5 / 7 / 9 in (random)', length: '60 in', lbs: 58.66, sqft: 33.91, pallet: 36, cost: 2.29,
    colors: [['SPC-1266','Cashmere Oak'],['SPC-1268','Rocky Mountain Oak'],['SPC-1269','Caramel Vintage Oak']] },
  { thickness: '6.0 mm', wear_layer: '20 mil', width: '9 in', length: '71 in', lbs: 38.21, sqft: 22.09, pallet: 56, cost: 2.19,
    colors: [['SPC-1431-VN','Alaskan Oak',{thickness:'6.5 mm'}],['SPC-1433-XL','Antelope Oak'],['SPC-1435-XL','Whitewood Oak'],['SPC-1437-XL','Winchester Oak'],
             ['SPC-1439-VN','Pewter Oak',{thickness:'6.5 mm'}],['SPC-1447-XL','Moscato'],['SPC-1449-XL','Sycamore'],['SPC-1457-XL','Tumbleweed']] },
  { thickness: '6.5 mm', wear_layer: '20 mil', width: '9 in', length: '60 in', lbs: 50, sqft: 22.6, pallet: 48, cost: 2.09,
    colors: [['SPC-1520-N','Waucoba'],['SPC-1521-N','Calico'],['SPC-1522-N','Espina'],['SPC-1523-N','Dahlia'],['SPC-1524-N','Barbados'],['SPC-1527-N','Mojave'],
             ['SPC-1530-B','Sugarloaf',{sqft:22.64}]] },
  { thickness: '5.5 mm', wear_layer: '20 mil', width: '7 in', length: '60 in', lbs: 40.89, sqft: 23.64, pallet: 45, cost: 1.95,
    colors: [['SPC-1372','Bullhead'],['SPC-1373','Hemlock'],['SPC-1374','Riverwood Pine']] },
  { thickness: '6.0 mm', wear_layer: '20 mil', width: '7 in', length: '48 in', lbs: 51.15, sqft: 28.37, pallet: 55, cost: 1.95,
    colors: [['SPC-1081','Graphite Oak II'],['SPC-1082','Light Cloud II'],['SPC-1085','Iron Oak II'],['SPC-1087','Charcoal Oak II']] },
  { thickness: '5.5 mm', wear_layer: '20 mil', width: '7 in', length: '60 in', lbs: 54.20, sqft: 29.53, pallet: 65, cost: 1.95,
    colors: [['SPC-1143-B','Burnt Chestnut'],['SPC-1144-B','Pecan Oak'],['SPC-1145-B','Scarlet Oak'],['SPC-1146-B','Willow Grey'],['SPC-1147-B','Old Town Hickory'],['SPC-1148-B','Oxford Hickory']] },
  { thickness: '6.5 mm', wear_layer: '20 mil', width: '9 in', length: '60 in', lbs: 51.55, sqft: 26.08, pallet: 52, cost: 2.19,
    colors: [['SPC-1361','Havana'],['SPC-1365','Maui'],['SPC-1366','Cancun']] },
  { thickness: '5.5 mm', wear_layer: '12 mil', width: '7 in', length: '48 in', lbs: 56.40, sqft: 28.84, pallet: 45, cost: 1.85,
    colors: [['SPC-1367','Powell']] },
  { thickness: '6.5 mm', wear_layer: '20 mil', width: '9 in', length: '60 in', lbs: 47.50, sqft: 22.6, pallet: 50, cost: 2.19,
    colors: [['SPC-1621','Zion'],['SPC-1622','Yosemite'],['SPC-1623','Carlsbad'],['SPC-1624','Arches'],['SPC-1627','Sequoia']] },
  { thickness: '6.0 mm', wear_layer: '20 mil', width: '9 in', length: '60 in', lbs: 40.40, sqft: 22.09, pallet: 52, cost: 1.99,
    colors: [['SPC-1741','Staghorn'],['SPC-1747','Yellowstone'],['SPC-1748','Silverwood Pine'],['SPC-1746-VN','Tuscany',{thickness:'8.0 mm'}]] },
  { thickness: '5.5 mm', wear_layer: '12 mil', width: '7 in', length: '48 in', lbs: 51.15, sqft: 19.16, pallet: 50, cost: 1.69,
    colors: [['SPC-1852','Hazelnut II'],['SPC-1853','Platinum II'],['SPC-1854','Barrel II'],['SPC-1856','Saddle II']] },
  { thickness: '6.5 mm', wear_layer: '20 mil', width: '9 in', length: '60 in', lbs: 47.50, sqft: 22.6, pallet: 50, cost: 2.19,
    colors: [['SPC-1923',"Nature's Way"],['SPC-1924','Family Tree'],['SPC-1925','Time Capsule'],['SPC-1926','Amber Eye'],['SPC-1927','Classic Hickory'],['SPC-1928','Washed Maple']] },
];
for (const b of SPC_BLOCKS) {
  for (const [item, name, over] of b.colors) {
    products.push({
      ...SPC_COMMON, item, num: num(item), name, color: name, status: 'active',
      collection: spcSeries(num(item)),
      thickness: (over?.thickness) || b.thickness, wear_layer: b.wear_layer,
      width: b.width, length: b.length, size: `${b.length} x ${b.width}`,
      lbs_box: b.lbs, sqft_box: (over?.sqft) ?? b.sqft, box_pallet: b.pallet, cost: b.cost,
    });
  }
}

// ============================================================
// PARLIAMENT — WPC "GENERATIONS"  (category lvp-plank, closeout promo)
// ============================================================
const WPC_COMMON = {
  brand: 'PARLIAMENT', category: 'lvp-plank', collection: 'Generations',
  material: 'WPC Vinyl', construction: 'Rigid Core (WPC)', wear_layer: '20 mil',
  surface_texture: 'Wood Grain', finish: 'Painted Bevel',
  underlayer: 'Attached Antimicrobial Acoustic Pad', acc: 'WPC', status: 'active', closeout: true,
};
const WPC_BLOCKS = [
  { series: 'Gen I',   width: '7 in', length: '48 in', thickness: '7 mm', lbs: 37.00, sqft: 23.6, pallet: 65, cost: 1.59,
    colors: [['WPC-1011','Rustic Ash'],['WPC-1014','Summer Oak'],['WPC-1015','Silvertree Oak']] },
  { series: 'Gen II',  width: '7 in', length: '48 in', thickness: '7 mm', lbs: 37.00, sqft: 23.6, pallet: 65, cost: 1.59,
    colors: [['WPC-1055','Crete']] },
  { series: 'Gen III', width: '7 in', length: '48 in', thickness: '7 mm', lbs: 37.00, sqft: 23.6, pallet: 65, cost: 1.59,
    colors: [['WPC-1424','Lagoon'],['WPC-1425','Coastal Fog'],['WPC-1426','Driftwood']] },
  { series: 'Gen V',   width: '9 in', length: '60 in', thickness: '7 mm', lbs: 44.00, sqft: 29.50, pallet: 64, cost: 1.69,
    colors: [['WPC-1021','Calgary Oak'],['WPC-1022','Ottawa Oak'],['WPC-1023','Vancouver Oak'],['WPC-1025','Alberta Oak'],['WPC-1026','Toronto Oak']] },
];
for (const b of WPC_BLOCKS) {
  for (const [item, name] of b.colors) {
    products.push({
      ...WPC_COMMON, item, num: num(item), name, color: name, series: b.series,
      thickness: b.thickness, width: b.width, length: b.length, size: `${b.length} x ${b.width}`,
      lbs_box: b.lbs, sqft_box: b.sqft, box_pallet: b.pallet, cost: b.cost,
    });
  }
}

// ============================================================
// PARLIAMENT — EX LAMINATE collections  (category laminate, 12mm AC-3)
// No photos on the vendor site → imported photoless.
// ============================================================
const LAM_COMMON = {
  brand: 'PARLIAMENT', category: 'laminate', material: 'Laminate',
  construction: 'HDF Laminate', abrasion_resistance: 'AC3', finish: 'Embossed', acc: 'LAM', status: 'active',
};
const LAM_BLOCKS = [
  { collection: 'Artistique', thickness: '12 mm', width: '7-5/8 in', length: '48 in', surface_texture: 'Register Embossed', lbs: 44.60, sqft: 20.40, pallet: 50, cost: 1.75,
    colors: [['EX-157','Silver Sand']] },
  { collection: 'Loft', thickness: '12 mm', width: '5 in', length: '48 in', surface_texture: 'Modern Grain', lbs: 44.00, sqft: 20.56, pallet: 39, cost: 1.75,
    colors: [['EX-201','Cloud Grey'],['EX-203','Canyon Maple'],['EX-205','Woodland Maple']] },
  { collection: 'Castle', thickness: '12 mm', width: '9 in', length: '84 in', surface_texture: 'Embossed Grain', lbs: 63.50, sqft: 28.30, pallet: 36, cost: 2.09,
    colors: [['EX-380','Dover'],['EX-381','Clifton'],['EX-382','Barnwell']] },
  { collection: 'Vintage Birch', thickness: '12 mm', width: '6-1/2 in', length: '48 in', surface_texture: 'Embossed', lbs: 37.25, sqft: 17.27, pallet: 60, cost: 1.75,
    colors: [['EX-542','Desert Beach'],['EX-547','Antique Copper'],['EX-548','Rustic Coffee'],['EX-549','Smoke Truffle']] },
  { collection: 'American Antique Oak', thickness: '12 mm', width: '7-5/8 in', length: '24 / 48 / 72 in (random)', species: 'European Oak', surface_texture: 'Oil Finish', lbs: 32.75, sqft: 15.11, pallet: 75, cost: 1.99,
    colors: [['EX-877','Appalachian'],['EX-878','Mammoth'],['EX-879','Rushmore']] },
  { collection: 'Estate', thickness: '12 mm', width: '3-1/2 / 5-1/2 / 7-3/4 in (random)', length: '48 in', surface_texture: 'Hand Scraped', lbs: 50.20, sqft: 22.46, pallet: 39, cost: 1.99,
    colors: [['EX-916','Rye Maple'],['EX-925','Sunset Maple'],['EX-929','Ash Maple'],['EX-930','Chocolate Maple']] },
  { collection: 'Reclaimed', thickness: '12 mm', width: '3-1/2 / 5-1/2 / 7-3/4 in (random)', length: '48 in', surface_texture: 'Reclaimed Hand Scraped', lbs: 50.20, sqft: 22.46, pallet: 39, cost: 1.99,
    colors: [['EX-940','Reclaimed Farm House'],['EX-944','Reclaimed Quarry Slate'],['EX-946','Reclaimed Weathered Oak']] },
  { collection: 'Forestland', thickness: '12 mm', width: '5-1/2 in', length: '48 in', surface_texture: 'Modern Wood Grain', lbs: 29.60, sqft: 13.47, pallet: 66, cost: 1.85,
    colors: [['EX-8101','Graphite Oak'],['EX-8102','Light Cloud Oak'],['EX-8105','Iron Oak'],['EX-8107','Charcoal Oak']] },
];
for (const b of LAM_BLOCKS) {
  for (const [item, name] of b.colors) {
    products.push({
      ...LAM_COMMON, item, num: null, name, color: name, collection: b.collection,
      species: b.species || null, surface_texture: b.surface_texture,
      thickness: b.thickness, width: b.width, length: b.length, size: `${b.length} x ${b.width}`,
      wear_layer: null, lbs_box: b.lbs, sqft_box: b.sqft, box_pallet: b.pallet, cost: b.cost,
    });
  }
}

// ============================================================
// PARLIAMENT — WPL WATERPROOF LAMINATE  (category laminate, 12mm)
// 2021-2032 keyed to images by color; 2033-2047 by item number.
// ============================================================
const WPL_COMMON = {
  brand: 'PARLIAMENT', category: 'laminate', collection: 'Waterproof Laminate',
  material: 'Waterproof Laminate', construction: 'Waterproof HDF Laminate', thickness: '12 mm',
  surface_texture: 'Embossed Wood Grain', finish: 'Embossed', acc: 'LAM', status: 'active', water_absorption: 'Waterproof',
};
const WPL_BLOCKS = [
  { width: '7-3/4 in', length: '60 in', lbs: 41.75, sqft: 19.12, pallet: 65, cost: 2.29,
    colors: [['WPL-2021',"St. John's",'ST JOHNS'],['WPL-2022','Key West','KEY WEST'],['WPL-2023','Aruba','ARUBA'],['WPL-2024','Key Largo','KEY LARGO'],
             ['WPL-2025','Kauai','KAUAI'],['WPL-2026','Oahu','OAHU'],['WPL-2027','Tahiti','TAHITI'],['WPL-2028','Fiji','FIJI'],
             ['WPL-2029','Belize','BELIZE'],['WPL-2030','Costa Rica','COSTA RICA'],['WPL-2031','Bahamas','BAHAMAS'],['WPL-2032','Ibiza','IBIZA']] },
  { width: '9 in', length: '60 in', lbs: 41.75, sqft: 23.15, pallet: 52, cost: 2.49,
    colors: [['WPL-2033','Mission Beach'],['WPL-2034','San Clemente'],['WPL-2035','Laguna Beach'],['WPL-2036','Newport Beach'],['WPL-2037','Santa Barbara'],['WPL-2038','Big Sur']] },
  { width: '9 in', length: '60 in', lbs: 51.20, sqft: 23.15, pallet: 52, cost: 2.49,
    // 2043 named "Peerless" (current vendor-site name) to avoid duplicate-name
    // collision with 2047 "Vogue" (Jan-2025 PDF listed both as "Vogue").
    colors: [['WPL-2040','Elite'],['WPL-2041','Unique'],['WPL-2042','Glamour'],['WPL-2043','Peerless'],['WPL-2045','Prestige'],['WPL-2046','Dashing'],['WPL-2047','Vogue']] },
];
for (const b of WPL_BLOCKS) {
  for (const [item, name, colorKey] of b.colors) {
    products.push({
      ...WPL_COMMON, item, num: num(item), img_color_key: colorKey ? `WPL-${colorKey}` : null,
      name, color: name, wear_layer: null,
      thickness: WPL_COMMON.thickness, width: b.width, length: b.length, size: `${b.length} x ${b.width}`,
      lbs_box: b.lbs, sqft_box: b.sqft, box_pallet: b.pallet, cost: b.cost,
    });
  }
}

// ============================================================
// ELEVATE — engineered European Oak  (category engineered-hardwood)
// ============================================================
const ELV_COMMON = {
  brand: 'ELEVATE', category: 'engineered-hardwood', collection: 'Elevate Premium Hardwood',
  material: 'Engineered Hardwood', construction: 'Engineered', species: 'European Oak',
  surface_texture: 'Light Wire Brushed', finish: 'Double Stained', wear_layer: '4 mm Veneer',
  thickness: '5/8 in', width: '9-1/2 in', length: '6-1/4 ft (random)', size: '5/8 x 9-1/2 in x RL',
  lbs_box: 49.3, sqft_box: 30.22, box_pallet: 40, cost: 5.29, acc: 'ELEVATE', status: 'active',
};
const ELV = [['ELV-001C','Chateau'],['ELV-002S','Shoreline'],['ELV-003B','Beach House'],['ELV-004L','Lake House'],['ELV-005M','Mountain Retreat'],
             ['ELV-006M','Mansion'],['ELV-007S','Sand Dune'],['ELV-008A','Arroyo'],['ELV-009V','Vista View'],['ELV-010Y','Vineyard']];
for (const [item, name] of ELV) products.push({ ...ELV_COMMON, item, num: null, name, color: name });

// ============================================================
// VISIONS — engineered hardwood, 3 series  (category engineered-hardwood)
// ============================================================
const VIS_COMMON = { brand: 'VISIONS', category: 'engineered-hardwood', material: 'Engineered Hardwood', construction: 'Engineered', acc: 'VISIONS', status: 'active' };
// Cornerstone — Maple/Hickory, hand scraped, 2mm veneer, 1/2 x 7-1/2
const VIS_CORNER = { collection: 'Cornerstone', surface_texture: 'Hand Scraped', finish: 'Double Stained', wear_layer: '2 mm Veneer',
  thickness: '1/2 in', width: '7-1/2 in', length: '6 ft (random)', size: '1/2 x 7-1/2 in x RL', lbs_box: 49.3, sqft_box: 31.09, box_pallet: 45, cost: 4.69 };
const CORNER = [['VIS201CL','Classic','Maple'],['VIS202TR','Traditions','Maple'],['VIS203OR','Origin','Maple'],['VIS204HI','Historic','Maple'],['VIS205MS','Milestone','Maple'],
                ['VIS210ES','Essence','Hickory'],['VIS211AG','Ageless','Hickory'],['VIS215PT','Perfect Tone','Maple'],['VIS216LX','Lexington','Hickory']];
for (const [item, name, sp] of CORNER) products.push({ ...VIS_COMMON, ...VIS_CORNER, item, num: null, name, color: name, species: sp });
// Designer — French Oak, wire brushed, 3mm veneer, 9/16
const VIS_DESIGN = { collection: 'Designer', surface_texture: 'Wire Brushed', finish: 'Double Stained', wear_layer: '3 mm Veneer', species: 'French Oak', thickness: '9/16 in' };
const DESIGN_A = [['VIS301SH','Shore',23.31],['VIS302PR','Prarie',22.82],['VIS303ST','Stone',22.82],['VIS307CA','Canyon',22.82],['VIS312GL','Glacier',23.31],
                  ['VIS313CO','Coastal',23.31],['VIS314OC','Oceans',23.31],['VIS315SU','Sunset',23.31],['VIS316OA','Oasis',23.31]];
for (const [item, name, sqft] of DESIGN_A) products.push({ ...VIS_COMMON, ...VIS_DESIGN, item, num: null, name, color: name,
  width: '7-1/2 in', length: '7 ft (random)', size: '9/16 x 7-1/2 in x RL', lbs_box: 46, sqft_box: sqft, box_pallet: 50, cost: 5.39 });
const DESIGN_B = [['VIS319TS','Tucson'],['VIS320SD','Scottsdale'],['VIS321FS','Flagstaff']];
for (const [item, name] of DESIGN_B) products.push({ ...VIS_COMMON, ...VIS_DESIGN, item, num: null, name, color: name,
  width: '9 in', length: '7 ft (random)', size: '9/16 x 9 in x RL', lbs_box: 62.75, sqft_box: 31.26, box_pallet: 40, cost: 5.79 });
const DESIGN_C = [['VIS322SF','Surf'],['VIS323CD','Cloud']];
for (const [item, name] of DESIGN_C) products.push({ ...VIS_COMMON, ...VIS_DESIGN, item, num: null, name, color: name, grade: 'AB Prime Grade',
  width: '7-1/2 in', length: '7 ft (random)', size: '9/16 x 7-1/2 in x RL', lbs_box: 64.75, sqft_box: 23.31, box_pallet: 45, cost: 7.59 });
// Traditional — smooth, 1/2 x 6-1/2
const VIS_TRAD = { collection: 'Traditional', surface_texture: 'Smooth', finish: 'Smooth Finished', wear_layer: null,
  thickness: '1/2 in', width: '6-1/2 in', length: '6 ft (random)', size: '1/2 x 6-1/2 in x RL', lbs_box: 45, sqft_box: 27, box_pallet: 54, cost: 4.69 };
const TRAD = [['VIS401NH','Natural Hickory','Hickory'],['VIS402WH','Wheat','Hickory'],['VIS404NR','Natural Red Oak','Red Oak'],
              ['VIS407NM','Natural Maple','Maple'],['VIS409SO','Sorrel','Maple'],['VIS410JA','Java','Maple']];
for (const [item, name, sp] of TRAD) products.push({ ...VIS_COMMON, ...VIS_TRAD, item, num: null, name, color: name, species: sp });

// ============================================================
// MOLDING SETS  (one accessory product per family; attached to every floor in
// that family via sku_accessories).  Prices = COST per 94"/78" piece.
// ============================================================
const molding_sets = {
  SPC: { name: 'Parliament SPC Moldings', family: 'SPC', material: 'SPC Vinyl', length: '94 in', category: 'transitions-moldings',
    desc: 'Matching SPC transition and trim moldings for Parliament rigid-core vinyl plank floors. Sold per 94" piece.',
    pieces: [{ type: 'T-Molding', code: 'TM', cost: 17.99 }, { type: 'Reducer', code: 'RD', cost: 17.99 }, { type: 'End Cap', code: 'EC', cost: 17.99 },
             { type: 'Quarter Round', code: 'QR', cost: 12.99 }, { type: 'Stair Nose', code: 'SN', cost: 25.99 }, { type: 'Flush Stair Nose', code: 'SNF', cost: 32.99 }] },
  WPC: { name: 'Parliament WPC Moldings', family: 'WPC', material: 'WPC Vinyl', length: '94 in', category: 'transitions-moldings',
    desc: 'Matching WPC transition and trim moldings for Parliament Generations waterproof plank floors. Sold per 94" piece.',
    pieces: [{ type: 'T-Molding', code: 'TM', cost: 15.99 }, { type: 'Reducer', code: 'RD', cost: 15.99 }, { type: 'End Cap', code: 'EC', cost: 15.99 },
             { type: 'Quarter Round', code: 'QR', cost: 10.99 }, { type: 'Overlap Stair Nose', code: 'SN', cost: 23.99 }, { type: 'Flush Stair Nose', code: 'SNF', cost: 30.99 }] },
  LAM: { name: 'Parliament Laminate Moldings', family: 'LAM', material: 'Laminate', length: '94 in', category: 'transitions-moldings',
    desc: 'Matching laminate transition and trim moldings for Parliament laminate & waterproof-laminate floors. Sold per 94" piece.',
    pieces: [{ type: 'T-Molding', code: 'TM', cost: 17.99 }, { type: 'Reducer', code: 'RD', cost: 17.99 }, { type: 'End Cap', code: 'EC', cost: 17.99 },
             { type: 'Quarter Round', code: 'QR', cost: 12.99 }, { type: 'Stair Nose', code: 'SN', cost: 25.99 }, { type: 'Flush Stair Nose', code: 'SNF', cost: 32.99 }] },
  ELEVATE: { name: 'Elevate Hardwood Moldings', family: 'ELEVATE', material: 'Engineered Hardwood', length: '78 in', category: 'transitions-moldings',
    desc: 'Color-coordinated engineered-hardwood transition moldings for Elevate Premium Hardwood floors. Sold per piece.',
    pieces: [{ type: 'Quarter Round', code: 'QR', cost: 29.65, length: '78 in' }, { type: 'T-Molding', code: 'TM', cost: 59.98, length: '78 in' },
             { type: 'Reducer', code: 'RD', cost: 59.98, length: '78 in' }, { type: 'Threshold', code: 'TH', cost: 59.98, length: '78 in' },
             { type: 'Stair Nose', code: 'SN', cost: 94.43, length: '94 in' }] },
  VISIONS: { name: 'Visions Hardwood Moldings', family: 'VISIONS', material: 'Engineered Hardwood', length: '78 in', category: 'transitions-moldings',
    desc: 'Color-coordinated engineered-hardwood transition moldings for Visions hardwood floors. Sold per piece.',
    pieces: [{ type: 'Quarter Round', code: 'QR', cost: 29.65, length: '78 in' }, { type: 'T-Molding', code: 'TM', cost: 59.98, length: '78 in' },
             { type: 'Reducer', code: 'RD', cost: 59.98, length: '78 in' }, { type: 'Threshold', code: 'TH', cost: 59.98, length: '78 in' },
             { type: 'Stair Nose', code: 'SN', cost: 94.43, length: '94 in' }] },
};

// ============================================================
// UNDERLAYMENTS & POLY SHEETING  (category underlayment, sold per sqft)
// Standalone Parliament products (not force-attached to every plank).
// ============================================================
const underlayments = [
  { item: 'U-SILVER', name: 'Basic Silver Underlayment 3mm', cost: 0.10, spec: '3mm foam, 200 sqft roll', thickness: '3 mm' },
  { item: 'U-BLUESOLUTION-100', name: 'Blue EVA Underlayment 3mm', cost: 0.30, spec: '3mm EVA, 100 sqft roll', thickness: '3 mm' },
  { item: 'U-GREYSOLUTION-200', name: 'Grey EVA Underlayment 3mm', cost: 0.30, spec: '3mm EVA, 200 sqft roll', thickness: '3 mm' },
  { item: 'WPC-IXPE', name: 'Sound Solution IXPE Underlayment 1.5mm', cost: 0.25, spec: '1.5mm IXPE acoustic', thickness: '1.5 mm' },
  { item: 'CORK-1-4', name: '1/4" Cork Underlayment (6mm)', cost: 0.69, spec: '6mm cork, 2ft x 3ft sheet (6 sqft/sheet)', thickness: '6 mm' },
  { item: 'CORK-1-2', name: '1/2" Cork Underlayment (12mm)', cost: 1.39, spec: '12mm cork, 2ft x 3ft sheet (6 sqft/sheet)', thickness: '12 mm' },
  { item: '6-MIL-POLY', name: '6-Mil Poly Film Moisture Barrier', cost: 0.07, spec: '6-mil poly film, 400 sqft roll', thickness: '0.06 mm' },
];

// ============================================================
const catalog = {
  vendor: {
    name: 'Parliament Floors', code: 'PARL',
    website: 'https://parliamentfloors.com', email: 'Sales@ParliamentFloors.com',
    phone: '(909) 390-7677', fax: '(909) 443-5877',
    address: '109 N McKinley St, Corona, CA 92879',
    notes: 'SPC / WPC / laminate / engineered-hardwood distributor & manufacturer (Corona, CA). Brands: Parliament, Elevate Premium Hardwood, Visions. Onboarded from the Jan-2025 dealer price lists — dealer price = Roma cost, retail = cost x1.6 keystone.',
  },
  brands: [
    { name: 'Parliament', code: 'PARLIAMENT_BRAND', website: 'https://parliamentfloors.com' },
    { name: 'Elevate Premium Hardwood', code: 'ELEVATE', website: 'https://elevatepremiumhardwood.com' },
    { name: 'Visions', code: 'VISIONS', website: 'https://parliamentfloors.com' },
  ],
  products, molding_sets, underlayments,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));

// ---- summary ----
const byBrand = {};
const byCat = {};
for (const p of products) { byBrand[p.brand] = (byBrand[p.brand] || 0) + 1; byCat[p.category] = (byCat[p.category] || 0) + 1; }
console.log('=== Parliament catalog built ===');
console.log('Products:', products.length);
console.log('By brand:', byBrand);
console.log('By category:', byCat);
console.log('Molding sets:', Object.keys(molding_sets).length, '· Underlayments:', underlayments.length);
// duplicate (collection,name) check — would violate products_vendor_collection_name_unique
const seen = new Map();
let dups = 0;
for (const p of products) { const k = `${p.collection}||${p.name}`; if (seen.has(k)) { console.log('  ! DUP:', k); dups++; } seen.set(k, 1); }
console.log(dups ? `  ${dups} duplicate name(s)!` : '  no duplicate (collection,name) collisions');
