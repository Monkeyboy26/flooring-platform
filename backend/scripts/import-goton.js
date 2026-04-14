/**
 * Goton Tiles, Inc — Full Catalog Import
 * Source: GOTON B8 2025-11 (11 pages, ~52 porcelain tile series + glass mosaics + Vetro glass tile)
 * Pricing: B8 column = our cost. Retail = cost × 2.0
 *
 * Usage: docker compose exec api node scripts/import-goton.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ── Category IDs (from DB) ──
const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
};

// ── Attribute IDs ──
const ATTR = {
  color:    'd50e8400-e29b-41d4-a716-446655440001',
  size:     'd50e8400-e29b-41d4-a716-446655440004',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
};

// ── Vendor SKU generator ──
const usedSkus = new Set();
function genSku(series, code, size) {
  const s = series.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5);
  const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
  const z = size.replace(/[" \/]/g, '').toUpperCase();
  let base = `GOTON-${s}-${c}-${z}`;
  if (usedSkus.has(base)) {
    let i = 2;
    while (usedSkus.has(`${base}-${i}`)) i++;
    base = `${base}-${i}`;
  }
  usedSkus.add(base);
  return base;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT DATA
// ══════════════════════════════════════════════════════════════════════════════
// Each series object:
//   name: series name
//   cat: 'porcelain' | 'mosaic'
//   colors: [[colorName, code], ...] — shared across all tile/mosaic/acc rows
//   tile: [[desc, size, pcs, sf, plt, sfPlt, cost], ...] — porcelain tiles (sell_by: sqft)
//   mosaic: [[desc, size, pcs, sf, plt, sfPlt, cost], ...] — mosaics with sqft (sell_by: sqft)
//   acc: [[desc, size, pcs, cost], ...] — accessories (sell_by: unit, variant_type: accessory)
//   notes: optional notes about color restrictions

const SERIES = [
  // ══════════════════════════════════════════════════════════════════════
  // PAGE 1 — 2026 New Launch (Made in Italy) + 2025 New Launch 48x48 (Made in Spain)
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Portland', cat: 'porcelain',
    colors: [
      ['Avorio Cross Cut', '830'], ['Beige Cross Cut', '831'], ['Taupe Cross Cut', '832'],
      ['Avorio Vein Cut', '833'], ['Beige Vein Cut', '834'], ['Taupe Vein Cut', '835'],
    ],
    tile: [
      ['Porcelain Tile (Matt)', '48x48', 2, 32.18, 20, 643.6, 6.29],
      ['Porcelain Tile (Matt)', '24x48', 2, 16.04, 36, 577.4, 4.19],
      ['Porcelain Tile (Grip R11)', '24x48', 2, 16.04, 36, 577.4, 4.39],
      ['Porcelain Tile (Millerighe Structured)', '24x48', 2, 16.04, 36, 577.4, 4.59],
    ],
  },
  {
    name: 'Doncella', cat: 'porcelain',
    colors: [['Ivory', '825']],
    tile: [
      ['Porcelain Tile (Polished)', '48x48', 1, 15.28, 36, 550.1, 5.79],
      ['Porcelain Tile (Polished)', '24x48', 2, 15.07, 36, 542.5, 3.99],
      ['Porcelain Tile (Matt)', '48x48', 1, 15.50, 36, 558.0, 5.59],
      ['Porcelain Tile (Matt)', '24x48', 2, 15.39, 40, 615.6, 3.79],
    ],
  },
  {
    name: 'Windsor', cat: 'porcelain',
    colors: [['White', '801'], ['Black', '802']],
    tile: [
      ['Porcelain Tile (Polished)', '48x48', 1, 15.49, 40, 619.6, 5.79],
    ],
  },
  {
    name: 'Chile', cat: 'porcelain',
    colors: [['White', '805']],
    tile: [
      ['Porcelain Tile (Matt)', '48x48', 1, 15.49, 40, 619.6, 5.59],
      ['Porcelain Tile (Polished)', '48x48', 1, 15.49, 40, 619.6, 5.79],
    ],
  },
  {
    name: 'Onix', cat: 'porcelain',
    colors: [['Blanco', '811'], ['Beige', '812']],
    tile: [
      ['Porcelain Tile (Polished)', '48x48', 1, 15.49, 40, 619.6, 5.79],
    ],
  },
  {
    name: 'Moon', cat: 'porcelain',
    colors: [['White', '815'], ['Sand', '816']],
    tile: [
      ['Porcelain Tile (3D Soft)', '48x48', 1, 15.49, 40, 619.6, 5.79],
    ],
  },
  {
    name: 'Bella Stone', cat: 'porcelain',
    colors: [['Bone', '821'], ['Cream', '822']],
    tile: [
      ['Porcelain Tile (Matt)', '48x48', 1, 15.49, 40, 619.6, 5.59],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 2 — 2025 New Launch 24x48 and 12x24
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Travertine Nuevo', cat: 'porcelain',
    colors: [['Avorio', '601'], ['Crema', '602'], ['Noce', '603']],
    tile: [
      ['Porcelain Tile (Matt)', '24x48', 2, 15.49, 40, 619.6, 2.19],
      ['Porcelain Tile (Polished)', '24x48', 2, 15.49, 40, 619.6, 2.39],
      ['Porcelain Tile (Matt)', '12x24', 8, 15.49, 40, 619.6, 1.99],
      ['Porcelain Tile (Polished)', '12x24', 8, 15.49, 40, 619.6, 2.19],
    ],
  },
  {
    name: 'Carrara Nuevo', cat: 'porcelain',
    colors: [['Carrara Nuevo', '605']],
    tile: [
      ['Porcelain Tile (Polished)', '24x48', 2, 15.49, 30, 464.7, 2.39],
      ['Porcelain Tile (Polished)', '12x24', 8, 15.49, 40, 619.6, 2.19],
    ],
  },
  {
    name: 'Royal Batticino', cat: 'porcelain',
    colors: [['Royal Batticino', '611']],
    tile: [
      ['Porcelain Tile (Polished)', '24x48', 2, 15.49, 40, 619.6, 2.39],
      ['Porcelain Tile (Polished)', '12x24', 8, 15.49, 40, 619.6, 2.19],
    ],
  },
  {
    name: 'Soslate Textured', cat: 'porcelain',
    colors: [['Bianco', '615'], ['Beige', '616'], ['Nero', '617']],
    tile: [
      ['Porcelain Tile (Color Body Textured)', '24x48', 2, 15.49, 40, 619.6, 2.29],
      ['Porcelain Tile (Color Body Textured)', '12x24', 8, 15.49, 40, 619.6, 2.09],
    ],
  },
  {
    name: 'Premium Whitehause', cat: 'porcelain',
    colors: [['Premium Whitehause', '621']],
    tile: [
      ['Porcelain Tile (Baby Skin)', '24x48', 2, 15.49, 40, 619.6, 2.69],
      ['Porcelain Tile (Baby Skin)', '12x24', 8, 15.49, 40, 619.6, 2.49],
    ],
  },
  {
    name: 'Supergres Fog', cat: 'porcelain',
    colors: [['Fog', 'RT']],
    tile: [
      ['Porcelain Tile', '24x48', 2, 15.49, null, null, 2.19],
    ],
  },
  {
    name: 'Whitehause', cat: 'porcelain',
    colors: [['Micro Crystalline White', '2WH126204']],
    tile: [
      ['Porcelain Tile', '24x48', 2, 15.49, null, null, 2.69],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 3 — Main Catalog
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Aegean', cat: 'porcelain',
    colors: [['Citrine', '331'], ['Crystal', '332'], ['Smoky', '334']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Beautiful Sicily', cat: 'porcelain',
    colors: [
      ['Sand', '081'], ['Silver', '082'], ['Titanium', '083'],
      ['Oxide', '084'], ['Fusion Textured', '079R'],
    ],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.10],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 2.07],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
      ['Cove Base', '13x6-1/4', 10, 3.78],
    ],
  },
  {
    name: 'Beachwood', cat: 'porcelain',
    colors: [
      ['Danapoint', '435'], ['Laguna', '436'], ['Newport', '437'],
      ['Huntington', '438'], ['Redondo', '439'],
    ],
    tile: [
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '9x48', 5, 14.53, 45, 653.85, 2.39],
      ['Porcelain Tile', '18x48', 2, 11.62, 34, 395.08, 3.19],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
  },
  {
    name: 'Bebinca', cat: 'porcelain',
    colors: [['Ivory', '236'], ['Dorato', '237'], ['Grigio', '238']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Bolaven', cat: 'porcelain',
    colors: [
      ['Blanco', '230'], ['Crema', '231'], ['Metalico', '232'],
      ['Gris', '233'], ['Nero', '234'], ['Papel', '235'],
    ],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 1x4 Mix', '12x12', 11, 11.00, 54, 594, 5.52],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Carrara', cat: 'porcelain',
    colors: [['Gris', '131']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '3x6', 88, 11.00, 54, 594, 1.89],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 7.15],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
      ['1/4 Round', '1x6', 150, 1.91],
      ['1/4 Round Beak', '1x1', 100, 2.12],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 4
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Chebi Rock', cat: 'porcelain',
    colors: [['Desert', '166'], ['Glacier', '167'], ['Earth', '168'], ['Forest', '169']],
    tile: [
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.29],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 2.07],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
    ],
  },
  {
    name: 'Cimaron', cat: 'porcelain',
    colors: [['Bianca', '121'], ['Beige', '122'], ['Noce', '123'], ['Chocolate', '124']],
    tile: [
      ['Porcelain Tile', '20x20', 6, 16.14, 36, 581.04, 2.05],
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 2.05],
      ['Porcelain Tile', '6-1/2x6-1/2', 36, 10.65, 54, 575.1, 2.04],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '13x13', 11, 12.89, 54, 696.06, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x20', 25, 2.78],
      ['V-Cap', '2x6-1/2', 50, 2.40],
      ['V-Cap Corner', '1x2', 18, 1.91],
      ['1/4 Round', '1x6-1/2', 150, 1.83],
      ['1/4 Round Beak', '1x1', 100, 2.00],
      ['Cove Base', '13x6-1/4', 10, 3.78],
      ['Out-Corner', '1x6-1/4', 12, 2.91],
    ],
  },
  {
    name: 'Coastwood', cat: 'porcelain',
    colors: [
      ['Pismo', '320'], ['Venice', '321'], ['Malibu', '322'],
      ['Hearst', '323'], ['Rincon', '324'], ['Big Sur', '325'],
    ],
    tile: [
      ['Porcelain Tile', '6x36', 9, 13.07, 52, 679.64, 1.59],
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '9x48', 5, 14.53, 45, 653.85, 2.39],
    ],
    mosaic: [
      ['Porcelain Mosaic 4x4 Hexagon', '13.4x11', 11, 8.80, 54, 475.2, 6.78],
      ['Porcelain Mosaic 2x6 Chevron', '9.5x11-3/4', 11, 8.58, 60, 514.8, 8.37],
      ['Porcelain Mosaic Opus Pattern', '11x16', 17, 19.76, 40, 790.51, 8.37],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
    ],
  },
  {
    name: 'Coastwood II', cat: 'porcelain',
    colors: [
      ['Bal Harbor', '461'], ['Surfside', '462'],
      ['North Beach', '463'], ['Miami Beach', '464'],
    ],
    tile: [
      ['Porcelain Tile', '9x48', 5, 14.53, 45, 653.85, 2.39],
    ],
  },
  {
    name: 'Coastwalk', cat: 'porcelain',
    colors: [['Shell', '326'], ['Ice', '327'], ['Reef', '328']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
    ],
    acc: [
      ['Floor Bullnose', '3x12', null, 3.78],
    ],
  },
  {
    name: 'Conson', cat: 'porcelain',
    colors: [['Nickel', '156'], ['Zinc', '157'], ['Platinum', '158'], ['Copper', '159']],
    tile: [
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '6x36', 9, 13.07, 52, 679.64, 1.59],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '6x24', 14, 13.56, 48, 650.88, 2.10],
    ],
    mosaic: [
      ['Herringbone 1x3', '9x12', 11, null, null, null, 6.34],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 5
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Danas', cat: 'porcelain',
    colors: [['Blanco', '191'], ['Marfil', '192'], ['Gris', '193'], ['Marron', '194']],
    tile: [
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.10],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 1x4 Mix', '12x12', 11, 11.00, 54, 594, 5.52],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Danube Waves', cat: 'porcelain',
    colors: [['Bianca', '091'], ['Beige', '092'], ['Almond', '093']],
    tile: [
      ['Porcelain Tile', '20x20', 6, 16.14, 36, 581.04, 2.05],
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 2.05],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '13x13', 11, 12.89, 54, 696.06, 4.99],
      ['Porcelain Mosaic Lineal Random', '13x13', 11, 12.89, 54, 696.06, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x20', 25, 2.78],
    ],
  },
  {
    name: 'Fitow', cat: 'porcelain',
    colors: [
      ['Vanilla', '221'], ['Biscotti', '222'], ['Earl Grey', '223'],
      ['Caramel', '224'], ['Espresso', '225'],
    ],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '6x24', 14, 13.56, 48, 650.88, 2.10],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
      ['Porcelain Mosaic 1x4', '12x12', 11, 11.00, 54, 594, 5.52],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
      ['Cove Base', '12x6-1/4', 10, 3.91],
    ],
  },
  {
    name: 'Fusion', cat: 'porcelain',
    colors: [
      ['Canvas', '421'], ['Sateen', '422'], ['Batik', '423'],
      ['Leather', '424'], ['Damask', '425'],
    ],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.79],
      ['Porcelain Tile', '18x48', 2, 11.62, 34, 395.08, 3.19],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Glacier', cat: 'porcelain',
    colors: [['Snowfall', '402'], ['Crevasse', '403'], ['Iceberg', '404']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.79],
    ],
    mosaic: [
      ['Porcelain Mosaic 1-1/2x2 Basketweave', '12x12', 11, 10.56, 54, 570.24, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Glacier Undulated', cat: 'porcelain',
    colors: [['Snowfall Undulated', '402B'], ['Crevasse Undulated', '403B'], ['Iceberg Undulated', '404B']],
    tile: [
      ['Porcelain Tile', '12x36', 5, 14.50, 40, 580, 2.19],
    ],
    mosaic: [
      ['Porcelain Mosaic 2.5x3 Large Basketweave', '12x12', 11, 10.56, 54, 570.24, 6.49],
    ],
  },
  {
    name: 'Iconic', cat: 'porcelain',
    colors: [['Vapor', '431'], ['Alloy', '432'], ['Bronze', '433'], ['Composite', '434']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
      ['Porcelain Tile', '18x48', 2, 11.62, 34, 395.08, 3.19],
    ],
    mosaic: [
      ['Porcelain Mosaic Cube', '12x12', 12, 13.63, 54, 736.04, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', null, 3.78],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 6
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Karst Grace', cat: 'porcelain',
    colors: [['Blanco', '111'], ['Creme', '112'], ['Miel', '113'], ['Gris', '114']],
    tile: [
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Krovanh', cat: 'porcelain',
    colors: [
      ['210', '210'], ['211', '211'], ['212', '212'], ['213', '213'],
      ['214', '214'], ['215', '215'], ['216', '216'],
    ],
    tile: [
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '6x36', 9, 13.07, 52, 679.64, 1.59],
      ['Porcelain Tile', '6x24', 14, 13.56, 48, 650.88, 2.10],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 6.78],
    ],
  },
  {
    name: 'Majestic Gambus', cat: 'porcelain',
    colors: [['Bianca', '101'], ['Beige', '102'], ['Noce', '104'], ['Gris', '100']],
    tile: [
      ['Porcelain Tile', '20x20', 6, 16.14, 36, 581.04, 1.98],
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 1.98],
      ['Porcelain Tile', '6-1/2x6-1/2', 36, 10.65, 54, 575.1, 2.04],
    ],
    mosaic: [
      ['Mosaic 2x2', '13x13', 11, 12.89, 54, 696.06, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x20', 25, 2.78],
      ['V-Cap', '2x6-1/2', 50, 2.40],
      ['V-Cap Corner', '1x2', 18, 1.91],
      ['1/4 Round', '1x6-1/2', 150, 1.83],
      ['1/4 Round Beak', '1x1', 100, 2.00],
      ['Cove Base', '13x6-1/4', 10, 3.78],
      ['Out-Corner', '1x6-1/4', 12, 2.91],
    ],
  },
  {
    name: 'Malakas Rock', cat: 'porcelain',
    colors: [['Avorio', '161'], ['Crema', '162'], ['Grigio', '163'], ['Walnut', '164']],
    tile: [
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 2.07],
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 2.07],
      ['Porcelain Tile', '6x6', 44, 10.65, 64, 681.6, 2.04],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
      ['Mosaic 1x1 Porcelain & Glass', '12x12', 11, 11.00, 54, 594, 7.01],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
      ['Single Side Bullnose', '6x6', 44, 3.54],
      ['Double Side Bullnose', '6x6', 44, 4.25],
      ['V-Cap', '2x6', 50, 2.40],
      ['V-Cap Corner', '1x2', 18, 1.91],
      ['1/4 Round', '1x6', 150, 1.83],
      ['1/4 Round Beak', '1x1', 100, 2.00],
      ['Cove Base', '12x6-1/4', 10, 3.78],
      ['Out-Corner', '1x6-1/4', 12, 2.91],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 7
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Maysak', cat: 'porcelain',
    colors: [['Sabbia', '195'], ['Lino', '196'], ['Grigio', '197'], ['Peltro', '198'], ['Scuro', '199']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Meranti', cat: 'porcelain',
    colors: [['Pearl', '241'], ['Taupe', '242'], ['Smoke', '243'], ['Carbon', '244']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '6x36', 9, 13.07, 52, 679.64, 1.59],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.09],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.79],
      ['Porcelain Tile', '6x24', 14, 13.56, 48, 650.88, 2.10],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Nabi', cat: 'porcelain',
    colors: [['Vanilla', '202'], ['Nutmeg', '203'], ['Caramel', '204']],
    tile: [
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 2.13],
      ['Porcelain Tile', '10x16', 10, 10.76, 48, 516.48, 2.31],
      ['Porcelain Tile', '8x13', 20, 14.21, 54, 767.34, 2.31],
      ['Porcelain Tile', '6-1/2x6-1/2', 36, 10.65, 54, 575.1, 2.04],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '13x13', 11, 12.89, 54, 696.06, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x20', 25, 2.78],
      ['V-Cap', '2x6-1/2', 50, 2.40],
      ['V-Cap Corner', '1x2', 18, 1.91],
      ['1/4 Round', '1x6-1/2', 150, 1.83],
      ['1/4 Round Beak', '1x1', 100, 2.00],
      ['Cove Base', '13x6-1/4', 10, 3.78],
      ['Out-Corner', '1x6-1/4', 12, 2.91],
    ],
  },
  {
    name: 'Petrafina', cat: 'porcelain',
    colors: [['Quartz', '336'], ['Oyster', '337'], ['Onyx', '338'], ['Ash', '339']],
    tile: [
      // 18x36 and 12x24 have CALL for packaging — import with cost, no packaging
      ['Porcelain Tile', '18x36', null, null, null, null, 1.59],
      ['Porcelain Tile', '12x24', null, null, null, null, 1.69],
    ],
    mosaic: [
      ['Porcelain/Glass Mosaic 2x6 Chevron', '12x12', null, null, null, null, 10.52],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
      ['Porcelain Mosaic 1-1/2x2 Basketweave', '12x12', 11, 10.56, 54, 570.24, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Petrafina', cat: 'porcelain',
    _subgroup: true, // second Petrafina sub-group
    colors: [['Phyllite', '333'], ['Slate', '335']],
    tile: [
      ['Porcelain Tile', '12x36', 5, 14.50, 40, 580, 1.69],
    ],
  },
  {
    name: 'Saddlewood', cat: 'porcelain',
    colors: [
      ['Appaloosa', '310'], ['Palamino', '311'], ['Buckskin', '312'],
      ['Chestnut', '313'], ['Pinto', '314'], ['Grullo', '315'],
    ],
    tile: [
      ['Porcelain Tile', '4x36', 12, 12.78, 54, 690.12, 1.79],
      ['Porcelain Tile', '6x36', 9, 13.07, 52, 679.64, 1.59],
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
    ],
    mosaic: [
      ['Porcelain Mosaic 4x4 Hexagon', '13.4x11', 11, 8.80, 54, 475.2, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 8
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Simpatico Concrete', cat: 'porcelain',
    colors: [['Cinder', '411'], ['Flint', '412'], ['Steel', '413'], ['Coal', '414']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.79],
    ],
    mosaic: [
      ['Porcelain Mosaic 1-1/2x2 Basketweave', '12x12', 11, 10.56, 54, 570.24, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Simpatico Wood', cat: 'porcelain',
    colors: [['Aspen', '416'], ['Pinyon', '417'], ['Spruce', '418'], ['Hemlock', '419']],
    tile: [
      ['Porcelain Tile', '6x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '9x36', 9, 13.07, 52, 679.64, 1.59],
    ],
  },
  {
    name: 'Southpoint', cat: 'porcelain',
    colors: [['Cottons', '406'], ['Doheny', '407'], ['Salt Creek', '408'], ['Trestles', '409']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
    ],
    mosaic: [
      ['Porcelain Mosaic 1-1/2x2 Basketweave', '12x12', 11, 10.56, 54, 570.24, 4.99],
      ['Porcelain Mosaic Opus Pattern', '11x16', 17, 19.76, 40, 790.51, 8.37],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Stream', cat: 'porcelain',
    colors: [['Silt', '306'], ['Pebble', '307'], ['Flow', '308'], ['Driftwood', '309']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 1.91],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
      ['Porcelain Mosaic Elongated Hex 1x5', '12x12', 11, 10.56, 54, 570.24, 6.78],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Theology', cat: 'porcelain',
    colors: [['Luna', '400'], ['Venti', '401']],
    tile: [
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.79],
      ['Porcelain Tile', '24x24', 4, 15.49, 40, 619.6, 2.29],
      ['Porcelain Tile', '3x6', 88, 11.00, 54, 594, 1.89],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
      ['Porcelain Mosaic 2x2 Hexagon', '12x12', 11, 11.00, 54, 594, 7.15],
      ['Porcelain Mosaic Opus Pattern', '11x16', 17, 19.76, 40, 790.51, 8.37],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Travertine', cat: 'porcelain',
    colors: [['Crema', '002'], ['Avorio', '015'], ['Noce', '017']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.59],
      ['Porcelain Tile', '13x13', 14, 16.40, 48, 787.2, 1.94],
    ],
    mosaic: [
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
      ['V-Cap', '2x6', 50, 2.40],
      ['V-Cap Corner', '1x2', 18, 1.91],
      ['1/4 Round', '1x6', 150, 1.83],
      ['1/4 Round Beak', '1x1', 100, 2.00],
      ['Cove Base', '13x6-1/4', 10, 3.78],
      ['Out-Corner', '1x6-1/4', 12, 2.91],
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PAGE 9
  // ══════════════════════════════════════════════════════════════════════
  {
    name: 'Urban', cat: 'porcelain',
    colors: [['Cappuccino', '301'], ['Mist', '302'], ['Coffee', '303'], ['Shadow', '304']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '12x24', 8, 15.49, 40, 619.6, 1.69],
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 1.91],
      ['Porcelain Tile', '3x12', 40, 10.00, 64, 640, 2.36],
    ],
    mosaic: [
      ['Porcelain Mosaic Elongated Hex 1x5', '12x12', 11, 10.56, 54, 570.24, 6.78],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
    acc: [
      ['Floor Bullnose', '3x12', 40, 3.78],
    ],
  },
  {
    name: 'Vienna Style', cat: 'porcelain',
    colors: [['Beige', '086'], ['Noce', '089']],
    tile: [
      ['Porcelain Tile', '18x18', 7, 15.25, 32, 488, 1.38],
    ],
    acc: [
      ['Floor Bullnose', '3-1/4x18', 25, 2.78],
    ],
  },
  {
    name: 'Vintage', cat: 'porcelain',
    colors: [
      ['Blanco', '445'], ['Grigio', '446'], ['Santorini Blue', '447'],
      ['Cafe', '448'], ['Little Falls', '449'],
    ],
    tile: [
      ['Porcelain Tile', '9x36', 6, 13.07, 54, 705.78, 1.59],
      ['Porcelain Tile', '9x48', 5, 14.53, 45, 653.85, 2.39],
    ],
  },
  {
    name: 'Willow', cat: 'porcelain',
    colors: [['Alba', '465'], ['Cinerea', '466'], ['Lutea', '467'], ['Nigra', '468']],
    tile: [
      ['Porcelain Tile', '9x48', 5, 14.53, 45, 653.85, 2.39],
    ],
    mosaic: [
      ['Porcelain Mosaic 4x4 Hexagon', '13.4x11', 11, 8.80, 54, 475.2, 7.44],
      ['Porcelain Mosaic 2x2', '12x12', 11, 11.00, 54, 594, 4.99],
    ],
  },
  {
    name: 'Woodcrete', cat: 'porcelain',
    colors: [['Silver', '441'], ['Pewter', '442'], ['Graphite', '443']],
    tile: [
      ['Porcelain Tile', '18x36', 3, 13.07, 33, 431.31, 1.59],
    ],
  },
];

// ── Glass mosaic product naming ──
// Maps code prefix to descriptive product name format
function glassProductName(code, pattern) {
  const upper = code.toUpperCase();
  if (/^GM[12]\d+$/.test(upper)) return `Glass Stone Mosaic ${upper}`;
  if (/^GMH\d+$/.test(upper)) return `Glass Basketweave ${upper}`;
  if (/^GML3\d+$/.test(upper)) return `Glass Lineal ${upper}`;
  if (/^GML4\d+$/.test(upper)) return `Glass Metal Interlock ${upper}`;
  if (/^(GM|GML)5\d+$/.test(upper)) return `Glass Quartzite ${upper}`;
  // Fallback: title-case the pattern
  return `${pattern} ${upper}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE 10 — Glass & Stone Mosaics (each code = separate product)
// ══════════════════════════════════════════════════════════════════════════════
// [code, pattern, size, pcs, sf, plt, sfPlt, cost]
const GLASS_MOSAICS = [
  // Glass and Stone Mosaics
  ['GM101', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM102', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM103', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM104', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM105', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM106', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM107', '5/8x5/8', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM201', '1x1', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM203', '1x1', '11-11/16x11-11/16', 10, 10, 54, 540, 7.59],
  ['GM206', '1x1', '11-11/16x11-11/16', 9, 9, 54, 486, 7.59],
  ['GM207', '1x1', '11-11/16x11-11/16', 9, 9, 54, 486, 7.59],
  // Basketweave
  ['GMH602', 'Basketweave 5/8x2', '11-1/2x11-1/2', 10, 10, 54, 540, 7.59],
  ['GMH614', 'Basketweave 5/8x2', '11-1/2x11-1/2', 10, 10, 54, 540, 7.59],
  // Lineal Line
  ['GML305', 'Lineal Line', '11-11/16x12', 10, 10, 54, 540, 7.59],
  ['GML306', 'Lineal Line', '11-11/16x12', 10, 10, 54, 540, 7.59],
  ['GML308', 'Lineal Line', '11-11/16x12', 10, 10, 54, 540, 7.59],
  // Glass/Metal Lineal (Interlock)
  ['GML401', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML402', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML404', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML405', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML406', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML407', 'Metal Lineal Interlock', '12-1/4x11-3/4', 10, 10, 54, 540, 7.59],
  // Glass/Quartzite
  ['GM502', '5/8', '11-3/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GM503', '5/8', '11-3/4x11-3/4', 10, 10, 54, 540, 7.59],
  ['GML511', 'Lineal Line', '11-1/4x11-1/4', 10, 10, 54, 540, 7.59],
  ['GML513', 'Lineal Line', '11-1/4x11-1/4', 10, 10, 54, 540, 7.59],
];

// ══════════════════════════════════════════════════════════════════════════════
// Vetro Collection — Glass Tile (page 10)
// ══════════════════════════════════════════════════════════════════════════════
const VETRO_COLORS = [
  ['Bianco', '316-01'], ['Lino', '316-02'], ['Fumo', '316-03'], ['Salvia', '316-04'],
  ['Marro', '316-05'], ['Carnone', '316-06'], ['Cafe', '316-07'], ['Nero', '316-08'],
];
// Tile rows: [desc, size, pcs, sf, cost] — all sold by sqft (3 pcs = 1 sqft for 3x16)
const VETRO_TILES = [
  ['Textured (LS)', '3x16', 30, 10, 7.59],
  ['Smooth (LG)', '3x16', 30, 10, 7.59],
];
const VETRO_ACC = [
  ['Quarter Round (Pulito)', '1x6', null, 7.59],
];

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT LOGIC
// ══════════════════════════════════════════════════════════════════════════════

async function upsertAttr(client, skuId, attrSlug, value) {
  const attrId = ATTR[attrSlug];
  if (!attrId || !value) return;
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

async function upsertSku(client, { productId, vendorSku, variantName, sellBy, variantType }) {
  const res = await client.query(`
    INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active')
    ON CONFLICT ON CONSTRAINT skus_internal_sku_key
    DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = EXCLUDED.sell_by,
                  variant_type = EXCLUDED.variant_type, status = 'active'
    RETURNING id
  `, [productId, vendorSku, vendorSku, variantName, sellBy, variantType || null]);
  return res.rows[0].id;
}

async function upsertPricing(client, skuId, cost, priceBasis) {
  const retail = (cost * 2.0).toFixed(2);
  await client.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id)
    DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
  `, [skuId, cost.toFixed(2), retail, priceBasis]);
}

async function upsertPackaging(client, skuId, pcs, sf, plt, sfPlt) {
  if (!pcs && !sf) return false;
  await client.query(`
    INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, boxes_per_pallet, sqft_per_pallet)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sku_id)
    DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box, sqft_per_box = EXCLUDED.sqft_per_box,
                  boxes_per_pallet = EXCLUDED.boxes_per_pallet, sqft_per_pallet = EXCLUDED.sqft_per_pallet
  `, [skuId, pcs || null, sf || null, plt || null, sfPlt || null]);
  return true;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Upsert vendor ──
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Goton Tiles', 'GOTON', 'https://www.gotontiles.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Goton Tiles (${vendorId})`);

    let totalProducts = 0, totalSkus = 0, totalAccSkus = 0, totalMosaicSkus = 0;
    let totalPricing = 0, totalPkg = 0;

    // ══════════════════════════════════════════════════════════════════════
    // SERIES (porcelain tile with colors)
    // ══════════════════════════════════════════════════════════════════════
    for (const series of SERIES) {
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, 'Goton Tiles', $3, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, series._subgroup ? series.name : series.name, CAT[series.cat]]);
      const productId = prodRes.rows[0].id;
      if (!series._subgroup) totalProducts++;

      for (const [colorName, code] of series.colors) {
        // ── Tile SKUs (sell_by: sqft) ──
        if (series.tile) {
          for (const [desc, size, pcs, sf, plt, sfPlt, cost] of series.tile) {
            const sku = genSku(series.name, `${code}-${size.replace(/[^0-9x]/gi, '')}`, '');
            const variantName = `${colorName} ${code} ${size}`;
            const skuId = await upsertSku(client, {
              productId, vendorSku: sku, variantName, sellBy: 'sqft', variantType: null,
            });
            totalSkus++;
            await upsertPricing(client, skuId, cost, 'sqft');
            totalPricing++;
            if (await upsertPackaging(client, skuId, pcs, sf, plt, sfPlt)) totalPkg++;
            await upsertAttr(client, skuId, 'size', size);
            await upsertAttr(client, skuId, 'color', colorName);
            await upsertAttr(client, skuId, 'material', 'Porcelain');
          }
        }

        // ── Mosaic SKUs (sell_by: sqft if sf data, else unit) ──
        if (series.mosaic) {
          for (const [desc, size, pcs, sf, plt, sfPlt, cost] of series.mosaic) {
            const descAbbr = desc.replace(/[^A-Za-z0-9]/g, '').substring(0, 8).toUpperCase();
            const sku = genSku(series.name, `${code}-${descAbbr}`, size);
            const variantName = `${colorName} ${code} ${desc} ${size}`;
            const sellBy = sf ? 'sqft' : 'unit';
            const skuId = await upsertSku(client, {
              productId, vendorSku: sku, variantName, sellBy, variantType: null,
            });
            totalMosaicSkus++;
            await upsertPricing(client, skuId, cost, sellBy);
            totalPricing++;
            if (await upsertPackaging(client, skuId, pcs, sf, plt, sfPlt)) totalPkg++;
            await upsertAttr(client, skuId, 'size', size);
            await upsertAttr(client, skuId, 'color', colorName);
            await upsertAttr(client, skuId, 'material', 'Porcelain');
          }
        }

        // ── Accessory SKUs (sell_by: unit, variant_type: accessory) ──
        if (series.acc) {
          for (const [desc, size, pcs, cost] of series.acc) {
            const descAbbr = desc.replace(/[^A-Za-z0-9]/g, '').substring(0, 8).toUpperCase();
            const sku = genSku(series.name, `${code}-${descAbbr}`, size);
            const variantName = `${colorName} ${code} ${desc} ${size}`;
            const skuId = await upsertSku(client, {
              productId, vendorSku: sku, variantName, sellBy: 'unit', variantType: 'accessory',
            });
            totalAccSkus++;
            await upsertPricing(client, skuId, cost, 'unit');
            totalPricing++;
            await upsertAttr(client, skuId, 'size', size);
            await upsertAttr(client, skuId, 'color', colorName);
          }
        }
      }

      const tileCount = (series.tile || []).length * series.colors.length;
      const mosaicCount = (series.mosaic || []).length * series.colors.length;
      const accCount = (series.acc || []).length * series.colors.length;
      console.log(`  ${series.name}: ${tileCount} tiles + ${mosaicCount} mosaics + ${accCount} accessories (${series.colors.length} colors)`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // GLASS MOSAICS (each code = one product with one SKU)
    // ══════════════════════════════════════════════════════════════════════
    console.log(`\n── Glass & Stone Mosaics ──`);
    for (const [code, pattern, size, pcs, sf, plt, sfPlt, cost] of GLASS_MOSAICS) {
      const prodName = glassProductName(code, pattern);
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, 'Goton Glass Mosaics', $3, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, prodName, CAT.mosaic]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      const sku = genSku('GLASS', code, size);
      const variantName = `${code} ${size}`;
      const sellBy = sf ? 'sqft' : 'unit';
      const skuId = await upsertSku(client, {
        productId, vendorSku: sku, variantName, sellBy, variantType: null,
      });
      totalMosaicSkus++;
      await upsertPricing(client, skuId, cost, sellBy);
      totalPricing++;
      if (await upsertPackaging(client, skuId, pcs, sf, plt, sfPlt)) totalPkg++;
      await upsertAttr(client, skuId, 'size', size);
      await upsertAttr(client, skuId, 'material', 'Glass');

      console.log(`  ${code}: ${pattern} ${size}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // VETRO COLLECTION (one product, multiple color x finish SKUs)
    // ══════════════════════════════════════════════════════════════════════
    console.log(`\n── Vetro Collection ──`);
    const vetroRes = await client.query(`
      INSERT INTO products (id, vendor_id, name, collection, category_id, status)
      VALUES (gen_random_uuid(), $1, 'Vetro Collection', 'Goton Glass Mosaics', $2, 'active')
      ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
      DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
      RETURNING id
    `, [vendorId, CAT.mosaic]);
    const vetroProductId = vetroRes.rows[0].id;
    totalProducts++;

    for (const [colorName, code] of VETRO_COLORS) {
      for (const [desc, size, pcs, sf, cost] of VETRO_TILES) {
        const sku = genSku('VETRO', `${code}-${desc.substring(0, 4).toUpperCase()}`, size);
        const variantName = `${colorName} ${code} ${desc} ${size}`;
        const skuId = await upsertSku(client, {
          productId: vetroProductId, vendorSku: sku, variantName, sellBy: 'sqft', variantType: null,
        });
        totalSkus++;
        await upsertPricing(client, skuId, cost, 'sqft');
        totalPricing++;
        if (pcs && sf) {
          await upsertPackaging(client, skuId, pcs, sf, null, null);
          totalPkg++;
        }
        await upsertAttr(client, skuId, 'size', size);
        await upsertAttr(client, skuId, 'color', colorName);
        await upsertAttr(client, skuId, 'material', 'Glass');
      }

      // Vetro accessories (quarter round)
      for (const [desc, size, pcs, cost] of VETRO_ACC) {
        const sku = genSku('VETRO', `${code}-QR`, size);
        const variantName = `${colorName} ${code} ${desc} ${size}`;
        const skuId = await upsertSku(client, {
          productId: vetroProductId, vendorSku: sku, variantName, sellBy: 'unit', variantType: 'accessory',
        });
        totalAccSkus++;
        await upsertPricing(client, skuId, cost, 'unit');
        totalPricing++;
        await upsertAttr(client, skuId, 'size', size);
        await upsertAttr(client, skuId, 'color', colorName);
      }

      console.log(`  Vetro ${colorName} (${code}): 2 tiles + 1 accessory`);
    }

    await client.query('COMMIT');
    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Tile SKUs: ${totalSkus}`);
    console.log(`Mosaic SKUs: ${totalMosaicSkus}`);
    console.log(`Accessory SKUs: ${totalAccSkus}`);
    console.log(`Total SKUs: ${totalSkus + totalMosaicSkus + totalAccSkus}`);
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

run().catch(err => { console.error(err); process.exit(1); });
