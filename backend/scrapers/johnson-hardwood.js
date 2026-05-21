/**
 * Johnson Hardwood — Full Scraper
 *
 * Phase 1: Upsert products, SKUs, pricing, packaging, attributes from PDF price list data
 * Phase 2: Scrape johnsonhardwood.com for product images
 *
 * URL patterns:
 *   Series pages:  /series/[series-slug]/
 *   Product pages: /products/[sku-lowercase]-[color-slug]/
 *
 * Usage: docker compose exec api node scrapers/johnson-hardwood.js
 */

import pg from 'pg';
import {
  launchBrowser, delay,
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  upsertSkuAttribute, saveSkuImages, filterImageUrls,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://johnsonhardwood.com';
const VENDOR_CODE = 'JOHNSONHW';

// ──────────────────────────────────────────────
// Accessory builders — keep SERIES_DATA compact
// ──────────────────────────────────────────────

function engAcc(tm, th, rd, qr, sn) {
  return [
    { name: 'T-Mold', price: tm, suffix: 'TMOLD', len: '78"' },
    { name: 'Threshold', price: th, suffix: 'THRESH', len: '78"' },
    { name: 'Reducer', price: rd, suffix: 'REDUCER', len: '78"' },
    { name: 'Quarter Round', price: qr, suffix: 'QTRRD', len: '84"' },
    { name: 'Stair Nose', price: sn, suffix: 'STAIRNOSE', len: '84"' },
  ];
}

function spcAcc(tm, th, rd, qr, fsn) {
  return [
    { name: 'T-Mold', price: tm, suffix: 'TMOLD', len: '94"' },
    { name: 'Threshold', price: th, suffix: 'THRESH', len: '94"' },
    { name: 'Reducer', price: rd, suffix: 'REDUCER', len: '94"' },
    { name: 'Quarter Round', price: qr, suffix: 'QTRRD', len: '94"' },
    { name: 'Flush Stair Nose', price: fsn, suffix: 'FLUSHSN', len: '94"' },
  ];
}

function fmAcc(threeIn1, versa, qr, tmrd, fsn) {
  return [
    { name: '3-in-1 Molding', price: threeIn1, suffix: '3IN1', len: '94"' },
    { name: 'Versa Edge', price: versa, suffix: 'VERSAEDGE', len: '94"' },
    { name: 'Quarter Round', price: qr, suffix: 'QTRRD', len: '94"' },
    { name: 'T-Mold/Reducer', price: tmrd, suffix: 'TMOLDRD', len: '94"' },
    { name: 'Flush Stair Nose', price: fsn, suffix: 'FLUSHSN', len: '94"' },
  ];
}

// ──────────────────────────────────────────────
// PDF price list data (Nov 17, 2025)
// Each entry = one group of SKUs with uniform specs/pricing
// ──────────────────────────────────────────────

const SERIES_DATA = [
  // ═══ ENGINEERED HARDWOOD ═══

  // 1. Alehouse — Maple
  {
    series: 'Alehouse', slug: 'alehouse', material: 'Engineered Hardwood',
    finish: 'Vintage', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
    veneer: '2MM', sqftPerCtn: 26, ctnPerPlt: 55, lbsPerCtn: 45, cost: 5.05,
    accessories: engAcc(66, 66, 66, 48, 91),
    colors: [
      { sku: 'AME-AHM19001', name: 'Maple Maibock' },
      { sku: 'AME-AHM19002', name: 'Maple Hefeweizen' },
      { sku: 'AME-AHM19003', name: 'Maple Copper Ale' },
      { sku: 'AME-AHM19004', name: 'Maple Barley Ale' },
      { sku: 'AME-AHM19005', name: 'Maple Strawberry Blonde' },
      { sku: 'AME-AHM19006', name: 'Maple Doppelbock' },
    ],
  },
  // 2. Alehouse — Oak
  {
    series: 'Alehouse', slug: 'alehouse', material: 'Engineered Hardwood',
    finish: 'Vintage', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
    veneer: '2MM', sqftPerCtn: 26, ctnPerPlt: 55, lbsPerCtn: 45, cost: 4.90,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-AHO19008', name: 'Oak Marzen' },
      { sku: 'AME-AHO19009', name: 'Oak Blonde' },
      { sku: 'AME-AHO19010', name: 'Oak Saison' },
    ],
  },
  // 3. English Pub — Maple Handscraped
  {
    series: 'English Pub', slug: 'english-pub', material: 'Engineered Hardwood',
    finish: 'Handscraped', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
    veneer: '2MM', sqftPerCtn: 26, ctnPerPlt: 55, lbsPerCtn: 50, cost: 4.90,
    accessories: engAcc(66, 66, 66, 48, 91),
    colors: [
      { sku: 'AME-EM19001', name: 'Maple Smoked Bourbon' },
      { sku: 'AME-EM19002', name: 'Maple Whiskey' },
      { sku: 'AME-EM19003', name: 'Maple Brandy Wine' },
      { sku: 'AME-EM19004', name: 'Maple Amber Ale' },
      { sku: 'AME-EM19005', name: 'Maple Stout' },
      { sku: 'AME-EM19006', name: 'Maple Cognac' },
      { sku: 'AME-EM19007', name: 'Maple Moonshine' },
    ],
  },
  // 4. English Pub — Hickory Handscraped
  {
    series: 'English Pub', slug: 'english-pub', material: 'Engineered Hardwood',
    finish: 'Handscraped', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
    veneer: '2MM', sqftPerCtn: 26, ctnPerPlt: 55, lbsPerCtn: 50, cost: 5.50,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-EH19001', name: 'Hickory Applejack' },
      { sku: 'AME-EH19002', name: 'Hickory Rye' },
    ],
  },
  // 5. English Pub — Hickory Smooth
  {
    series: 'English Pub', slug: 'english-pub', material: 'Engineered Hardwood',
    finish: 'Smooth', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
    veneer: '2MM', sqftPerCtn: 26, ctnPerPlt: 55, lbsPerCtn: 50, cost: 5.50,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-ESH19001', name: 'Hickory Porter' },
      { sku: 'AME-ESH19002', name: 'Hickory Scotch' },
      { sku: 'AME-ESH19003', name: 'Hickory Pilsner' },
    ],
  },
  // 6. Grand Chateau
  {
    series: 'Grand Chateau', slug: 'grand-chateau', material: 'Engineered Hardwood',
    finish: 'Wire-Brushed', thickness: '9/16"', width: '8-5/8"', length: '11"-84"',
    veneer: '3MM', sqftPerCtn: 31.3, ctnPerPlt: 40, lbsPerCtn: 67, cost: 5.45,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-GC22001', name: 'European Oak Chambord' },
      { sku: 'AME-GC22002', name: 'European Oak Barnard' },
      { sku: 'AME-GC22003', name: 'European Oak Valer' },
      { sku: 'AME-GC22004', name: 'European Oak Alswick' },
      { sku: 'AME-GC22005', name: 'European Oak Chillon' },
      { sku: 'AME-GC22006', name: 'European Oak Corvin' },
      { sku: 'AME-GC22007', name: 'European Oak Caerphilly' },
      { sku: 'AME-GC22008', name: 'European Oak Malahide' },
      { sku: 'AME-GC22009', name: 'European Oak Dover' },
      { sku: 'AME-GC22010', name: 'European Oak Taunton' },
      { sku: 'AME-GC22011', name: 'European Oak Aydon' },
      { sku: 'AME-GC22012', name: 'European Oak Miranda' },
    ],
  },
  // 7. Oak Grove — Standard
  {
    series: 'Oak Grove', slug: 'oak-grove', material: 'Engineered Hardwood',
    defaultSpecies: 'Oak',
    finish: 'Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '11"-75"',
    veneer: '1.2MM', sqftPerCtn: 23.4, ctnPerPlt: 55, lbsPerCtn: 42, cost: 4.30,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-OG19001', name: 'Toumey' },
      { sku: 'AME-OG19002', name: 'Laurel' },
      { sku: 'AME-OG19003', name: 'Emory' },
      { sku: 'AME-OG19004', name: 'Willow' },
      { sku: 'AME-OG19005', name: 'Holm' },
      { sku: 'AME-OG19006', name: 'Mohr' },
      { sku: 'AME-OG19009', name: 'Shumard' },
    ],
  },
  // 8. Oak Grove — Wide Plank
  {
    series: 'Oak Grove', slug: 'oak-grove', material: 'Engineered Hardwood',
    defaultSpecies: 'Oak',
    finish: 'Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '20"-75"',
    veneer: '1.8MM', sqftPerCtn: 31.09, ctnPerPlt: 35, lbsPerCtn: 55, cost: 5.50,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-OG19010', name: 'Gambel' },
      { sku: 'AME-OG19011', name: 'Chestnut' },
      { sku: 'AME-OG19012', name: 'Bark' },
    ],
  },
  // 9. Tuscan — Hickory Handscraped
  {
    series: 'Tuscan', slug: 'tuscan', material: 'Engineered Hardwood',
    finish: 'Handscraped', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
    veneer: '2MM', sqftPerCtn: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, cost: 5.80,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-E46701', name: 'Hickory Sienna' },
      { sku: 'AME-E46702', name: 'Hickory Florence' },
      { sku: 'AME-E46703', name: 'Hickory Toscana' },
      { sku: 'AME-E46707', name: 'Hickory Casentino' },
    ],
  },
  // 10. Tuscan — Walnut Palazzo
  {
    series: 'Tuscan', slug: 'tuscan', material: 'Engineered Hardwood',
    finish: 'Handscraped', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
    veneer: '2MM', sqftPerCtn: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, cost: 6.10,
    accessories: engAcc(84, 84, 84, 54, 114),
    colors: [
      { sku: 'AME-E46705', name: 'Walnut Palazzo' },
    ],
  },
  // 11. Tuscan — Walnut Lucca
  {
    series: 'Tuscan', slug: 'tuscan', material: 'Engineered Hardwood',
    finish: 'Smooth', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
    veneer: '2MM', sqftPerCtn: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, cost: 6.10,
    accessories: engAcc(84, 84, 84, 54, 114),
    colors: [
      { sku: 'AME-E46706', name: 'Walnut Lucca' },
    ],
  },
  // 12. Tuscan — Hickory Vintage
  {
    series: 'Tuscan', slug: 'tuscan', material: 'Engineered Hardwood',
    finish: 'Vintage', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
    veneer: '2MM', sqftPerCtn: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, cost: 5.80,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-E46709', name: 'Hickory Genoa' },
      { sku: 'AME-E46710', name: 'Hickory Catania' },
      { sku: 'AME-E46711', name: 'Hickory Arrezo' },
      { sku: 'AME-E46712', name: 'Hickory Prato' },
    ],
  },
  // 13. Tuscan — Maple
  {
    series: 'Tuscan', slug: 'tuscan', material: 'Engineered Hardwood',
    finish: 'Handscraped', thickness: '1/2"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
    veneer: '2MM', sqftPerCtn: 41.5, ctnPerPlt: 30, lbsPerCtn: 71, cost: 4.59,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-EM46700', name: 'Maple Sunset' },
      { sku: 'AME-EM46705', name: 'Maple Verona' },
    ],
  },

  // ═══ SPC ═══

  // 14. Cellar House
  {
    series: 'Cellar House', slug: 'cellar-house', material: 'SPC Vinyl',
    finish: 'Embossed', thickness: '5.5 MM', width: '7-1/8"', length: '60"',
    wearLayer: '20 MIL', sqftPerCtn: 29.86, ctnPerPlt: 45, lbsPerCtn: 51.2, cost: 1.89,
    accessories: spcAcc(35, 35, 35, 25, 55),
    colors: [
      { sku: 'CELLAR-18201', name: 'Barbera' },
      { sku: 'CELLAR-18202', name: 'Nebbiolo' },
      { sku: 'CELLAR-18203', name: 'Carignan' },
      { sku: 'CELLAR-18204', name: 'Sangiovese' },
      { sku: 'CELLAR-18205', name: 'Charbono' },
      { sku: 'CELLAR-18206', name: 'Dolcetto' },
      { sku: 'CELLAR-18207', name: 'Grenache' },
      { sku: 'CELLAR-18208', name: 'Primitivo' },
      { sku: 'CELLAR-18209', name: 'Semillon' },
      { sku: 'CELLAR-18210', name: 'Kerner' },
      { sku: 'CELLAR-18211', name: 'Elbling' },
      { sku: 'CELLAR-18212', name: 'Malvasia' },
    ],
  },
  // 15. Farmhouse Manor
  {
    series: 'Farmhouse Manor', slug: 'farmhouse-manor', material: 'SPC Vinyl',
    finish: 'Embossed', thickness: '7.5 MM', width: '7-1/8"', length: '48"',
    wearLayer: '20 MIL', sqftPerCtn: 19.12, ctnPerPlt: 40, lbsPerCtn: 49, cost: 2.55,
    accessories: fmAcc(35, 45, 18, 35, 55),
    colors: [
      { sku: 'FM-18201', name: 'Cairnwood' },
      { sku: 'FM-18202', name: 'Oxmoor' },
      { sku: 'FM-18203', name: 'Glidden' },
      { sku: 'FM-18204', name: 'New Haven' },
      { sku: 'FM-18205', name: 'High Valley' },
      { sku: 'FM-18206', name: 'Southwind' },
      { sku: 'FM-18207', name: 'Nightfall' },
      { sku: 'FM-18208', name: 'Iron Hill' },
      { sku: 'FM-18209', name: 'Briarcliff' },
      { sku: 'FM-18210', name: 'Ardenwood' },
      { sku: 'FM-18211', name: 'Monticello' },
    ],
  },
  // 16. Public House
  {
    series: 'Public House', slug: 'public-house', material: 'SPC Vinyl',
    finish: 'EIR', thickness: '7.5 MM', width: '7"', length: '60"',
    wearLayer: '30 MIL', sqftPerCtn: 17.52, ctnPerPlt: 55, lbsPerCtn: 45, cost: 2.99,
    accessories: spcAcc(35, 35, 35, 25, 55),
    colors: [
      { sku: 'PHS-17801', name: 'French 75' },
      { sku: 'PHS-17802', name: 'Gin Rickey' },
      { sku: 'PHS-17803', name: 'Southside' },
      { sku: 'PHS-17804', name: 'Sidecar' },
      { sku: 'PHS-17805', name: 'Highball' },
      { sku: 'PHS-17806', name: 'Whiskey Sour' },
      { sku: 'PHS-17807', name: 'Manhattan' },
      { sku: 'PHS-17808', name: 'Old Fashioned' },
    ],
  },
  // 17. Sicily
  {
    series: 'Sicily', slug: 'sicily', material: 'SPC Vinyl',
    finish: 'Embossed', thickness: '7.5 MM', width: '4", 6", 8"', length: '72"',
    wearLayer: '20 MIL', sqftPerCtn: 36.02, ctnPerPlt: 36, lbsPerCtn: 92, cost: 2.99,
    accessories: fmAcc(35, 45, 18, 35, 55),
    colors: [
      { sku: '3WS-46801', name: 'Messina' },
      { sku: '3WS-46802', name: 'Enna' },
      { sku: '3WS-46803', name: 'Trapani' },
      { sku: '3WS-46804', name: 'Syracuse' },
    ],
  },
  // 18. Skyview
  {
    series: 'Skyview', slug: 'skyview', material: 'SPC Vinyl',
    finish: 'EIR', thickness: '7.5 MM', width: '9"', length: '60"',
    wearLayer: '30 MIL', sqftPerCtn: 21.95, ctnPerPlt: 44, lbsPerCtn: 56.5, cost: 2.69,
    accessories: spcAcc(35, 35, 35, 25, 55),
    colors: [
      { sku: 'SV-22301', name: 'Lightning' },
      { sku: 'SV-22302', name: 'Celestial' },
      { sku: 'SV-22303', name: 'Nimbus' },
      { sku: 'SV-22304', name: 'Morning Fog' },
      { sku: 'SV-22305', name: 'Storm' },
      { sku: 'SV-22306', name: 'Cumulus' },
      { sku: 'SV-22307', name: 'Aurora' },
      { sku: 'SV-22308', name: 'Meteor' },
      { sku: 'SV-22309', name: 'Nebula' },
      { sku: 'SV-22310', name: 'Starlight' },
      { sku: 'SV-22311', name: 'Horizon' },
      { sku: 'SV-22312', name: 'Equinox' },
    ],
  },

  // ═══ HIGH PERFORMANCE FLOORING (HPF) ═══

  // 19. Bella Vista
  {
    series: 'Bella Vista', slug: 'bella-vista', material: 'Laminate',
    finish: 'EIR', thickness: '13.5 MM', width: '7-5/8"', length: 'Multi-Length (23.5", 47", 71")',
    wearLayer: 'AC5', sqftPerCtn: 22.6, ctnPerPlt: 55, lbsPerCtn: 50.3, cost: 2.69,
    accessories: spcAcc(35, 35, 35, 25, 55),
    colors: [
      { sku: 'BVS-19401', name: 'Monza' },
      { sku: 'BVS-19402', name: 'Capri' },
      { sku: 'BVS-19403', name: 'Viceroy' },
      { sku: 'BVS-19404', name: 'Sardinia' },
      { sku: 'BVS-19405', name: 'Praiano' },
      { sku: 'BVS-19406', name: 'Lorena' },
      { sku: 'BVS-19407', name: 'Calabria' },
      { sku: 'BVS-19408', name: 'Savoy' },
      { sku: 'BVS-19409', name: 'Vienna' },
      { sku: 'BVS-19410', name: 'Milan' },
      { sku: 'BVS-19411', name: 'Lombardy' },
      { sku: 'BVS-19412', name: 'Ferdinand' },
    ],
  },
  // 20. Olde Tavern
  {
    series: 'Olde Tavern', slug: 'olde-tavern', material: 'Laminate',
    finish: 'EIR', thickness: '13.5 MM', width: '6-1/2"', length: '48"',
    wearLayer: 'AC4', sqftPerCtn: 15.2, ctnPerPlt: 50, lbsPerCtn: 33.8, cost: 2.55,
    accessories: spcAcc(35, 35, 35, 25, 55),
    colors: [
      { sku: 'OTS-16501', name: 'Vesper' },
      { sku: 'OTS-16502', name: 'Dark and Stormy' },
      { sku: 'OTS-16503', name: 'Tom Collins' },
      { sku: 'OTS-16504', name: 'Posset' },
      { sku: 'OTS-16505', name: 'Espresso Martini' },
      { sku: 'OTS-16506', name: 'Bramble' },
      { sku: 'OTS-16507', name: 'Spritz' },
      { sku: 'OTS-16508', name: 'Bellini' },
      { sku: 'OTS-16509', name: 'Paloma' },
      { sku: 'OTS-16510', name: 'Wassail' },
      { sku: 'OTS-16511', name: 'Hemingway' },
      { sku: 'OTS-16512', name: 'Gimlet' },
    ],
  },

  // ═══ NEW RELEASES (Engineered Hardwood) ═══

  // 21. Canyon Ridge
  {
    series: 'Canyon Ridge', slug: 'canyon-ridge-series', material: 'Engineered Hardwood',
    finish: 'Light Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '11"-75"',
    veneer: '1.2MM', sqftPerCtn: 23.4, ctnPerPlt: 55, lbsPerCtn: 45, cost: 4.25,
    accessories: engAcc(67, 67, 67, 48, 91),
    colors: [
      { sku: 'AME-CRH19001', name: 'Hickory Sandstone' },
      { sku: 'AME-CRH19002', name: 'Hickory Amber' },
      { sku: 'AME-CRH19003', name: 'Hickory Jasper' },
      { sku: 'AME-CRH19004', name: 'Hickory Topaz' },
      { sku: 'AME-CRH19005', name: 'Hickory Moonstone' },
      { sku: 'AME-CRH19006', name: 'Hickory Flint' },
    ],
  },
  // 22. Countryside Oak
  {
    series: 'Countryside Oak', slug: 'countryside-oak', material: 'Engineered Hardwood',
    finish: 'Light Wire-Brushed', thickness: '3/8"', width: '7-1/2"', length: '16"-67"',
    veneer: '1.0MM', sqftPerCtn: 43, ctnPerPlt: 45, lbsPerCtn: 55, cost: 3.25,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-CSO19001', name: 'European Oak Tortilla' },
      { sku: 'AME-CSO19002', name: 'European Oak Buttermilk' },
      { sku: 'AME-CSO19003', name: 'European Oak Driftwood' },
      { sku: 'AME-CSO19004', name: 'European Oak Pebble' },
      { sku: 'AME-CSO19005', name: 'European Oak Wheat' },
      { sku: 'AME-CSO19006', name: 'European Oak Hazelnut' },
      { sku: 'AME-CSO19007', name: 'European Oak Almond' },
      { sku: 'AME-CSO19008', name: 'European Oak Biscuit' },
      { sku: 'AME-CSO19009', name: 'European Oak Sandstone' },
      { sku: 'AME-CSO19010', name: 'European Oak Caramel' },
    ],
  },
  // 23. Olympus
  {
    series: 'Olympus', slug: 'olympus-series', material: 'Engineered Hardwood',
    finish: 'Light Wire-Brushed', thickness: '1/2"', width: '11-7/8"', length: '16"-86"',
    veneer: '1.2MM', sqftPerCtn: 42.63, ctnPerPlt: 33, lbsPerCtn: 80, cost: 5.00,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'PL-OLH30001', name: 'Hickory Athena' },
      { sku: 'PL-OLH30002', name: 'Hickory Apollo' },
      { sku: 'PL-OLO30003', name: 'Oak Ares' },
      { sku: 'PL-OLO30004', name: 'Oak Artemis' },
      { sku: 'PL-OLO30005', name: 'Oak Zeus' },
      { sku: 'PL-OLO30006', name: 'Oak Hera' },
    ],
  },
  // 24. Texas Timber
  {
    series: 'Texas Timber', slug: 'texas-timber', material: 'Engineered Hardwood',
    finish: 'Light Wire-Brushed', thickness: '3/8"', width: '7-1/2"', length: '16"-75"',
    veneer: '1.2MM', sqftPerCtn: 38.9, ctnPerPlt: 45, lbsPerCtn: 52, cost: 3.25,
    accessories: engAcc(69, 69, 69, 48, 93),
    colors: [
      { sku: 'AME-TTO19001', name: 'European Oak Alabaster' },
      { sku: 'AME-TTO19002', name: 'European Oak Parchment' },
      { sku: 'AME-TTO19003', name: 'European Oak Sand' },
      { sku: 'AME-TTO19004', name: 'European Oak Taupe' },
      { sku: 'AME-TTO19005', name: 'European Oak Amber' },
      { sku: 'AME-TTO19006', name: 'European Oak Tawny' },
      { sku: 'AME-TTO19007', name: 'European Oak Honey' },
      { sku: 'AME-TTO19008', name: 'European Oak Chestnut' },
      { sku: 'AME-TTO19009', name: 'European Oak Labrador' },
      { sku: 'AME-TTO19010', name: 'European Oak Carob' },
    ],
  },
];

// Series slug map for website URLs
const SERIES_SLUGS = {
  'Alehouse':        'alehouse',
  'English Pub':     'english-pub',
  'Grand Chateau':   'grand-chateau',
  'Oak Grove':       'oak-grove',
  'Tuscan':          'tuscan',
  'Canyon Ridge':    'canyon-ridge-series',
  'Countryside Oak': 'countryside-oak',
  'Olympus':         'olympus-series',
  'Texas Timber':    'texas-timber',
  'Cellar House':    'cellar-house',
  'Farmhouse Manor': 'farmhouse-manor',
  'Public House':    'public-house',
  'Sicily':          'sicily',
  'Skyview':         'skyview',
  'Bella Vista':     'bella-vista',
  'Olde Tavern':     'olde-tavern',
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Extract wood species from product name ("Maple Maibock" → "Maple") */
function extractSpecies(name) {
  if (!name) return null;
  if (/^european oak /i.test(name)) return 'European Oak';
  if (/^maple /i.test(name)) return 'Maple';
  if (/^hickory /i.test(name)) return 'Hickory';
  if (/^walnut /i.test(name)) return 'Walnut';
  if (/^oak /i.test(name)) return 'Oak';
  return null;
}

/** Extract color name by stripping species prefix */
function extractColorName(name, species) {
  if (species && name.toLowerCase().startsWith(species.toLowerCase() + ' ')) {
    return name.slice(species.length + 1);
  }
  return name;
}

/** Classify Johnson Hardwood image URLs — product photo vs room scene */
function sortJohnsonImages(urls) {
  const productPhotos = [];
  const unknowns = [];
  const roomScenes = [];

  for (const url of urls) {
    const filename = url.toLowerCase().split('/').pop().split('?')[0];
    // Positive: product/plank close-up
    if (filename.includes('_full_') || filename.includes('_full.')) {
      productPhotos.push(url);
    } else if (/_web\b/.test(filename) && !filename.includes('roomscene') && !filename.includes('room')) {
      productPhotos.push(url);
    // Negative: room scene / lifestyle
    } else if (filename.includes('roomscene') || filename.includes('_roomscene') ||
               filename.includes('_dsc_') || filename.includes('_dsc') ||
               filename.includes('_detail') || filename.includes('ambiance') ||
               filename.includes('ambience') || filename.includes('_room')) {
      roomScenes.push(url);
    } else {
      unknowns.push(url);
    }
  }

  return [...productPhotos, ...unknowns, ...roomScenes];
}

/** Get full-size URL from a WordPress thumbnail URL */
function getFullSizeUrl(url) {
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    const distance = 400;
    const d = 250;
    const height = document.body.scrollHeight;
    for (let pos = 0; pos < height; pos += distance) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, d));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

/** Extract product cards from a series listing page */
async function extractSeriesCards(page, seriesUrl) {
  try {
    const resp = await page.goto(seriesUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp ? resp.status() : 'no response'}`);
      return [];
    }
    await delay(1500);
    await scrollToLoadAll(page);

    return page.evaluate(() => {
      const cards = [];
      const seen = new Set();
      const allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (const a of allLinks) {
        if (!a.href || seen.has(a.href)) continue;
        seen.add(a.href);
        const match = a.href.match(/\/products\/([^/]+)\/?$/);
        if (!match) continue;
        const slug = match[1];
        const img = a.querySelector('img') || a.parentElement?.querySelector('img');
        const thumbUrl = img ? (img.src || img.getAttribute('data-src') || '') : '';
        let colorName = '';
        const cleaned = a.textContent.trim().replace(/^Color\s*/i, '').trim();
        const lines = cleaned.split(/\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) colorName = lines[0];
        cards.push({ href: a.href, slug, colorName, thumbnail: thumbUrl });
      }
      return cards;
    });
  } catch (err) {
    console.log(`    Error loading series: ${err.message}`);
    return [];
  }
}

/** Extract gallery images from a product detail page */
async function extractDetailImages(page, productUrl) {
  try {
    const resp = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) return [];
    await delay(2000);
    await scrollToLoadAll(page);

    return page.evaluate(() => {
      const imgs = [];
      const seen = new Set();
      for (const img of document.querySelectorAll('img')) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (!src || !src.includes('/wp-content/uploads/')) continue;
        if (src.includes('logo') || src.includes('icon') || src.includes('favicon') ||
            src.includes('banner') || src.includes('pdf-icon') || src.includes('arrow')) continue;
        const w = img.naturalWidth || img.width || 0;
        if (w > 0 && w < 50) continue;
        if (!seen.has(src)) { seen.add(src); imgs.push(src); }
      }
      // Also check gallery link hrefs for full-size originals
      for (const a of document.querySelectorAll('a[href*="/wp-content/uploads/"]')) {
        const href = a.href || '';
        if (href && !seen.has(href) && !href.includes('logo') && !href.includes('.pdf')) {
          seen.add(href);
          imgs.push(href);
        }
      }
      return imgs;
    });
  } catch (err) {
    console.log(`      Error loading detail: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────
// Phase 1: Upsert from PDF data
// ──────────────────────────────────────────────

async function phase1UpsertPdfData(vendorId) {
  console.log('\n══════ Phase 1: Upsert PDF Data ══════\n');

  let totalProducts = 0;
  let totalFlooringSkus = 0;
  let totalAccessorySkus = 0;

  for (const group of SERIES_DATA) {
    console.log(`  ${group.series} (${group.material}, ${group.colors.length} colors, $${group.cost}/sqft)`);

    for (const color of group.colors) {
      // 1. Upsert product
      const product = await upsertProduct(pool, {
        vendor_id: vendorId,
        name: `Johnson Hardwood ${color.name}`,
        collection: group.series,
      });
      totalProducts++;

      // 2. Upsert flooring SKU
      const flooringSku = await upsertSku(pool, {
        product_id: product.id,
        vendor_sku: color.sku,
        internal_sku: `JH-${color.sku}`,
        variant_name: color.name,
        sell_by: 'box',
      });
      totalFlooringSkus++;

      // 3. Pricing (2x markup for retail — matches existing JH data)
      await upsertPricing(pool, flooringSku.id, {
        cost: group.cost,
        retail_price: parseFloat((group.cost * 2).toFixed(2)),
        price_basis: 'per_sqft',
      });

      // 4. Packaging
      await upsertPackaging(pool, flooringSku.id, {
        sqft_per_box: group.sqftPerCtn,
        boxes_per_pallet: group.ctnPerPlt,
        weight_per_box_lbs: group.lbsPerCtn,
      });

      // 5. Attributes
      const species = extractSpecies(color.name) || group.defaultSpecies || null;
      const colorAttr = extractColorName(color.name, species);

      await upsertSkuAttribute(pool, flooringSku.id, 'color', colorAttr);
      await upsertSkuAttribute(pool, flooringSku.id, 'finish', group.finish);
      await upsertSkuAttribute(pool, flooringSku.id, 'material', group.material);
      await upsertSkuAttribute(pool, flooringSku.id, 'thickness', group.thickness);
      if (species) await upsertSkuAttribute(pool, flooringSku.id, 'species', species);
      if (group.wearLayer) await upsertSkuAttribute(pool, flooringSku.id, 'wear_layer', group.wearLayer);
      if (group.veneer) await upsertSkuAttribute(pool, flooringSku.id, 'wear_layer', group.veneer);

      // 6. Accessory SKUs
      for (const acc of group.accessories) {
        const accSku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: `${color.sku}-${acc.suffix}`,
          internal_sku: `JH-${color.sku}-${acc.suffix}`,
          variant_name: `${acc.name}, ${acc.len}`,
          sell_by: 'unit',
          variant_type: 'accessory',
        });
        totalAccessorySkus++;

        await upsertPricing(pool, accSku.id, {
          cost: acc.price,
          retail_price: parseFloat((acc.price * 2).toFixed(2)),
          price_basis: 'per_unit',
        });
      }
    }
  }

  console.log(`\n  Phase 1 Complete:`);
  console.log(`    Products upserted: ${totalProducts}`);
  console.log(`    Flooring SKUs: ${totalFlooringSkus}`);
  console.log(`    Accessory SKUs: ${totalAccessorySkus}`);
  console.log(`    Total SKUs: ${totalFlooringSkus + totalAccessorySkus}`);
}

// ──────────────────────────────────────────────
// Phase 2: Scrape website for images
// ──────────────────────────────────────────────

async function phase2ScrapeImages(vendorId) {
  console.log('\n══════ Phase 2: Scrape Website Images ══════\n');

  // Load all flooring SKUs (non-accessory) for matching
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name as product_name, p.collection,
           s.id as sku_id, s.vendor_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`  Loaded ${skuRows.rowCount} flooring SKUs for matching\n`);

  // Build vendor_sku lookup
  const skuByVendorCode = new Map();
  for (const row of skuRows.rows) {
    if (row.vendor_sku) {
      skuByVendorCode.set(row.vendor_sku.toUpperCase(), row);
    }
  }

  // Skip collections that already have SKU-level images
  const doneRes = await pool.query(`
    SELECT DISTINCT p.collection FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL
    GROUP BY p.collection, (SELECT COUNT(*) FROM products p2 WHERE p2.vendor_id = $1 AND p2.collection = p.collection)
    HAVING COUNT(DISTINCT ma.sku_id) >= (SELECT COUNT(*) FROM skus s2 JOIN products p2 ON p2.id = s2.product_id WHERE p2.vendor_id = $1 AND p2.collection = p.collection AND (s2.variant_type IS NULL OR s2.variant_type != 'accessory'))
  `, [vendorId]);
  const doneCollections = new Set(doneRes.rows.map(r => r.collection));
  if (doneCollections.size > 0) {
    console.log(`  Skipping ${doneCollections.size} collections with existing SKU images: ${[...doneCollections].join(', ')}`);
  }

  let imagesSaved = 0;
  let productsMatched = 0;
  const matchedProducts = new Set();
  const seriesEntries = Object.entries(SERIES_SLUGS).filter(([col]) => !doneCollections.has(col));
  const BATCH_SIZE = 2; // restart browser every N series to prevent OOM

  if (seriesEntries.length === 0) {
    console.log('  All collections already have SKU-level images — skipping Phase 2');
    return;
  }

  console.log(`  ${seriesEntries.length} collections to process\n`);

  for (let batchStart = 0; batchStart < seriesEntries.length; batchStart += BATCH_SIZE) {
    const batch = seriesEntries.slice(batchStart, batchStart + BATCH_SIZE);
    console.log(`\n--- Browser batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(seriesEntries.length / BATCH_SIZE)} (series ${batchStart + 1}-${batchStart + batch.length}) ---`);

    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      for (const [collection, slug] of batch) {
        const seriesUrl = `${BASE_URL}/series/${slug}/`;
        console.log(`\n=== ${collection} — ${seriesUrl} ===`);

        const cards = await extractSeriesCards(page, seriesUrl);
        console.log(`  Found ${cards.length} product cards`);
        if (cards.length === 0) continue;

        for (const card of cards) {
          // Match card to DB product via vendor_sku in URL slug
          let matched = null;
          const cardSlug = card.slug || '';

          for (const [vendorSku, row] of skuByVendorCode) {
            const skuSlug = vendorSku.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            if (cardSlug.startsWith(skuSlug)) {
              matched = row;
              break;
            }
          }

          // Fallback 1: match by color name within collection
          if (!matched && card.colorName) {
            const colorNorm = card.colorName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (colorNorm && !colorNorm.includes('see it') && !colorNorm.includes('gallery')) {
              for (const row of skuRows.rows) {
                if (row.collection !== collection) continue;
                const nameNorm = row.product_name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                if (nameNorm.includes(colorNorm) || colorNorm.includes(nameNorm)) {
                  matched = row;
                  break;
                }
              }
            }
          }

          // Fallback 2: extract color from URL slug (e.g. "texas-timber-series-alabaster" → "alabaster")
          if (!matched && cardSlug) {
            const seriesSlugNorm = slug.replace(/-series$/, '').replace(/-/g, ' ');
            let colorFromSlug = cardSlug.replace(/-/g, ' ').replace(seriesSlugNorm, '').replace(/series/g, '').trim();
            if (colorFromSlug && colorFromSlug !== 'gallery') {
              for (const row of skuRows.rows) {
                if (row.collection !== collection) continue;
                const nameNorm = row.product_name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                if (nameNorm.includes(colorFromSlug) || nameNorm.endsWith(colorFromSlug)) {
                  matched = row;
                  break;
                }
              }
            }
          }

          if (!matched) {
            console.log(`  [SKIP] No match: slug="${cardSlug}" color="${card.colorName}"`);
            continue;
          }

          if (matchedProducts.has(matched.product_id)) continue;
          matchedProducts.add(matched.product_id);
          console.log(`  [MATCH] ${card.colorName} → ${matched.product_name}`);

          // Visit detail page for gallery images
          const rawImages = await extractDetailImages(page, card.href);

          // Filter to only images belonging to THIS product (not sibling colors shown on page)
          // Match by vendor_sku code or color name in the filename
          const vendorSku = matched.vendor_sku || '';
          const skuCode = vendorSku.replace(/^AME-/, '').replace(/^PL-/, '');
          const colorSlug = matched.product_name.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const colorWords = matched.product_name.split(/\s+/).filter(w => w.length > 2).map(w => w.toLowerCase());

          const ownImages = rawImages.filter(src => {
            const fn = src.toLowerCase().split('/').pop();
            // Match by SKU code in filename (e.g., OG19010)
            if (skuCode && fn.includes(skuCode.toLowerCase())) return true;
            // Match by full color slug (e.g., "gambel")
            if (colorSlug && fn.includes(colorSlug)) return true;
            // Match by last word of product name (the actual color, e.g., "gambel" from "Oak Grove Gambel")
            const lastWord = colorWords[colorWords.length - 1];
            if (lastWord && lastWord.length >= 4 && fn.includes(lastWord)) return true;
            return false;
          });

          // Build full-size URL list
          const allUrls = [];
          const seenUrls = new Set();
          for (const src of (ownImages.length > 0 ? ownImages : rawImages.slice(0, 1))) {
            const fullUrl = getFullSizeUrl(src);
            if (!seenUrls.has(fullUrl)) {
              seenUrls.add(fullUrl);
              allUrls.push(fullUrl);
            }
          }

          // Add thumbnail as fallback
          if (card.thumbnail && card.thumbnail.includes('/wp-content/uploads/')) {
            const fullThumb = getFullSizeUrl(card.thumbnail);
            if (!seenUrls.has(fullThumb)) allUrls.push(fullThumb);
          }

          if (allUrls.length === 0) {
            console.log(`    No images found`);
            continue;
          }

          // Filter junk, sort product shots first, save
          const filtered = filterImageUrls(allUrls, { maxImages: 8 });
          const sorted = sortJohnsonImages(filtered);
          const saved = await saveSkuImages(pool, matched.product_id, matched.sku_id, sorted);
          imagesSaved += saved;
          productsMatched++;
          console.log(`    Saved ${saved} image(s)`);

          await delay(600);
        }
      }
    } finally {
      await browser.close();
      console.log(`  [Browser closed for batch]`);
    }
  }

  console.log(`\n  Phase 2 Complete:`);
  console.log(`    Products matched: ${productsMatched}`);
  console.log(`    Total images saved: ${imagesSaved}`);
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function run() {
  console.log('Johnson Hardwood — Full Scraper\n');

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = $1", [VENDOR_CODE]);
  if (!vendorRes.rows.length) {
    console.error(`Vendor ${VENDOR_CODE} not found`);
    await pool.end();
    return;
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

  await phase1UpsertPdfData(vendorId);
  await phase2ScrapeImages(vendorId);

  console.log('\n══════ Scrape Complete ══════');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
