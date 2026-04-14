/**
 * Unicorn Tile Corp — Full Catalog Import
 * Source: Unicorn and Deer Tile Q-4-2025 (Suggested Retail Price List, December 2025)
 * Pricing: MSRP in PDF. Our cost = 50% of MSRP. Retail = MSRP.
 * Two brands: Unicorn Tile (pages 3-12) and Deer Tile (pages 15-17)
 * Discontinued products (pages 13-14) excluded.
 *
 * Usage: docker compose exec api node scripts/import-unicorn.js
 */
import pg from 'pg';
import crypto from 'crypto';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ── Category IDs (from DB) ──
const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  ceramic:   '650e8400-e29b-41d4-a716-446655440013',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
  wall:      '650e8400-e29b-41d4-a716-446655440050',
};

// ── Vendor SKU generator ──
const usedSkus = new Set();
function genSku(brand, series, color, size) {
  const b = brand === 'Deer Tile' ? 'DR' : 'UN';
  const s = series.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5);
  const c = color.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
  const z = size.replace(/[" ]/g, '').toUpperCase();
  let base = `${b}-${s}-${c}-${z}`;
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
// tile = [color, size, msrp_per_sf, pcs_per_box, sqf_per_box, boxes_per_plt]
// unit = [desc, size, msrp_each]  (mosaics/pieces sold per sheet/piece)
// acc  = [desc, size, msrp_each]  (accessories: bullnose, jolly, covebase, mosaic-acc)

const PRODUCTS = [
  // ── Page 3: Glass Mosaic ──
  {
    name: 'GL Series', col: 'Unicorn Tile', cat: 'mosaic',
    unit: [['GL4007', '11-3/4x12-1/8', 9.00]],
    unitPkg: [[11, 10.88, 63]],  // pcs, sqf, plt for unit items
  },
  {
    name: 'Touch', col: 'Unicorn Tile', cat: 'mosaic',
    unit: [
      ['Blanco 4x16', '4x16', 5.00], ['Blanco 2x16', '2x16', 3.00],
      ['Gris 4x16', '4x16', 5.00], ['Gris 2x16', '2x16', 3.00],
      ['Gris 4x8', '4x8', 3.00], ['Gris 2x8', '2x8', 1.50],
      ['Crema 4x16', '4x16', 5.00], ['Crema 2x16', '2x16', 3.00],
      ['Gris Hexagon Mosaic', '11-3/4x10-1/4', 20.00],
    ],
  },

  // ── Page 4: Floor & Wall A-C ──
  {
    name: 'Akila Lux', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Black', '24x24', 9.90, 3, 11.90, 48],
      ['Graphit', '24x24', 9.90, 3, 11.90, 48],
      ['Blue', '24x24', 9.90, 3, 11.90, 48],
      ['Black', '24x48', 10.90, 2, 15.90, 27],
    ],
  },
  {
    name: 'Arte', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['White Glossy & Matte', '6x6', 5.90, 68, 17, 60],
      ['White Glossy & Matte', '3x12', 5.90, 23, 5.70, 112],
      ['Latte Glossy', '3x12', 6.90, 23, 5.70, 112],
      ['Silver Glossy', '3x12', 6.90, 23, 5.70, 112],
      ['Picket Glossy & Matte', '3x12', 7.40, 44, 10.40, 80],
    ],
    acc: [
      ['Jolly White', '5/8x12', 5.00],
      ['Jolly Latte & Silver', '5/8x12', 6.00],
    ],
  },
  {
    name: 'Bode', col: 'Unicorn Tile', cat: 'mosaic',
    unit: [
      ['Calacatta Gold Square 2x2', '12x12 sheet', 8.90],
      ['Statuario White Square 2x2', '12x12 sheet', 8.90],
      ['Calacatta Gold 2" Hex', '12-3/4x11 sheet', 10.40],
      ['Statuario White 2" Hex', '12-3/4x11 sheet', 10.40],
      ['Calacatta Gold 3" Hex', '10-1/4x11-3/4 sheet', 9.90],
      ['Statuario White 3" Hex', '10-1/4x11-3/4 sheet', 9.90],
      ['Silver Core 3" Hex', '10-1/4x11-3/4 sheet', 9.90],
      ['Calacatta Gold Herringbone', '2x8 sheet', 10.40],
      ['Statuario White Herringbone', '2x8 sheet', 10.40],
      ['Silver Core Herringbone', '2x8 sheet', 10.40],
    ],
  },
  {
    name: 'Brick', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Terra', '12x24', 4.90, 6, 11.50, 40],
      ["D'Caravista Summer", '12x24', 4.90, 6, 11.50, 40],
    ],
  },
  {
    name: 'Catavento', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Umber', '23x23', 11.40, 2, 7.50, 44]],
  },

  // ── Page 5: C-D ──
  {
    name: 'Coastal', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Ivory Glossy', '2.5x16', 5.90, 40, 11, 72],
      ['Silver Glossy', '2.5x16', 5.90, 40, 11, 72],
      ['Ash Glossy', '2.5x16', 5.90, 40, 11, 72],
    ],
    acc: [['Jolly', '5/8x16', 5.00]],
  },
  {
    name: 'Cortina', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['White Glossy', '3x12', 5.90, 44, 10.90, 80],
      ['White Matte', '3x12', 5.90, 44, 10.90, 80],
    ],
    acc: [['Jolly Glossy & Matte', '5/8x12', 5.00]],
  },
  {
    name: 'Creative Concrete', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Dark Grey', '18x36', 6.40, 3, 13.08, 30],
      ['Grey', '24x24', 5.40, 3, 11.63, 32],
      ['Grey', '12x24', 5.40, 5, 9.69, 48],
      ['Grey', '36x36', 6.40, null, null, null],
      ['Los Creacon Hexagonal', '24 hex', 14.40, 2, 6.32, 36],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Dalia', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [['Branco', '17x25', 9.40, 6, 17.76, 48]],
  },

  // ── Page 6: D-E ──
  {
    name: 'Decor White', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Coral', '13x40', 11.40, 3, 10.50, 56],
      ['Jazz', '13x40', 11.40, 3, 10.50, 56],
      ['Solene', '13x40', 11.40, 3, 10.50, 56],
    ],
  },
  {
    name: 'Domus', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Black Lappato', '6x36', 15.40, 8, 11.90, 40]],
  },
  {
    name: 'Drapeado', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Branco', '23x23', 11.40, 5, 18.30, 24],
      ['Corten', '23x23', 11.40, 2, 7.50, 48],
    ],
  },
  {
    name: 'Eclipse Beveled', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [['White Glossy & Matte', '4x12', 3.58, 40, 13.2, 72]],
    acc: [['Jolly Glossy & Matte', '5/8x12', 5.00]],
  },
  {
    name: 'Ellum Stone', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Matte', '12x24', 3.58, 8, 15.9, 40],
      ['Polished', '12x24', 3.58, 8, 15.9, 40],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },

  // ── Page 7: I-K ──
  {
    name: 'Ice White', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['White', '12x24', 5.40, 6, 11.90, 48],
      ['White', '30x30', 5.40, 3, 18.50, 30],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Impressions', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['White Star Polished', '12x12', 8.40, 11, 10.8, 56]],
    acc: [['Bullnose', '3x12', 20.00]],
  },
  {
    name: 'Korea', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['White', '13x40', 11.40, 4, 14, 48]],
  },

  // ── Page 8: L-M ──
  {
    name: 'Longo', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['White', '4x12', 11.40, 33, 11, 64],
      ['White', '12x24', 10.40, 8, 16, 40],
    ],
    acc: [
      ['Bullnose', '3x12', 14.00],
      ['Chevron Mesh Mounted', '11-5/8x12', 30.40],
      ['3" Hex Mosaic', '11-5/8x13-1/2', 26.40],
    ],
  },
  {
    name: 'Magnum', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['White Polished', '12x12', 8.40, 11, 11, 48],
      ['White Polished', '12x24', 4.40, 8, 16, 72],
      ['White Polished', '24x24', 4.40, 4, 16, 44],
      ['White Polished', '24x48', 5.00, 2, 16, 29],
      ['White Polished', '32x32', 5.40, 3, 21, 28],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Markina', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Bianco Indoor C-1', '24x48', 11.40, 2, 15.90, 32],
      ['Bianco Outdoor C-3', '24x48', 11.40, 2, 15.90, 32],
    ],
  },
  {
    name: 'Melanie', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Beige Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['Blue Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['Charcoal Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['Cotto Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['Green Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['Grey Glossy', '3x12', 8.10, 44, 10.90, 90],
      ['White Glossy', '3x12', 8.10, 44, 10.90, 90],
    ],
  },
  {
    name: 'Merc', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Perla', '24x24', 4.40, 4, 15.90, 30],
      ['Marengo', '24x48', 5.40, 2, 15.90, 32],
      ['Perla', '24x48', 5.40, 2, 15.90, 32],
    ],
    acc: [['Bullnose', '3x12', 16.00]],
  },
  {
    name: 'Montana White', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Glossy', '12x36', 5.40, 4, 11.62, 63],
      ['Matte', '12x36', 5.40, 4, 11.62, 63],
    ],
  },

  // ── Page 9: M-O ──
  {
    name: 'Morokko', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Zellige Blanco Picket', '2.5x8', 25.40, 72, 8, 60],
      ['Zellige Verde Picket', '2.5x8', 25.40, 72, 8, 60],
      ['Zellige Blanco Rectangular', '2.5x6.5', 19.40, 72, 8, 72],
      ['Zellige Verde Rectangular', '2.5x6.5', 19.40, 72, 8, 72],
    ],
  },
  {
    name: 'Nano', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Black Polished', '12x12', 13.40, 10, 10, 56],
      ['Black Polished', '12x24', 11.90, 8, 16, 40],
      ['Black Polished', '24x24', 11.90, 4, 16, 40],
      ['Black Polished', '24x48', 16.40, 2, 16, 48],
      ['Black Matte', '12x12', 13.40, 10, 10, 56],
      ['Black Matte', '12x24', 11.90, 8, 16, 40],
      ['Black Matte', '24x24', 11.90, 4, 16, 40],
      ['Black Matte', '24x48', 16.40, 2, 16, 48],
      ['White Polished', '12x12', 7.40, 11, 11, 56],
    ],
    acc: [
      ['Bullnose Polished/Matte', '4x24', 30.00],
      ['White NM05 Disco Mosaic', '2x2 sheet', 16.40],
      ['Black Mixed Textured HEX Mosaic', '3x3 sheet', 28.40],
    ],
  },
  {
    name: 'Nox', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Flat Glossy', '3x12', 4.10, 50, 12.4, 80],
      ['Flat Matte', '3x12', 4.90, 50, 12.4, 80],
      ['Undulated Straight Edge Glossy', '3x12', 6.90, 23, 5.70, 112],
      ['Undulated Straight Edge Matte', '3x12', 7.90, 23, 5.70, 112],
      ['Picket Undulated Glossy', '3x12', 8.30, 44, 10.40, 80],
      ['Picket Undulated Matte', '3x12', 8.90, 44, 10.40, 80],
    ],
    acc: [
      ['Covebase Glossy & Matte', '6x6', 3.38],
      ['Jolly Glossy & Matte', '5/8x12', 6.00],
      ['3" Hex Mosaic', '10-1/4x11-3/4 sheet', 9.90],
      ['1x3 Herringbone Mosaic', 'sheet', 9.40],
      ['2x8 Herringbone Mosaic', 'sheet', 10.40],
      ['1/2x3-3/4 Mosaic', '11x11-3/4 sheet', 12.40],
      ['Penny Round Mosaic', 'sheet', 9.40],
    ],
  },

  // ── Page 10: S ──
  {
    name: 'Sage', col: 'Unicorn Tile', cat: 'mosaic',
    unit: [
      // Square Mosaic 2x2
      ['Black Square 2x2', '12x12 sheet', 8.00],
      ['Smoke Square 2x2', '12x12 sheet', 8.00],
      ['White Square 2x2', '12x12 sheet', 8.00],
      ['Grey Square 2x2', '12x12 sheet', 8.00],
      // 2" Hex Mosaic
      ['Black 2" Hex', '12-3/4x11 sheet', 8.90],
      ['Smoke 2" Hex', '12-3/4x11 sheet', 8.90],
      ['White 2" Hex', '12-3/4x11 sheet', 8.90],
      ['Sand 2" Hex', '12-3/4x11 sheet', 8.90],
      ['Grey 2" Hex', '12-3/4x11 sheet', 8.90],
      ['Grey Mix 2" Hex', '12-3/4x11 sheet', 9.90],
      // 3" Hex Mosaic
      ['Black 3" Hex', '10-1/4x11-3/4 sheet', 11.90],
      ['Smoke 3" Hex', '10-1/4x11-3/4 sheet', 11.90],
      ['White 3" Hex', '10-1/4x11-3/4 sheet', 11.90],
      ['Grey 3" Hex', '10-1/4x11-3/4 sheet', 11.90],
    ],
  },
  {
    name: 'Sapporo', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [['White Matte', '12x24', 3.40, 5, 10, 84]],
    acc: [['Bullnose White Matte', '3x12', 14.00]],
  },

  // ── Page 11: S ──
  {
    name: 'Shades', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['White Glossy & Matte', '2x8', 4.38, 100, 10.9, 84],
      ['White Glossy & Matte', '3x6', 3.58, 136, 17, 60],
      ['White Glossy & Matte', '3x12', 3.58, 50, 12.4, 80],
      ['White Glossy & Matte', '4x12', 3.18, 40, 13.2, 72],
      ['White Glossy & Matte', '6x6', 3.58, 68, 17, 60],
      ['White Glossy & Matte', '8x24', 3.58, 12, 16, 64],
      ['Crema Glossy & Matte', '3x12', 4.18, 50, 12.4, 80],
      ['Latte Glossy & Matte', '3x12', 4.18, 50, 12.4, 80],
      ['Silver Glossy & Matte', '3x12', 4.18, 50, 12.4, 80],
    ],
    acc: [
      ['Jolly White 5/8x8', '5/8x8', 5.00],
      ['Jolly White 5/8x12', '5/8x12', 5.00],
      ['Jolly Crema Latte Silver', '5/8x12', 6.00],
      ['Bullnose Glossy', '3x12', 7.00],
      ['Covebase Glossy', '6x6', 2.58],
    ],
  },
  {
    name: 'Silom', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['White Glossy & Matte', '12x24', 2.98, 8, 15.9, 60],
      ['Etoile Glossy & Matte', '12x24', 3.98, 8, 15.9, 60],
      ['Leaf Glossy & Matte', '12x24', 3.98, 8, 15.9, 60],
      ['Renze Glossy & Matte', '12x24', 3.98, 8, 15.9, 60],
      ['Wave Glossy & Matte', '12x24', 3.98, 8, 15.9, 60],
    ],
    acc: [['White Bullnose Glossy & Matte', '3x12', 14.00]],
  },
  {
    name: 'Spectrum', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Calacatta Matte', '12x24', 3.58, 8, 15.90, 40],
      ['Calacatta Polished', '12x24', 3.58, 8, 15.90, 40],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Star Blue', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Blue', '23x23', 11.40, 5, 18.30, 30]],
  },

  // ── Page 12: S-V ──
  {
    name: 'Statuarietto', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['White Polished', '12x24', 5.40, 6, 11.90, 48],
      ['White Polished', '36x36', 7.40, 2, 17.90, 27],
      ['White Matte', '12x24', 5.40, 6, 11.90, 48],
      ['White Matte', '36x36', 7.40, 2, 17.90, 27],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Tokio', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Graphite', '24x24', 5.40, 3, 11.90, 48]],
  },
  {
    name: 'Track', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Blanco', '30x30', 6.50, 2, 12.16, 42]],
  },
  {
    name: 'Vinson', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [['Bianco Glossy', '12x24', 3.40, 5, 10, 84]],
    acc: [['Bullnose', '3x12', 14.00]],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DEER TILE (Pages 15-17)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'Aldo', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Beige Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Beige Matte', '24x24', 3.58, 5, 20, 36],
    ],
    acc: [['Bullnose Matte', '3x12', 14.00]],
  },
  {
    name: 'Andaz', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Beige Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Silver Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Beige Polished', '24x48', 4.38, 2, 15.9, 33],
    ],
    acc: [['Bullnose Matte', '3x12', 14.00]],
  },
  {
    name: 'Aspen', col: 'Deer Tile', cat: 'porcelain',
    tile: [['Polished', '24x24', 3.58, 4, 15.9, 40]],
  },
  {
    name: 'Athena', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Polished', '24x48', 4.38, 2, 15.9, 32],
    ],
  },
  {
    name: 'Ayer', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Polished', '24x24', 3.58, 4, 15.9, 40],
      ['Polished', '24x48', 4.38, 2, 15.9, 33],
    ],
    acc: [['Bullnose Matte Only', '3x12', 14.00]],
  },
  {
    name: 'Moda', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Dark Grey Matte', '12x24', 3.58, 8, 15.9, 48],
    ],
  },
  {
    name: 'Nebula', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Blanco Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Crema Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Silver Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Blanco Polished', '24x48', 4.38, 2, 15.9, 33],
      ['Crema Polished', '24x48', 4.38, 2, 15.9, 33],
    ],
  },
  {
    name: 'Nextar', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Beige Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Dark Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Nero Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Silver Matte', '12x24', 3.58, 8, 15.9, 48],
      ['White Matte', '12x24', 3.58, 8, 15.9, 48],
    ],
  },
  {
    name: 'Nimbus', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Beige Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Silver Matte', '12x24', 3.58, 8, 15.9, 48],
      ['White Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Beige Polished', '24x48', 4.38, 2, 15.9, 33],
      ['White Polished', '24x48', 4.38, 2, 15.9, 33],
    ],
  },
  {
    name: 'Nomad', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Beige Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Blanco Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Grey Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Nero Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Silver Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Blanco Matte', '24x24', 3.58, 4, 15.9, 40],
      ['Beige Matte', '24x24', 3.58, 4, 15.9, 40],
    ],
  },
  {
    name: 'Nova', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Blanco Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Crema Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Grigio Matte', '12x24', 3.58, 8, 15.9, 48],
      ['Blanco Polished', '24x48', 4.38, 2, 15.9, 33],
      ['Grigio Polished', '24x48', 4.38, 2, 15.9, 33],
      ['Crema Polished', '24x48', 4.38, 2, 15.9, 33],
      ['Blanco Matte', '24x48', 4.38, 2, 15.9, 33],
    ],
  },
  {
    name: 'Polished', col: 'Deer Tile', cat: 'porcelain',
    tile: [
      ['Creo', '24x48', 4.38, 2, 15.9, 32],
      ['Fantasia', '24x48', 4.38, 2, 15.9, 32],
    ],
  },
  {
    name: 'Satin', col: 'Deer Tile', cat: 'porcelain',
    tile: [['Nube', '24x48', 4.38, 2, 15.9, 32]],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT LOGIC
// ══════════════════════════════════════════════════════════════════════════════

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Upsert vendor ──
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Unicorn Tile Corp', 'UNICORN', 'https://unicorntiles.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Unicorn Tile Corp (${vendorId})`);

    let totalProducts = 0, totalSkus = 0, totalAccSkus = 0, totalPricing = 0, totalPkg = 0;

    for (const prod of PRODUCTS) {
      // ── Upsert product ──
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, prod.name, prod.col, CAT[prod.cat]]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      const allSkuIds = [];

      // ── Main tile SKUs (sold by sqft) ──
      if (prod.tile) {
        for (const [color, size, msrp, pcs, sqf, plt] of prod.tile) {
          const vendorSku = genSku(prod.col, prod.name, color, size);
          const internalSku = vendorSku;

          const skuRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'sqft', status = 'active'
            RETURNING id
          `, [productId, vendorSku, internalSku, `${color} ${size}`]);
          const skuId = skuRes.rows[0].id;
          allSkuIds.push(skuId);
          totalSkus++;

          // Pricing: cost = MSRP * 0.50, retail = MSRP
          const cost = (msrp * 0.50).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'sqft')
            ON CONFLICT (sku_id)
            DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [skuId, cost, msrp.toFixed(2)]);
          totalPricing++;

          // Packaging
          if (pcs && sqf) {
            await client.query(`
              INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, boxes_per_pallet)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (sku_id)
              DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box,
                           sqft_per_box = EXCLUDED.sqft_per_box,
                           boxes_per_pallet = EXCLUDED.boxes_per_pallet
            `, [skuId, pcs, sqf, plt]);
            totalPkg++;
          }

          // Size attribute
          await upsertAttr(client, skuId, 'size', size);
          // Color attribute
          const colorClean = color.replace(/ (Glossy|Matte|Polished|& Matte|& Glossy|Indoor|Outdoor|C-1|C-3|Lappato|Picket|Undulated|Flat|Straight Edge|Surface|Anti Slip).*$/i, '').trim();
          if (colorClean) await upsertAttr(client, skuId, 'color', colorClean);
        }
      }

      // ── Unit-priced SKUs (mosaics/glass sold per sheet/piece) ──
      if (prod.unit) {
        for (let i = 0; i < prod.unit.length; i++) {
          const [desc, size, msrp] = prod.unit[i];
          const vendorSku = genSku(prod.col, prod.name, desc, size);
          const internalSku = vendorSku;

          const skuRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'unit', status = 'active'
            RETURNING id
          `, [productId, vendorSku, internalSku, `${desc} ${size}`]);
          const skuId = skuRes.rows[0].id;
          allSkuIds.push(skuId);
          totalSkus++;

          const cost = (msrp * 0.50).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'unit')
            ON CONFLICT (sku_id)
            DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [skuId, cost, msrp.toFixed(2)]);
          totalPricing++;

          // Packaging for unit items (if provided)
          if (prod.unitPkg && prod.unitPkg[i]) {
            const [pcs, sqf, plt] = prod.unitPkg[i];
            await client.query(`
              INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, boxes_per_pallet)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (sku_id)
              DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box,
                           sqft_per_box = EXCLUDED.sqft_per_box,
                           boxes_per_pallet = EXCLUDED.boxes_per_pallet
            `, [skuId, pcs, sqf, plt]);
            totalPkg++;
          }

          await upsertAttr(client, skuId, 'size', size);
        }
      }

      // ── Accessories (sold per piece, variant_type = 'accessory') ──
      if (prod.acc) {
        for (const [desc, size, msrp] of prod.acc) {
          const vendorSku = genSku(prod.col, prod.name, desc, size);
          const internalSku = vendorSku;

          const skuRes = await client.query(`
            INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
            ON CONFLICT ON CONSTRAINT skus_internal_sku_key
            DO UPDATE SET variant_name = EXCLUDED.variant_name, sell_by = 'unit',
                         variant_type = 'accessory', status = 'active'
            RETURNING id
          `, [productId, vendorSku, internalSku, `${desc} ${size}`]);
          const skuId = skuRes.rows[0].id;
          totalAccSkus++;

          const cost = (msrp * 0.50).toFixed(2);
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'unit')
            ON CONFLICT (sku_id)
            DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
          `, [skuId, cost, msrp.toFixed(2)]);
          totalPricing++;

          await upsertAttr(client, skuId, 'size', size);
        }
      }

      const tileCount = (prod.tile || []).length;
      const unitCount = (prod.unit || []).length;
      const accCount = (prod.acc || []).length;
      console.log(`  ${prod.col} / ${prod.name}: ${tileCount + unitCount} SKUs + ${accCount} accessories`);
    }

    await client.query('COMMIT');
    console.log(`\n=== Import Complete ===`);
    console.log(`Products: ${totalProducts}`);
    console.log(`Tile/Unit SKUs: ${totalSkus}`);
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

// ── Attribute helper ──
const ATTR_IDS = {
  color: 'd50e8400-e29b-41d4-a716-446655440001',
  size:  'd50e8400-e29b-41d4-a716-446655440004',
};
async function upsertAttr(client, skuId, attrSlug, value) {
  const attrId = ATTR_IDS[attrSlug];
  if (!attrId) return;

  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id)
    DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

run().catch(err => { console.error(err); process.exit(1); });
