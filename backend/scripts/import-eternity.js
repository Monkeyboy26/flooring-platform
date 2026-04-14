#!/usr/bin/env node
/**
 * Import Eternity Flooring — Full Catalog
 *
 * Source: Eternity CA Preferred Price List Q1-2026 (effective Jan 5, 2026)
 * Product types: Hybrid Resilient, Rigid Core LVT (SPC), Waterproof Laminate, WPC, Wall Panels
 * Plus: Adhesives, Cork, Underlayment, MDF Base (sundries)
 *
 * ~144 flooring/panel SKUs, ~416 accessory (molding) SKUs, ~23 sundry SKUs
 * Product images fetched from Shopify JSON API (eternityflooring.com)
 *
 * Usage: docker compose exec api node scripts/import-eternity.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const MARKUP = 2.0;

// Category IDs from seed.sql
const CAT = {
  lvp:          '650e8400-e29b-41d4-a716-446655440031',
  laminate:     '650e8400-e29b-41d4-a716-446655440090',
  wallPanel:    '650e8400-e29b-41d4-a716-446655440050',
  sundries:     '650e8400-e29b-41d4-a716-446655440110',
  underlayment: '650e8400-e29b-41d4-a716-446655440112',
  wallBase:     '650e8400-e29b-41d4-a716-446655440115',
  adhesives:    '650e8400-e29b-41d4-a716-446655440111',
};

// ==================== MOLDING DEFINITIONS ====================

const HYBRID_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 25.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 54.99 },
];

const RC_STANDARD_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 28.99 },
  { suffix: 'QTR-ROUND',  name: 'Quarter Round 94"',                  cost: 18.99 },
  { suffix: 'OVERLAP-SN', name: 'Overlap Stairnose 94"',              cost: 38.99 },
  { suffix: 'FLUSH-SN',   name: 'Flush Stairnose 94"',                cost: 51.99 },
];

const RC_SIGNATURE_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 28.99 },
  { suffix: 'QTR-ROUND',  name: 'Quarter Round 94"',                  cost: 18.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 58.99 },
];

const LAM_STANDARD_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 18.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 48.99 },
];

const LAM_SEQUOIA_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 18.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 48.99 },
  { suffix: 'CUSTOM-SN',  name: 'Custom Square Flush Stairnose 70"',  cost: 89.00 },
];

const LAM_HYPERION_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 18.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 48.99 },
  { suffix: 'CUSTOM-SN',  name: 'Custom Square Flush Stairnose 89"',  cost: 109.00 },
];

const WPC_INGRAIND_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 28.99 },
  { suffix: 'FLUSH-SN',   name: 'Flush Stairnose 94"',                cost: 51.99 },
  { suffix: 'SQ-FLUSH-SN', name: 'Square Flush Stairnose 94"',       cost: 58.99 },
];

const WPC_STANDARD_MOLDINGS = [
  { suffix: 'TMOLD',      name: 'T-Mold / Reducer / End Molding 94"', cost: 28.99 },
  { suffix: 'QTR-ROUND',  name: 'Quarter Round 94"',                  cost: 18.99 },
  { suffix: 'OVERLAP-SN', name: 'Overlap Stairnose 94"',              cost: 38.99 },
  { suffix: 'FLUSH-SN',   name: 'Flush Stairnose 94"',                cost: 51.99 },
];

const WORKSHOP_MOLDINGS = [
  { suffix: 'END-MOLD',   name: 'End Molding (2pc/pack) 109"',  cost: 29.99 },
  { suffix: 'COVER-MOLD', name: 'Cover Molding 94.49"',         cost: 29.99 },
  { suffix: 'FLEX-MOLD',  name: 'Flexible Molding 106.3"',      cost: 29.99 },
];

// ==================== COLLECTION DATA ====================

const COLLECTIONS = [
  // --- HYBRID RESILIENT (Made in USA) ---
  {
    name: 'EcoDense', series: 'Hybrid Resilient', category: CAT.lvp,
    thickness: '9mm', width: '9.45"', length: '50.79"', sqftPerBox: 23.33, cost: 2.49,
    wearLayer: 'AC4', padAttached: true, moldings: HYBRID_MOLDINGS,
    shopifyHandle: 'ecodense-made-in-usa-hybrid-resilient-flooring',
    skus: [
      { sku: 'ECO-31001', color: 'Limestone' },
      { sku: 'ECO-31002', color: 'Knox' },
      { sku: 'ECO-31003', color: 'Corsica' },
      { sku: 'ECO-31004', color: 'Sligo' },
      { sku: 'ECO-31005', color: 'Toby' },
      { sku: 'ECO-31006', color: 'Fisher' },
      { sku: 'ECO-31007', color: 'Seneca' },
      { sku: 'ECO-31008', color: 'Millstone' },
    ],
  },

  // --- RIGID CORE LVT ---
  {
    name: 'Megacore', series: 'Rigid Core LVT', category: CAT.lvp,
    thickness: '5.5mm', width: '7"', length: '48"', sqftPerBox: 18.91, cost: 1.69,
    wearLayer: '12mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-mega-core',
    skus: [
      { sku: 'ETMC711XPE', color: 'Cathedral Gray PLUS' },
      { sku: 'ETMC712XPE', color: 'Latte PLUS' },
      { sku: 'ETMC713XPE', color: 'Chestnut PLUS' },
      { sku: 'ETMC714XPE', color: 'Java PLUS' },
      { sku: 'ETMC715XPE', color: 'Pecan PLUS' },
    ],
  },
  {
    name: 'Nordic', series: 'Rigid Core LVT', category: CAT.lvp,
    thickness: '6.5mm', width: '9"', length: '60"', sqftPerBox: 19.25, cost: 2.35,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-nordic',
    skus: [
      { sku: 'ETN720XPE', color: 'Bergen' },
      { sku: 'ETN723XPE', color: 'Sola' },
      { sku: 'ETN725XPE', color: 'Kosta' },
    ],
  },
  {
    name: 'Grand Heritage', series: 'Rigid Core LVT', category: CAT.lvp,
    thickness: '6mm', width: '7"', length: '48"', sqftPerBox: 23.64, cost: 1.85,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-grand-heritage',
    skus: [
      { sku: 'ETG772XPE', color: 'Juniper' },
      { sku: 'ETG775XPE', color: 'Laurel' },
    ],
  },
  {
    name: 'Paladin', series: 'Rigid Core LVT', category: CAT.lvp,
    thickness: '6mm', width: '9"', length: '48"', sqftPerBox: 17.73, cost: 2.05,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-paladin',
    skus: [
      { sku: 'ETPN925XPE', color: 'Ash Oak' },
      { sku: 'ETPN926XPE', color: 'Butterscotch Oak' },
      { sku: 'ETPN927XPE', color: 'Merino Oak' },
      { sku: 'ETPN928XPE', color: 'Scotch Oak' },
    ],
  },

  // --- RIGID CORE LVT - SENTINEL SERIES ---
  {
    name: 'Avant', series: 'Sentinel Series', category: CAT.lvp,
    thickness: '6.5mm', width: '9"', length: '60"', sqftPerBox: 19.25, cost: 2.29,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-avant',
    skus: [
      { sku: 'ETSS905XPE', color: 'Bishop' },
      { sku: 'ETSS906XPE', color: 'Castle' },
      { sku: 'ETSS907XPE', color: 'Crest' },
      { sku: 'ETSS908XPE', color: 'Lance' },
    ],
  },
  {
    name: 'Paramount', series: 'Sentinel Series', category: CAT.lvp,
    thickness: '6.5mm', width: '9"', length: '60"', sqftPerBox: 19.25, cost: 2.29,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-paramount',
    skus: [
      { sku: 'ETSS901XPE', color: 'Cameo' },
      { sku: 'ETSS902XPE', color: 'Medallion' },
      { sku: 'ETSS903XPE', color: 'Pendant' },
      { sku: 'ETSS904XPE', color: 'Rosette' },
    ],
  },
  {
    name: 'Valiant', series: 'Sentinel Series', category: CAT.lvp,
    thickness: '6.5mm', width: '9"', length: '60"', sqftPerBox: 18.43, cost: 2.29,
    wearLayer: '20mil', padAttached: true, moldings: RC_STANDARD_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-valiant',
    skus: [
      { sku: 'ETSS911XPE', color: 'Cobblestone' },
      { sku: 'ETSS912XPE', color: 'Emblem' },
      { sku: 'ETSS913XPE', color: 'Haven' },
      { sku: 'ETSS914XPE', color: 'Labyrinth' },
      { sku: 'ETSS915XPE', color: 'Prism' },
      { sku: 'ETSS916XPE', color: 'Trellis' },
    ],
  },

  // --- RIGID CORE LVT - SIGNATURE SERIES ---
  {
    name: 'Ready+Lock+Go', series: 'Signature Series', category: CAT.lvp,
    thickness: '6mm', width: '7"', length: '48"', sqftPerBox: 23.64, cost: 1.85,
    wearLayer: '20mil', padAttached: true, moldings: RC_SIGNATURE_MOLDINGS,
    shopifyHandle: 'rigid-core-spc-ready-lock-go',
    skus: [
      { sku: 'RLG-BO721',  color: 'Brumous Oak' },
      { sku: 'RLG-BO735',  color: 'Bianca Oak' },
      { sku: 'RLG-EG727',  color: 'Elegant Greige' },
      { sku: 'RLG-EO728',  color: 'English Oak' },
      { sku: 'RLG-GO720',  color: 'Grandeur Oak' },
      { sku: 'RLG-GWO731', color: 'Gris Washed Oak' },
      { sku: 'RLG-MI723',  color: 'Moderna Ivory' },
      { sku: 'RLG-NO730',  color: 'Nouveau Oak' },
      { sku: 'RLG-RO729',  color: 'Renaissance Oak' },
      { sku: 'RLG-SWO722', color: 'Sun Washed Oak' },
      { sku: 'RLG-TO736',  color: 'Tacoma Oak' },
      { sku: 'RLG-VO725',  color: 'Venetian Oak' },
    ],
  },

  // --- WATERPROOF PERFORMANCE LAMINATE ---
  {
    name: 'Santiago XL', series: 'Waterproof Laminate', category: CAT.laminate,
    thickness: '10mm', width: '9.6"', length: '70"', sqftPerBox: 18.85, cost: 2.69,
    wearLayer: 'AC6', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-santiago-xl',
    skus: [
      { sku: 'SA23102', color: 'Blanca' },
      { sku: 'SA23103', color: 'Solana' },
      { sku: 'SA23104', color: 'Ciela' },
      { sku: 'SA23105', color: 'Alba' },
      { sku: 'SA23109', color: 'Ines' },
      { sku: 'SA23111', color: 'Mariposa' },
      { sku: 'SA23112', color: 'Arlo' },
      { sku: 'SA23115', color: 'Maya' },
    ],
  },
  {
    name: 'Sequoia XL', series: 'Waterproof Laminate', category: CAT.laminate,
    thickness: '10mm', width: '9.6"', length: '70"', sqftPerBox: 18.85, cost: 2.99,
    wearLayer: 'AC6', padAttached: false, moldings: LAM_SEQUOIA_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-sequoia-xl-made-in-spain',
    skus: [
      { sku: 'SE72010', color: 'Cliff Creek' },
      { sku: 'SE72011', color: 'Timber Gap' },
      { sku: 'SE72012', color: 'Mineral Peak' },
      { sku: 'SE72013', color: 'Empire' },
      { sku: 'SE72014', color: 'Eagle Scout' },
      { sku: 'SE72017', color: 'Alta Sierra' },
      { sku: 'SE72018', color: 'Spring Lakes' },
      { sku: 'SE72019', color: 'Florence Peak' },
    ],
  },
  {
    name: 'Voila 5G', series: 'Waterproof Laminate', category: CAT.laminate,
    thickness: '10mm', width: '8.43"', length: '50.62"', sqftPerBox: 20.77, cost: 2.39,
    wearLayer: 'AC6', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-voila-5g-made-in-france',
    skus: [
      { sku: 'ET-FR301', color: 'Caramel Oak' },
      { sku: 'ET-FR302', color: 'Sirocco Oak' },
      { sku: 'ET-FR303', color: 'Ontario Oak' },
      { sku: 'ET-FR304', color: 'Lady Oak' },
      { sku: 'ET-FR305', color: 'Western Oak' },
      { sku: 'ET-FR306', color: 'Ivory Oak' },
      { sku: 'ET-FR307', color: 'Spenser Oak' },
      { sku: 'ET-FR308', color: 'Castanea' },
      { sku: 'ET-FR309', color: 'Montana Hickory' },
      { sku: 'ET-FR310', color: 'Yellowstone Hickory' },
      { sku: 'ET-FR311', color: 'Molly' },
      { sku: 'ET-FR312', color: 'White Bastide' },
    ],
  },
  {
    name: 'Hyperion XXL', series: 'Waterproof Laminate', category: CAT.laminate,
    thickness: '12mm', width: '9.25"', length: 'Random', sqftPerBox: 22.92, cost: 2.35,
    wearLayer: 'AC4', padAttached: false, moldings: LAM_HYPERION_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-hyperion-xxl',
    skus: [
      { sku: 'ETXXL01', color: 'Sherman' },
      { sku: 'ETXXL02', color: 'Monroe' },
      { sku: 'ETXXL03', color: 'Pershing' },
      { sku: 'ETXXL04', color: 'Stagg' },
      { sku: 'ETXXL05', color: 'Boole' },
      { sku: 'ETXXL06', color: 'Euclid' },
      { sku: 'ETXXL07', color: 'Nelder' },
      { sku: 'ETXXL08', color: 'Arthur' },
    ],
  },

  // --- AQUAFI US SERIES (Made in USA) ---
  {
    name: "America's Choice", series: 'AquaFi US', category: CAT.laminate,
    thickness: '10mm', width: '8"', length: '48"', sqftPerBox: 18.6, cost: 1.99,
    wearLayer: 'AC4', padAttached: true, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-aquafi-usa',
    skus: [
      { sku: 'ETUS-LI22080', color: 'Oakmont' },
      { sku: 'ETUS-LI22083', color: 'Sawgrass' },
    ],
  },
  {
    name: 'American Select', series: 'AquaFi US', category: CAT.laminate,
    thickness: '12mm', width: '8"', length: '48"', sqftPerBox: 15.94, cost: 2.35,
    wearLayer: 'AC4', padAttached: true, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-aquafi-usa',
    skus: [
      { sku: 'ETUS-LI22001', color: 'Streamsong' },
      { sku: 'ETUS-LI22002', color: 'Bandon' },
      { sku: 'ETUS-LI22003', color: 'Pinehurst' },
      { sku: 'ETUS-LI22004', color: 'Greenbrier' },
    ],
  },
  {
    name: 'Americana', series: 'AquaFi US', category: CAT.laminate,
    thickness: '12mm', width: '8"', length: '48"', sqftPerBox: 15.94, cost: 2.35,
    wearLayer: 'AC4', padAttached: true, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-aquafi-usa',
    skus: [
      { sku: 'ETUS-LI22010', color: 'Broadmoor' },
      { sku: 'ETUS-LI22011', color: 'Merion' },
      { sku: 'ETUS-LI22012', color: 'Cabot' },
      { sku: 'ETUS-LI22013', color: 'Sagamore' },
    ],
  },
  {
    name: 'Revolution', series: 'AquaFi US', category: CAT.laminate,
    thickness: '12mm', width: '8"', length: '48"', sqftPerBox: 15.94, cost: 2.35,
    wearLayer: 'AC4', padAttached: true, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-aquafi-usa',
    skus: [
      { sku: 'ETUS-LI22020', color: 'Somerset' },
      { sku: 'ETUS-LI22021', color: 'Kingsley' },
    ],
  },

  // --- PROOF SERIES ---
  {
    name: 'Allure', series: 'Proof Series', category: CAT.laminate,
    thickness: '10mm', width: '9"', length: '48"', sqftPerBox: 24.8, cost: 1.85,
    wearLayer: 'AC4', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-proof-10mm',
    skus: [
      { sku: 'ETPF40', color: 'Siena' },
      { sku: 'ETPF41', color: 'Nova' },
      { sku: 'ETPF42', color: 'Ariya' },
      { sku: 'ETPF43', color: 'Luna' },
    ],
  },
  {
    name: 'Villa', series: 'Proof Series', category: CAT.laminate,
    thickness: '10mm', width: '9"', length: '60"', sqftPerBox: 30.66, cost: 1.95,
    wearLayer: 'AC4', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-proof-10mm',
    skus: [
      { sku: 'ETPF30', color: 'Savannah' },
      { sku: 'ETPF31', color: 'Chesapeake' },
      { sku: 'ETPF32', color: 'Camden' },
      { sku: 'ETPF33', color: 'Calistoga' },
      { sku: 'ETPF34', color: 'Stowe' },
      { sku: 'ETPF35', color: 'Kohler' },
      { sku: 'ETPF36', color: 'Hudson' },
      { sku: 'ETPF37', color: 'Beaufort' },
    ],
  },

  // --- PROOF XL SERIES ---
  {
    name: 'Natura', series: 'Proof XL Series', category: CAT.laminate,
    thickness: '10mm', width: '9"', length: '72.5"', sqftPerBox: 28, cost: 2.05,
    wearLayer: 'AC4', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'waterproof-performance-laminate-proof-xl-10mm',
    skus: [
      { sku: 'ETPXL613', color: 'Bliss' },
      { sku: 'ETPXL614', color: 'Dawn' },
      { sku: 'ETPXL615', color: 'Cashmere' },
      { sku: 'ETPXL616', color: 'Bode' },
      { sku: 'ETPXL617', color: 'Ash Oak' },
      { sku: 'ETPXL618', color: 'Willow' },
      { sku: 'ETPXL619', color: 'Breeze' },
      { sku: 'ETPXL620', color: 'Whisper' },
      { sku: 'ETPXL621', color: 'Mellow' },
      { sku: 'ETPXL622', color: 'Coral' },
      { sku: 'ETPXL623', color: 'Mist' },
      { sku: 'ETPXL624', color: 'Blush' },
    ],
  },
  {
    name: 'Speakeasy', series: 'Proof XL Series', category: CAT.laminate,
    thickness: '12mm', width: '9"', length: '72"', sqftPerBox: 23.34, cost: 2.19,
    wearLayer: 'AC4', padAttached: false, moldings: LAM_STANDARD_MOLDINGS,
    shopifyHandle: 'proof-xl-12mm-waterproof-performance-laminate',
    skus: [
      { sku: 'ETPXL101', color: 'Campari' },
      { sku: 'ETPXL102', color: 'Monarch' },
      { sku: 'ETPXL103', color: 'Aperol' },
      { sku: 'ETPXL104', color: 'Bijou' },
      { sku: 'ETPXL105', color: 'Vesper' },
      { sku: 'ETPXL106', color: 'Reviver' },
      { sku: 'ETPXL107', color: 'Manhattan' },
      { sku: 'ETPXL108', color: 'Bellini' },
      { sku: 'ETPXL109', color: 'Sazerac' },
      { sku: 'ETPXL110', color: 'Old Fashioned' },
      { sku: 'ETPXL111', color: 'Amaretto' },
      { sku: 'ETPXL112', color: 'Boulevardier' },
    ],
  },

  // --- WPC ---
  {
    name: "Ingrain'd", series: 'WPC', category: CAT.lvp,
    thickness: '10mm', width: '9"', length: '72"', sqftPerBox: 17.76, cost: 3.19,
    wearLayer: '28mil', padAttached: true, moldings: WPC_INGRAIND_MOLDINGS,
    shopifyHandle: 'waterproof-performance-vinyl-flooring-ingraind',
    skus: [
      { sku: 'ETID81', color: 'Espresso Foam' },
      { sku: 'ETID82', color: 'Dulce Beige' },
      { sku: 'ETID83', color: 'Mocha Mousse' },
      { sku: 'ETID84', color: 'Sunset Mist' },
      { sku: 'ETID85', color: 'Toasted Almond' },
      { sku: 'ETID86', color: 'Toffee Dust' },
      { sku: 'ETID87', color: 'Caramel Cream' },
      { sku: 'ETID88', color: 'Macadamia' },
      { sku: 'ETID89', color: 'Grove' },
      { sku: 'ETID90', color: 'Chateau' },
      { sku: 'ETID91', color: 'Promenade' },
      { sku: 'ETID92', color: 'Paseo' },
    ],
  },
  {
    name: 'Brilliance', series: 'WPC', category: CAT.lvp,
    thickness: '7mm', width: '8.75"', length: '60"', sqftPerBox: 21.94, cost: 2.35,
    wearLayer: '20mil', padAttached: false, moldings: WPC_STANDARD_MOLDINGS,
    shopifyHandle: 'brilliance-wpc',
    skus: [
      { sku: 'ET524', color: 'Granada' },
    ],
  },
  {
    name: 'Infinity', series: 'WPC', category: CAT.lvp,
    thickness: '7mm', width: '8.75"', length: '48"', sqftPerBox: 23.82, cost: 2.35,
    wearLayer: '20mil', padAttached: false, moldings: WPC_STANDARD_MOLDINGS,
    shopifyHandle: 'infinity-wpc',
    skus: [
      { sku: 'ET318', color: 'Candlewood' },
    ],
  },

  // --- WALL PANELS (Made in Europe) ---
  {
    name: 'Workshop', series: 'Wall Panels', category: CAT.wallPanel,
    thickness: '20mm', width: '11.81"', length: '109.06"', sqftPerBox: 17.89, cost: 7.99,
    wearLayer: null, padAttached: false, moldings: WORKSHOP_MOLDINGS,
    shopifyHandle: 'wall-decor-panels-workshop-collection',
    skus: [
      { sku: 'WS-40101', color: 'Pepper Oak on Pepper Oak' },
      { sku: 'WS-40102', color: 'Pepper Oak on Black' },
      { sku: 'WS-40103', color: 'Pepper Oak on White' },
      { sku: 'WS-40104', color: 'Castle Oak on Black' },
      { sku: 'WS-40105', color: 'White on White (Paintable)' },
      { sku: 'WS-40106', color: 'Matte Black on Matte Black' },
      { sku: 'WS-40107', color: 'Matte Black on Bronze' },
      { sku: 'WS-40108', color: 'Castle Oak on Bronze' },
    ],
  },
];

// ==================== SUNDRIES (standalone products) ====================

const SUNDRIES = [
  // Adhesives
  { sku: 'K-4',              name: 'Duvall Cork Adhesive (4 gal)',               category: CAT.adhesives,    cost: 65.00,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'CONST-ADH',        name: 'Sika Construction Adhesive Tube (10oz)',     category: CAT.adhesives,    cost: 7.99,   sellBy: 'unit', priceBasis: 'per_unit' },
  // Cork Underlayment (price per sqft)
  { sku: 'CR-108 HALF',      name: 'Acoustic Silent Cork 1/2" (2x3 sheets)',     category: CAT.underlayment, cost: 2.09,   sellBy: 'sqft', priceBasis: 'per_sqft', sqftPerBox: 150 },
  { sku: 'CR-108 QUARTER',   name: 'Acoustic Silent Cork 1/4" (2x3 sheets)',     category: CAT.underlayment, cost: 1.05,   sellBy: 'sqft', priceBasis: 'per_sqft', sqftPerBox: 300 },
  // Underlayment Rolls (price per roll)
  { sku: 'EVA',              name: 'Acoustical Ultra EVA 3mm (200 sqft/roll)',    category: CAT.underlayment, cost: 36.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 200 },
  { sku: 'EVP1.5MMPLUS',     name: 'VersaPro EVP PLUS 1.5mm (200 sqft/roll)',    category: CAT.underlayment, cost: 34.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 200 },
  { sku: 'FOAMB2MM',         name: 'Foam Blue 2mm (200 sqft/roll)',              category: CAT.underlayment, cost: 14.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 200 },
  { sku: 'FOAMS3MM',         name: 'Foam Silver 3mm (200 sqft/roll)',            category: CAT.underlayment, cost: 20.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 200 },
  { sku: 'PEFFR',            name: 'P.E. Foam Filler Rod (25 ft)',              category: CAT.sundries,     cost: 3.99,   sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'RUBBER',           name: 'Enhancer Acoustical Rubber 2mm (100 sqft)',  category: CAT.underlayment, cost: 38.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 100 },
  { sku: 'VDPE',             name: '6MIL Vapor Barrier (500 sqft/roll)',         category: CAT.underlayment, cost: 42.00,  sellBy: 'unit', priceBasis: 'per_unit', sqftPerBox: 500 },
  // MDF Base (price per LF × 16 = per piece cost)
  { sku: 'MDF206A',  name: 'R.E. Base 5-1/2" (16 LF)',         category: CAT.wallBase, cost: 10.72, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF20A',   name: 'Victorian Base 3-7/8" (16 LF)',    category: CAT.wallBase, cost: 9.92,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF221A',  name: 'Coronado Base 3-1/4" (16 LF)',     category: CAT.wallBase, cost: 8.96,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF222A',  name: 'Coronado Base 4-1/4" (16 LF)',     category: CAT.wallBase, cost: 10.08, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF223A',  name: 'Coronado Base 5-1/4" (16 LF)',     category: CAT.wallBase, cost: 12.00, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF22A',   name: 'Victorian Base 5" (16 LF)',        category: CAT.wallBase, cost: 11.68, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF410A',  name: '711 Base 3-1/2" (16 LF)',          category: CAT.wallBase, cost: 7.84,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF830A',  name: '1 R.E. Base 3-1/2" (16 LF)',       category: CAT.wallBase, cost: 8.64,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF831A',  name: '1 RE Base 4-1/2" (16 LF)',         category: CAT.wallBase, cost: 10.24, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'MDF83A',   name: 'Victorian Base 4" (16 LF)',        category: CAT.wallBase, cost: 11.04, sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'P226PR',   name: 'Primed Base Shoe 1/2" x 3/4" (16 LF)',   category: CAT.wallBase, cost: 4.48,  sellBy: 'unit', priceBasis: 'per_unit' },
  { sku: 'P332PR',   name: 'Primed Quarter Round 3/4" x 3/4" (16 LF)', category: CAT.wallBase, cost: 6.08,  sellBy: 'unit', priceBasis: 'per_unit' },
];

// ==================== IMAGE FETCHING ====================

function normalizeSku(sku) {
  return sku.toLowerCase().replace(/-/g, '').replace(/xpe$/, '');
}

async function fetchImages() {
  const imageMap = new Map();
  const handles = [...new Set(COLLECTIONS.map(c => c.shopifyHandle))];

  console.log('Fetching product images from eternityflooring.com...');

  for (const handle of handles) {
    try {
      const url = `https://eternityflooring.com/products/${handle}.json`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  [SKIP] ${handle}: ${res.status}`); continue; }
      const { product } = await res.json();

      const imgById = new Map();
      for (const img of product.images || []) imgById.set(img.id, img.src);

      let matched = 0;
      for (const variant of product.variants || []) {
        if (!variant.sku) continue;
        const key = normalizeSku(variant.sku);
        const imageUrl = variant.image_id ? imgById.get(variant.image_id) : null;
        if (imageUrl) { imageMap.set(key, imageUrl); matched++; }
      }

      console.log(`  ${handle}: ${matched}/${product.variants?.length || 0} images`);
    } catch (err) {
      console.warn(`  [WARN] ${handle}: ${err.message}`);
    }
  }

  return imageMap;
}

// ==================== DB UPSERT HELPERS ====================

async function upsertVendor(name, code, website) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, website) VALUES ($1, $2, $3)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
    RETURNING id
  `, [name, code, website]);
  return res.rows[0].id;
}

async function upsertProduct(vendorId, { name, collection, categoryId, descriptionShort }) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, description_short)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
    DO UPDATE SET category_id = EXCLUDED.category_id,
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, name, collection, categoryId, descriptionShort || null]);
  return res.rows[0];
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType }) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = EXCLUDED.sell_by, variant_type = EXCLUDED.variant_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName, sellBy, variantType || null]);
  return res.rows[0];
}

async function upsertPricing(skuId, { cost, retailPrice, priceBasis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retailPrice, priceBasis]);
}

async function upsertPackaging(skuId, sqftPerBox) {
  if (!sqftPerBox) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1, $2)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box
  `, [skuId, sqftPerBox]);
}

async function upsertAttribute(skuId, slug, value) {
  if (!value) return;
  const attrRes = await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [slug]);
  if (!attrRes.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrRes.rows[0].id, value]);
}

async function upsertMediaAsset(productId, skuId, url) {
  if (!url) return;
  if (skuId) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, 'primary', $3, $3, 0) ON CONFLICT DO NOTHING
    `, [productId, skuId, url]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
      VALUES ($1, 'primary', $2, $2, 0) ON CONFLICT DO NOTHING
    `, [productId, url]);
  }
}

// ==================== MAIN ====================

async function main() {
  console.log('=== Eternity Flooring Import ===\n');

  // 1. Fetch images
  const imageMap = await fetchImages();
  console.log(`\nLoaded ${imageMap.size} product images\n`);

  // 2. Create vendor
  const vendorId = await upsertVendor('Eternity Flooring', 'ETERNITY', 'https://eternityflooring.com');
  console.log(`Vendor ID: ${vendorId}\n`);

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;
  let accessoriesCreated = 0;
  let imagesLinked = 0;

  // 3. Import flooring collections
  for (const col of COLLECTIONS) {
    for (const item of col.skus) {
      // Create product (one per color)
      const prod = await upsertProduct(vendorId, {
        name: item.color,
        collection: col.name,
        categoryId: col.category,
        descriptionShort: `${col.name} - ${item.color}`,
      });
      if (prod.is_new) productsCreated++; else productsUpdated++;

      // Create main flooring SKU
      const sku = await upsertSku(prod.id, {
        vendorSku: item.sku,
        internalSku: `ET-${item.sku}`,
        variantName: item.color,
        sellBy: 'sqft',
        variantType: null,
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      // Pricing
      const retail = parseFloat((col.cost * MARKUP).toFixed(2));
      await upsertPricing(sku.id, { cost: col.cost, retailPrice: retail, priceBasis: 'per_sqft' });

      // Packaging
      await upsertPackaging(sku.id, col.sqftPerBox);

      // Attributes
      await upsertAttribute(sku.id, 'color', item.color);
      await upsertAttribute(sku.id, 'thickness', col.thickness);
      await upsertAttribute(sku.id, 'width', col.width);
      await upsertAttribute(sku.id, 'collection', col.name);
      if (col.wearLayer) await upsertAttribute(sku.id, 'wear_layer', col.wearLayer);
      await upsertAttribute(sku.id, 'installation', 'Float / Click-lock');

      // Image
      const normalKey = normalizeSku(item.sku);
      const imageUrl = imageMap.get(normalKey);
      if (imageUrl) {
        await upsertMediaAsset(prod.id, sku.id, imageUrl);
        imagesLinked++;
      }

      // Product-level image
      if (imageUrl) await upsertMediaAsset(prod.id, null, imageUrl);

      // Molding accessories (same product_id, variant_type='accessory')
      for (const mold of col.moldings) {
        const accSku = await upsertSku(prod.id, {
          vendorSku: `${item.sku}-${mold.suffix}`,
          internalSku: `ET-${item.sku}-${mold.suffix}`,
          variantName: mold.name,
          sellBy: 'unit',
          variantType: 'accessory',
        });
        if (accSku.is_new) accessoriesCreated++;

        const accRetail = parseFloat((mold.cost * MARKUP).toFixed(2));
        await upsertPricing(accSku.id, { cost: mold.cost, retailPrice: accRetail, priceBasis: 'per_unit' });
      }
    }

    const moldCount = col.skus.length * col.moldings.length;
    console.log(`  ${col.name}: ${col.skus.length} colors + ${moldCount} accessories`);
  }

  // 4. Import sundries
  console.log('\n  --- Sundries ---');
  let sundriesCreated = 0;

  for (const s of SUNDRIES) {
    const prod = await upsertProduct(vendorId, {
      name: s.name,
      collection: 'Sundries',
      categoryId: s.category,
      descriptionShort: s.name,
    });

    const sku = await upsertSku(prod.id, {
      vendorSku: s.sku,
      internalSku: `ET-${s.sku}`,
      variantName: s.name,
      sellBy: s.sellBy,
      variantType: null,
    });

    const retail = parseFloat((s.cost * MARKUP).toFixed(2));
    await upsertPricing(sku.id, { cost: s.cost, retailPrice: retail, priceBasis: s.priceBasis });

    if (s.sqftPerBox) await upsertPackaging(sku.id, s.sqftPerBox);

    if (sku.is_new) sundriesCreated++;
  }
  console.log(`  Sundries: ${sundriesCreated} created`);

  // Summary
  console.log('\n=== Import Complete ===');
  console.log(`Flooring products created: ${productsCreated}`);
  console.log(`Flooring products updated: ${productsUpdated}`);
  console.log(`Flooring SKUs created: ${skusCreated}`);
  console.log(`Flooring SKUs updated: ${skusUpdated}`);
  console.log(`Accessory SKUs created: ${accessoriesCreated}`);
  console.log(`Sundry products created: ${sundriesCreated}`);
  console.log(`Images linked: ${imagesLinked}`);
  console.log(`Total SKUs: ${skusCreated + skusUpdated + accessoriesCreated + sundriesCreated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
