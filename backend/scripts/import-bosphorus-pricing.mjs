/**
 * Import Bosphorus Tier 1 wholesale pricing from PDF data.
 * Run: docker compose exec api node scripts/import-bosphorus-pricing.mjs
 *
 * Sets cost = PDF wholesale price, retail_price = cost × 2 (matching other vendors' markup).
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_ID = '2687294d-fff3-49bf-8165-db0cbd3bbd54';
const RETAIL_MARKUP = 1.6; // retail_price = cost × 1.6

// ── Collection name aliases: PDF name (lowered) → DB name (lowered) ──
const COLLECTION_ALIASES = {
  'bioconcrete':       'bio concrete',
  'norgestone':        'norge stone',
  'norgestone paver':  'norge stone paver',
  'solid color':       'solid',
  'element':           'element hexagon',
  're-style':          're style',
  'pietre':            'pietra pure',
  'arte marmo':        'arte marmo grey',
};

// ── Pricing data extracted from Bosphorus Tier 1 PDF (all 47 series pages) ──
const PRICING_DATA = [
  // p6 - ARGILE
  { collection: 'Argile', finishes: [
    { finish: 'Matte', sizes: [
      { size: '4x4', price: 4.91, basis: 'per_sqft' },
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '2.5x10', price: 5.36, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Jolly Liner Matte', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // p7 - CRAYON
  { collection: 'Crayon', finishes: [
    { finish: 'Matte', sizes: [
      { size: '2.5x5', price: 5.56, basis: 'per_sqft' },
      { size: '3/4x5', price: 5.56, basis: 'per_sqft' },
      { size: '5x5', price: 5.56, basis: 'per_sqft' },
      { size: '3x12', price: 5.56, basis: 'per_sqft' },
      { size: '6x24', price: 5.56, basis: 'per_sqft' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Glossy', sizes: [
      { size: '2.5x5', price: 5.56, basis: 'per_sqft' },
      { size: '3/4x5', price: 5.56, basis: 'per_sqft' },
      { size: '5x5', price: 5.56, basis: 'per_sqft' },
    ]},
  ]},
  // p8 - ACANTO
  { collection: 'Acanto', finishes: [
    { finish: 'Matte', sizes: [
      { size: '8x48', price: 5.56, basis: 'per_sqft' },
    ]},
  ]},
  // p9 - ARENITE
  { collection: 'Arenite', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
    { finish: '3D Satin', sizes: [
      { size: '24x48', price: 6.53, basis: 'per_sqft' },
    ]},
  ]},
  // p10 - BEYOND
  { collection: 'Beyond', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.86, basis: 'per_sqft' },
      { size: '20x48', price: 6.03, basis: 'per_sqft' },
      { size: '24x48', price: 6.03, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p13 - BOOST STONE
  { collection: 'Boost Stone', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
    ]},
    { finish: '3D Satin', sizes: [
      { size: '24x48', price: 6.53, basis: 'per_sqft' },
    ]},
    { finish: 'Structured', sizes: [
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p14 - CALYPSO (PDF says "Polished", DB has "Matte" — fallback matching)
  { collection: 'Calypso', finishes: [
    { finish: 'Polished', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
  ]},
  // p15 - CASTELLO
  { collection: 'Castello', finishes: [
    { finish: 'Matte', sizes: [
      { size: '8x48', price: 3.47, basis: 'per_sqft' },
      { size: '12x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x48', price: 4.28, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Deco Matte', sizes: [
      { size: '24x24', price: 3.47, basis: 'per_sqft' },
    ]},
  ]},
  // p17 - COTTO FRESCO
  { collection: 'Cotto Fresco', finishes: [
    { finish: 'Matte', sizes: [
      { size: '2.5x2.5', price: 18.00, basis: 'per_sqft' },
      { size: '5x10', price: 5.31, basis: 'per_sqft' },
      { size: '2.5x10', price: 5.36, basis: 'per_sqft' },
      { size: '10x10', price: 5.31, basis: 'per_sqft' },
      { size: '20x20', price: 5.31, basis: 'per_sqft' },
    ]},
  ]},
  // p18 - CURIOUSITY
  { collection: 'Curiousity', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.86, basis: 'per_sqft' },
      { size: '24x48', price: 6.03, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p19 - DUPLOSTONE
  { collection: 'Duplostone', finishes: [
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '12x24', price: 1.79, basis: 'per_sqft' },
      { size: '24x48', price: 1.79, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p20 - FORMA
  { collection: 'Forma', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x24', price: 5.22, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
    { finish: '3D Satin', sizes: [
      { size: '24x48', price: 6.53, basis: 'per_sqft' },
    ]},
  ]},
  // p21 - HOLBOX
  { collection: 'Holbox', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 3.60, basis: 'per_sqft' },
      { size: '24x48', price: 4.14, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
      { size: '48x48', price: 4.86, basis: 'per_sqft' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p22 - ICONICA
  { collection: 'Iconica', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p23 - LIMESTONE
  { collection: 'Limestone', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.95, basis: 'per_sqft' },
      { size: '24x48', price: 5.76, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
    { finish: 'Riga Textured', sizes: [
      { size: '24x48', price: 6.53, basis: 'per_sqft' },
    ]},
  ]},
  // p24 - MEA LAPIS
  { collection: 'Mea Lapis', finishes: [
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '12x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x48', price: 4.28, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Natural', sizes: [
      { size: '12x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x48', price: 4.28, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p25 - NORGESTONE
  { collection: 'Norgestone', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Textured', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p26 - SILVERLAKE
  { collection: 'Silverlake', finishes: [
    { finish: 'Natural', sizes: [
      { size: '12x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x48', price: 4.28, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '12x24', price: 3.47, basis: 'per_sqft' },
      { size: '24x48', price: 4.28, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p27 - VESTA
  { collection: 'Vesta', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.86, basis: 'per_sqft' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
  ]},
  // p28 - SOLID COLOR
  { collection: 'Solid Color', finishes: [
    { finish: 'Polished', sizes: [
      { size: '3x24', price: 8.10, basis: 'per_unit' },
      { size: '24x24', price: 1.79, basis: 'per_sqft' },
      { size: '2x2', price: 8.10, basis: 'per_unit' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 8.10, basis: 'per_unit' },
      { size: '24x24', price: 1.79, basis: 'per_sqft' },
      { size: '2x2', price: 8.10, basis: 'per_unit' },
      { size: '12x24', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // p29 - ARROW
  { collection: 'Arrow', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '2x10', price: 5.31, basis: 'per_sqft' },
    ]},
  ]},
  // p30 - NORGESTONE PAVER
  { collection: 'Norgestone Paver', finishes: [
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '24x24', price: 6.12, basis: 'per_sqft' },
    ]},
  ]},
  // p31 - PIETRE → DB "Pietra Pure"
  { collection: 'Pietre', finishes: [
    { finish: 'Slip-Resistant R11', sizes: [
      { size: '24x24', price: 5.22, basis: 'per_sqft' },
    ]},
  ]},
  // p32 - FRAMMENTI
  { collection: 'Frammenti', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x12', price: 41.90, basis: 'per_unit' },
    ]},
  ]},
  // p33 - REFLET
  { collection: 'Reflet', finishes: [
    { finish: 'Polished', sizes: [
      { size: '8x24', price: 65.75, basis: 'per_sqft' },
      { size: '1x1', price: 89.10, basis: 'per_unit' },
    ]},
  ]},
  // p34 - ARTE MARMO → DB "Arte Marmo Grey"
  { collection: 'Arte Marmo', finishes: [
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // p35 - BOUTIQUE
  { collection: 'Boutique', finishes: [
    { finish: 'Polished', sizes: [
      { size: '2x2', price: 20.03, basis: 'per_unit' },
    ]},
  ]},
  // p35 - CERAMICA DI CARRARA (finish includes style prefix to match DB)
  { collection: 'Ceramica Di Carrara', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '3x6', price: 1.79, basis: 'per_sqft' },
      { size: '3x12', price: 1.79, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '3x6', price: 1.79, basis: 'per_sqft' },
      { size: '3x12', price: 1.79, basis: 'per_sqft' },
    ]},
    { finish: 'London Chair Rail Glossy', sizes: [
      { size: '2x6', price: 4.05, basis: 'per_unit' },
    ]},
    { finish: 'London Chair Rail Matte', sizes: [
      { size: '2x6', price: 4.05, basis: 'per_unit' },
    ]},
    { finish: 'Quarter Round Glossy', sizes: [
      { size: '1x6', price: 4.46, basis: 'per_unit' },
    ]},
    { finish: 'Quarter Round Matte', sizes: [
      { size: '1x6', price: 4.46, basis: 'per_unit' },
    ]},
    { finish: 'Deep Beveled Glossy', sizes: [
      { size: '3x6', price: 1.79, basis: 'per_sqft' },
      { size: '3x12', price: 1.79, basis: 'per_sqft' },
    ]},
    { finish: 'Deep Beveled Matte', sizes: [
      { size: '3x6', price: 1.79, basis: 'per_sqft' },
      { size: '3x12', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // p36 - DELIGHT
  { collection: 'Delight', finishes: [
    { finish: 'Matte', sizes: [
      { size: '3x36', price: 21.56, basis: 'per_unit' },
      { size: '36x36', price: 5.99, basis: 'per_sqft' },
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '24x48', price: 5.76, basis: 'per_sqft' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '48x48', price: 6.39, basis: 'per_sqft' },
    ]},
    { finish: 'Polished', sizes: [
      { size: '3x36', price: 21.56, basis: 'per_unit' },
      { size: '36x36', price: 7.11, basis: 'per_sqft' },
      { size: '12x24', price: 6.12, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '24x48', price: 7.34, basis: 'per_sqft' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '48x48', price: 7.38, basis: 'per_sqft' },
    ]},
  ]},
  // p37 - DUALITY
  { collection: 'Duality', finishes: [
    { finish: 'Polished', sizes: [
      { size: '12x24', price: 1.99, basis: 'per_sqft' },
      { size: '24x48', price: 2.30, basis: 'per_sqft' },
      { size: '48x48', price: 2.69, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 1.99, basis: 'per_sqft' },
      { size: '24x48', price: 2.30, basis: 'per_sqft' },
      { size: '48x48', price: 2.69, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
  ]},
  // p38 - FLUTED DELIGHT
  { collection: 'Fluted Delight', finishes: [
    { finish: 'Standard', sizes: [
      { size: '2x16', price: 8.33, basis: 'per_sqft' },
    ]},
  ]},
  // p39 - FOYER
  { collection: 'Foyer', finishes: [
    { finish: 'Polished', sizes: [
      { size: '48x48', price: 7.97, basis: 'per_sqft' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 7.43, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 6.17, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '48x48', price: 6.75, basis: 'per_sqft' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 5.81, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 4.82, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
  ]},
  // p40 - GEO
  { collection: 'Geo', finishes: [
    { finish: 'Polished', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '24x48', price: 4.55, basis: 'per_sqft' },
      { size: '12x24', price: 3.96, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '24x48', price: 4.14, basis: 'per_sqft' },
      { size: '12x24', price: 3.60, basis: 'per_sqft' },
    ]},
  ]},
  // p41 - GOLDEN PURE
  { collection: 'Golden Pure', finishes: [
    { finish: 'Polished', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 5.04, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 4.28, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 3.87, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 3.15, basis: 'per_sqft' },
    ]},
  ]},
  // p42 - PIETRA (marble look, Matte + Polished)
  { collection: 'Pietra', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 3.60, basis: 'per_sqft' },
      { size: '24x48', price: 4.14, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
    ]},
    { finish: 'Polished', sizes: [
      { size: '12x24', price: 3.96, basis: 'per_sqft' },
      { size: '24x48', price: 4.55, basis: 'per_sqft' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
    ]},
  ]},
  // p43 - SOAPSTONE
  { collection: 'Soapstone', finishes: [
    { finish: 'Polished', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 4.95, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 4.32, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 4.50, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 3.92, basis: 'per_sqft' },
    ]},
  ]},
  // p44 - GRAVEL
  { collection: 'Gravel', finishes: [
    { finish: 'Matte', sizes: [
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '24x48', price: 3.24, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '12x24', price: 2.88, basis: 'per_sqft' },
    ]},
  ]},
  // p45 - ELEMENT → DB "Element Hexagon"
  { collection: 'Element', finishes: [
    { finish: 'Standard', sizes: [
      { size: '9x10', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // p46 - PORCELLANA DI CARRARA
  { collection: 'Porcellana Di Carrara', finishes: [
    { finish: 'Standard', sizes: [
      { size: '7x8', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // p47 - AMALFI
  { collection: 'Amalfi', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '6x6', price: 5.09, basis: 'per_sqft' },
    ]},
  ]},
  // p48 - BLACK AND WHITE (encaustic 8x8)
  { collection: 'Black and White', finishes: [
    { finish: 'Matte', sizes: [
      { size: '8x8', price: 5.76, basis: 'per_sqft' },
    ]},
  ]},
  // p49 - RE-STYLE → DB "Re_Style"
  { collection: 'Re-Style', finishes: [
    { finish: 'Standard', sizes: [
      { size: '8x8', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // p50 - TANGER
  { collection: 'Tanger', finishes: [
    { finish: 'Standard', sizes: [
      { size: '5x5', price: 6.35, basis: 'per_sqft' },
    ]},
  ]},
  // p51 - BIO CONCRETE (concrete look)
  { collection: 'Bio Concrete', finishes: [
    { finish: 'Matte', sizes: [
      { size: '12x24', price: 4.86, basis: 'per_sqft' },
      { size: '24x48', price: 6.03, basis: 'per_sqft' },
      { size: '24x24', price: 4.86, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
    { finish: 'Terazzo Matte', sizes: [
      { size: '2x2', price: 20.03, basis: 'per_unit' },
    ]},
  ]},
  // EICHE (wood-look plank, website dealer pricing)
  { collection: 'Eiche', finishes: [
    { finish: 'Standard', sizes: [
      { size: '8x48', price: 3.83, basis: 'per_sqft' },
      { size: '10.25x63', price: 4.95, basis: 'per_sqft' },
    ]},
  ]},
  // FANGO (handmade-look wall tile, website dealer pricing)
  { collection: 'Fango', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '2x6', price: 7.34, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '2x6', price: 7.34, basis: 'per_sqft' },
    ]},
    { finish: 'jolly Glossy', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_unit' },
    ]},
    { finish: 'jolly Matte', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // FUORITONO (subway/rhomboid/hexagon shapes, website dealer pricing)
  { collection: 'Fuoritono', finishes: [
    { finish: 'Subway Glossy', sizes: [
      { size: '4x12', price: 4.86, basis: 'per_sqft' },
    ]},
    { finish: 'Subway Matte', sizes: [
      { size: '4x12', price: 4.86, basis: 'per_sqft' },
    ]},
    { finish: 'Rhomboid Glossy', sizes: [
      { size: '5x9', price: 4.37, basis: 'per_sqft' },
    ]},
    { finish: 'Rhomboid Matte', sizes: [
      { size: '5x9', price: 4.37, basis: 'per_sqft' },
    ]},
    { finish: 'Hexagon Glossy', sizes: [
      { size: '9x10', price: 4.37, basis: 'per_sqft' },
    ]},
    { finish: 'Hexagon Matte', sizes: [
      { size: '9x10', price: 4.37, basis: 'per_sqft' },
    ]},
    { finish: 'Jolly Liner Glossy', sizes: [
      { size: '1/2x12', price: 6.30, basis: 'per_unit' },
    ]},
    { finish: 'Jolly Liner Matte', sizes: [
      { size: '1/2x12', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // INTRECCIO (pencil liner + trim liner, website dealer pricing)
  { collection: 'Intreccio', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '1/2x18', price: 9.05, basis: 'per_unit' },
      { size: '2x18', price: 9.05, basis: 'per_unit' },
    ]},
  ]},
  // MARVEL (large format marble-look, website dealer pricing)
  { collection: 'Marvel', finishes: [
    { finish: 'Matte', sizes: [
      { size: '48x48', price: 2.69, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
    { finish: 'Polished', sizes: [
      { size: '48x48', price: 2.69, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
    ]},
  ]},
  // MEMORY (glossy wall tile, website dealer pricing)
  { collection: 'Memory', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '2 1/2x10', price: 5.99, basis: 'per_sqft' },
    ]},
    { finish: 'Jolly Liner Glossy', sizes: [
      { size: '1/2x10', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // MINGLE (flat liner + deco liner, website dealer pricing)
  { collection: 'Mingle', finishes: [
    { finish: 'Flat Matte', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_sqft' },
      { size: '2x16', price: 8.33, basis: 'per_unit' },
    ]},
    { finish: 'Deco Matte', sizes: [
      { size: '2x16', price: 8.33, basis: 'per_unit' },
    ]},
  ]},
  // NOVA (pencil liner + trim liner, website dealer pricing)
  { collection: 'Nova', finishes: [
    { finish: 'Matte', sizes: [
      { size: '1/2x15', price: 6.62, basis: 'per_sqft' },
      { size: '2x15', price: 6.62, basis: 'per_unit' },
    ]},
  ]},
  // PLANCHES (wood-look plank, website dealer pricing)
  { collection: 'Planches', finishes: [
    { finish: 'Standard', sizes: [
      { size: '10 1/2x71', price: 1.79, basis: 'per_sqft' },
    ]},
  ]},
  // PYPER (wall tile, website dealer pricing)
  { collection: 'Pyper', finishes: [
    { finish: 'Matte', sizes: [
      { size: '4x12', price: 9.90, basis: 'per_sqft' },
    ]},
    { finish: 'Jolly Liner Matte', sizes: [
      { size: '1/2x12', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // SILVAN (wood-look, website dealer pricing)
  { collection: 'Silvan', finishes: [
    { finish: 'Matte', sizes: [
      { size: '8x48', price: 4.86, basis: 'per_sqft' },
    ]},
    { finish: 'Stave', sizes: [
      { size: '8x48', price: 15.80, basis: 'per_sqft' },
      { size: '12x48', price: 14.00, basis: 'per_sqft' },
    ]},
    { finish: 'Stave 3D', sizes: [
      { size: '8x48', price: 15.80, basis: 'per_sqft' },
    ]},
  ]},
  // SPLENDOURS (glossy wall tile + chair rail, website dealer pricing)
  { collection: 'Splendours', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '3x6', price: 4.14, basis: 'per_sqft' },
      { size: '3x12', price: 4.14, basis: 'per_unit' },
    ]},
    { finish: 'London Chair Rail Glossy', sizes: [
      { size: '2x6', price: 4.05, basis: 'per_unit' },
    ]},
    { finish: 'Jolly Liner Glossy', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_unit' },
    ]},
    { finish: 'Quarter Round Glossy', sizes: [
      { size: '1x6', price: 4.46, basis: 'per_unit' },
    ]},
  ]},
  // p52 - GLOCAL
  { collection: 'Glocal', finishes: [
    { finish: 'Standard', sizes: [
      { size: '12x24', price: 4.91, basis: 'per_sqft' },
      { size: '2x2', price: 20.03, basis: 'per_unit' },
      { size: '24x48', price: 6.08, basis: 'per_sqft' },
      { size: '3x24', price: 14.00, basis: 'per_unit' },
      { size: '3x48', price: 25.16, basis: 'per_unit' },
      { size: '48x48', price: 6.57, basis: 'per_sqft' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '1x4', price: 30.02, basis: 'per_unit' },
    ]},
  ]},
  // CUSP (glossy wall tile + accessories, website dealer pricing)
  { collection: 'Cusp', finishes: [
    { finish: 'Glossy', sizes: [
      { size: '2.5x10', price: 5.36, basis: 'per_unit' },
    ]},
    { finish: 'Jolly Pencil Glossy', sizes: [
      { size: '1/2x8', price: 6.30, basis: 'per_unit' },
    ]},
  ]},
  // MATCH (wall tile + bullnose, website dealer pricing)
  { collection: 'Match', finishes: [
    { finish: 'Matte', sizes: [
      { size: '3x11', price: 14.00, basis: 'per_unit' },
    ]},
  ]},
  // OP ART (wall tile accessories, website dealer pricing)
  { collection: 'Op Art', finishes: [
    { finish: 'Jolly Liner Glossy', sizes: [
      { size: '1/2x10', price: 6.30, basis: 'per_unit' },
    ]},
    { finish: 'Jolly Liner Matte', sizes: [
      { size: '1/2x10', price: 6.30, basis: 'per_unit' },
    ]},
    { finish: 'Quarter Round Liner Glossy', sizes: [
      { size: '1x10', price: 4.46, basis: 'per_unit' },
    ]},
    { finish: 'Quarter Round Liner Matte', sizes: [
      { size: '1x10', price: 4.46, basis: 'per_unit' },
    ]},
    { finish: 'Glossy', sizes: [
      { size: '2x10', price: 5.31, basis: 'per_unit' },
    ]},
    { finish: 'Matte', sizes: [
      { size: '2x10', price: 5.31, basis: 'per_unit' },
    ]},
  ]},
];

// ── Helpers ──

function normalizeSize(pdfSize) {
  return pdfSize
    .replace(/"/g, '')
    .replace(/\s*mosaic\s*/i, '')
    .replace(/\s*surface\s*bullnose\s*/i, '')
    .replace(/\s*hexagon\s*/i, '')
    .toLowerCase()
    .trim();
}

function normalizeCollection(col) {
  const lower = col.toLowerCase().trim();
  return COLLECTION_ALIASES[lower] || lower;
}

// ── Main ──

async function main() {
  // 1. Fetch all Bosphorus SKUs with their Size and Finish attributes
  const { rows: skus } = await pool.query(`
    SELECT s.id, s.internal_sku, s.sell_by, s.variant_type,
           p.collection, p.name as product_name,
           MAX(CASE WHEN a.name = 'Size' THEN sa.value END) as size_attr,
           MAX(CASE WHEN a.name = 'Finish' THEN sa.value END) as finish_attr
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id
    WHERE p.vendor_id = $1
    GROUP BY s.id, s.internal_sku, s.sell_by, s.variant_type, p.collection, p.name
  `, [VENDOR_ID]);

  console.log(`Found ${skus.length} Bosphorus SKUs\n`);

  // 2. Build lookup maps
  //    Key format: "collection|size|finish" (all lowercased)
  //    Also build "collection|size" for fallback matching
  const exactMap = new Map();   // col|size|finish → [sku]
  const sizeMap = new Map();    // col|size → [sku]

  for (const sku of skus) {
    const col = (sku.collection || '').toLowerCase().trim();
    let size = (sku.size_attr || '').toLowerCase().trim();
    let finish = (sku.finish_attr || '').toLowerCase().trim();

    // Fix "3D Satin" split: size="24x48 3", finish="d satin" → size="24x48", finish="3d satin"
    if (size.endsWith(' 3') && finish === 'd satin') {
      size = size.slice(0, -2);
      finish = '3d satin';
    }

    sku._normSize = size;
    sku._normFinish = finish;

    const exactKey = `${col}|${size}|${finish}`;
    if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
    exactMap.get(exactKey).push(sku);

    const sizeKey = `${col}|${size}`;
    if (!sizeMap.has(sizeKey)) sizeMap.set(sizeKey, []);
    sizeMap.get(sizeKey).push(sku);
  }

  // 3. Process each pricing entry
  let matched = 0, unmatched = 0, errors = 0;
  const unmatchedEntries = [];

  for (const entry of PRICING_DATA) {
    const col = normalizeCollection(entry.collection);

    for (const fg of entry.finishes) {
      const pdfFinish = fg.finish.toLowerCase().trim();
      const isStandard = pdfFinish === 'standard';

      for (const sp of fg.sizes) {
        if (!sp.price) continue;

        const normSize = normalizeSize(sp.size);
        let targets = null;

        if (!isStandard) {
          // Try exact match first
          const exactKey = `${col}|${normSize}|${pdfFinish}`;
          targets = exactMap.get(exactKey);
        }

        if (!targets || targets.length === 0) {
          // Fallback: collection + size only
          const sizeKey = `${col}|${normSize}`;
          const allAtSize = sizeMap.get(sizeKey);

          if (allAtSize && allAtSize.length > 0) {
            // If PDF has a specific (non-Standard) finish but no exact match,
            // and there are multiple different finishes at this size in the DB,
            // check if this PDF entry's collection has other finish rows for the same size
            // (which would mean we shouldn't fallback to avoid mixing prices)
            if (!isStandard) {
              const hasMultiFinishInPdf = entry.finishes.filter(f =>
                f.finish.toLowerCase() !== 'standard' &&
                f.sizes.some(s => normalizeSize(s.size) === normSize && s.price)
              ).length > 1;

              if (hasMultiFinishInPdf) {
                // Multiple finishes in PDF for this size — don't fallback, skip
                unmatchedEntries.push(`${entry.collection} | ${sp.size} (${normSize}) | ${fg.finish} — finish mismatch, multi-finish series`);
                unmatched++;
                continue;
              }
            }
            targets = allAtSize;
          }
        }

        if (!targets || targets.length === 0) {
          unmatchedEntries.push(`${entry.collection} | ${sp.size} (${normSize}) | ${fg.finish}`);
          unmatched++;
          continue;
        }

        // Upsert pricing for each matched SKU
        const cost = sp.price;
        const retailPrice = +(cost * RETAIL_MARKUP).toFixed(2);

        for (const sku of targets) {
          try {
            await pool.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (sku_id) DO UPDATE SET
                cost = EXCLUDED.cost,
                retail_price = EXCLUDED.retail_price,
                price_basis = EXCLUDED.price_basis
            `, [sku.id, cost, retailPrice, sp.basis]);
            matched++;
          } catch (err) {
            console.error(`  ERROR ${sku.internal_sku}: ${err.message}`);
            errors++;
          }
        }
      }
    }
  }

  // 4. Report results
  console.log(`\n── Results ──`);
  console.log(`SKU pricing rows upserted: ${matched}`);
  console.log(`PDF entries unmatched:      ${unmatched}`);
  console.log(`Errors:                     ${errors}`);

  if (unmatchedEntries.length > 0) {
    console.log(`\n── Unmatched PDF entries (no DB SKU found) ──`);
    for (const e of unmatchedEntries) {
      console.log(`  ${e}`);
    }
  }

  // 5. Coverage check
  const { rows: [{ priced, total }] } = await pool.query(`
    SELECT
      COUNT(pr.sku_id) as priced,
      COUNT(s.id) as total
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
  `, [VENDOR_ID]);
  console.log(`\n── Coverage ──`);
  console.log(`Priced: ${priced} / ${total} SKUs (${((priced/total)*100).toFixed(1)}%)`);

  // Show unpriced collections
  const { rows: unpriced } = await pool.query(`
    SELECT p.collection, COUNT(*) as cnt
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND pr.sku_id IS NULL
    GROUP BY p.collection
    ORDER BY cnt DESC
  `, [VENDOR_ID]);
  if (unpriced.length > 0) {
    console.log(`\n── Unpriced collections ──`);
    for (const r of unpriced) {
      console.log(`  ${r.collection}: ${r.cnt} SKUs`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
