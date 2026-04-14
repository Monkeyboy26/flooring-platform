#!/usr/bin/env node
/**
 * Import SLCC Flooring — Full Catalog
 *
 * Source: SLCC 2025 Price List (Q3), effective 07/17/2025
 * Brands: SLCC Flooring, Céleste Floors, SLCC Commercial
 * Types: Engineered Hardwood, SPC, WPC, Laminate, Solid Hardwood, Glue Down LVT
 *
 * Features:
 *   - Creates products, SKUs, pricing, packaging for all collections
 *   - Attaches molding accessories to each flooring product by type/thickness
 *
 * Usage: docker compose exec api node scripts/import-slcc.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Category IDs from DB
const CAT = {
  eng:     '650e8400-e29b-41d4-a716-446655440021', // Engineered Hardwood
  solid:   '650e8400-e29b-41d4-a716-446655440022', // Solid Hardwood
  lvp:     '650e8400-e29b-41d4-a716-446655440031', // LVP (Plank) — SPC/WPC
  laminate:'a50e8400-e29b-41d4-a716-446655440201', // Laminate Flooring
  lvt:     '650e8400-e29b-41d4-a716-446655440030', // Luxury Vinyl — Glue Down LVT
};

// ============ MOLDING ACCESSORIES BY FLOORING TYPE ============
// [suffix, name, costPerPiece]
const MOLDINGS = {
  'eng-thin': [ // 3/8", 1/2" 2mm wood flooring — 7'10" length
    ['FSN', 'Flush Stair Nose, 7\'10"', 70],
    ['TM',  'T-Molding, 7\'10"', 55],
    ['EC',  'End Cap, 7\'10"', 55],
    ['RD',  'Reducer, 7\'10"', 55],
    ['QR',  'Quarter Round, 7\'10"', 32],
  ],
  'eng-thick': [ // 5/8", 9/16" 3-4mm wood flooring — 7'10" length
    ['FSN', 'Flush Stair Nose, 7\'10"', 85],
    ['TM',  'T-Molding, 7\'10"', 65],
    ['EC',  'End Cap, 7\'10"', 65],
    ['RD',  'Reducer, 7\'10"', 65],
  ],
  'solid': [ // 3/4" Solid, 3mm wood flooring — 7'10" length
    ['FSN', 'Flush Stair Nose, 7\'10"', 75],
    ['TM',  'T-Molding, 7\'10"', 60],
    ['EC',  'End Cap, 7\'10"', 60],
    ['RD',  'Reducer, 7\'10"', 60],
  ],
  'spc-wpc': [ // Luxury WPC / SPC — 7'10" length
    ['OSN', 'Overlap Stair Nose, 7\'10"', 25],
    ['FSN', 'Flush Stair Nose, 7\'10"', 29],
    ['TM',  'T-Molding, 7\'10"', 20],
    ['EC',  'End Cap, 7\'10"', 20],
    ['RD',  'Reducer, 7\'10"', 20],
    ['QR',  'Quarter Round, 7\'10"', 8],
  ],
  'laminate': [ // Standard Laminate — 7'10" length
    ['OSN', 'Overlap Stair Nose, 7\'10"', 13],
    ['FSN', 'Flush Stair Nose, 7\'10"', 15],
    ['TM',  'T-Molding, 7\'10"', 11],
    ['EC',  'End Cap, 7\'10"', 11],
    ['RD',  'Reducer, 7\'10"', 11],
  ],
  'laminate-wp': [ // Waterproof Laminate — 7'10" length
    ['OSN', 'Overlap Stair Nose, 7\'10"', 25],
    ['FSN', 'Flush Stair Nose, 7\'10"', 29],
    ['TM',  'T-Molding, 7\'10"', 19],
    ['EC',  'End Cap, 7\'10"', 19],
    ['RD',  'Reducer, 7\'10"', 19],
    ['QR',  'Quarter Round, 7\'10"', 10],
  ],
  'lvt': [ // Glue Down LVT
    ['TH', 'Threshold, 94"', 19],
  ],
};

// ============ PRODUCT DATA ============
// Format: [collection, catKey, moldingTier, groups]
// groups: [[size, sqftPerBox, lbPerBox, pricePerSqft, pcsPerBox|null, [[itemCode, colorName, species], ...]]]

const COLLECTIONS = [
  // ==================== ENGINEERED HARDWOOD (SLCC) ====================
  ['Preserve Collection', 'eng', 'eng-thin', [
    ['1/2" x 4-1/2" x 4\' RL (2mm)', 32.55, 52, 4.29, null, [
      ['E-EP-FH', 'Forest House', 'Acacia'],
      ['E-EP-WN', 'Wild Nutmeg', 'Acacia'],
      ['E-EP-RW', 'River Walnut', 'Acacia'],
      ['E-EP-CH', 'Cider House', 'Acacia'],
    ]],
    ['1/2" x 5" x 4\' RL (2mm)', 19.69, 32, 3.99, null, [
      ['E-EP-CS', 'Cartwheel', 'Oak'],
      ['E-EP-LE', 'Lunar Eclipse', 'Oak'],
      ['E-EP-F5', 'Forest Castle', 'Oak'],
    ]],
  ]],

  ['Van Gogh Collection', 'eng', 'eng-thin', [
    ['1/2" x 6\' x 5\' RL (2mm)', 27.55, 49, 2.79, null, [
      ['E-VG-BDIS-S6', 'Sunflowers', 'Birch'],
    ]],
  ]],

  ['Pacific Coast Collection', 'eng', 'eng-thin', [
    ['3/8" x 5" x 4\' RL (2mm)', 19.68, 25, 2.89, null, [
      ['E-VA-N3', 'Monterey Beach', 'Birch'],
      ['E-VA-N4', 'Santa Barbara Beach', 'Birch'],
    ]],
    ['3/8" x 5" x 4\' RL (1.5mm)', 34.45, 44, 3.09, null, [
      ['E-VA-N8', 'Santa Cruz', 'Oak'],
      ['E-VA-N9', 'Santa Rosa', 'Oak'],
      ['E-VA-N12', 'Santa Luz', 'Oak'],
    ]],
    ['3/8" x 5" x 4\' RL (1.5mm)', 19.68, 25, 3.19, null, [
      ['E-VA-N10', 'Santa Maria', 'Maple'],
      ['E-VA-N11', 'San Rafael', 'Maple'],
      ['E-VA-N13', 'San Mateo', 'Maple'],
    ]],
  ]],

  ['Westwind Collection', 'eng', 'eng-thin', [
    ['3/8" x 5" x 4\' RL (1.5mm)', 34.45, 40, 3.09, null, [
      ['E-VA-N21', 'Laredo', 'Oak'],
      ['E-VA-N22', 'Lockhart', 'Oak'],
      ['E-VA-N23', 'Vernon', 'Oak'],
    ]],
    ['3/8" x 5" x 4\' RL (1.5mm)', 19.68, 25, 3.09, null, [
      ['E-VA-N19', 'Gruene', 'Maple'],
      ['E-VA-N20', 'Hillsboro', 'Maple'],
    ]],
    ['3/8" x 3", 5", 7" x 4\' RL (1.5mm)', 19.68, 25, 3.09, null, [
      ['E-VA-N14', 'Amarillo', 'Acacia'],
      ['E-VA-N15', 'Archer City', 'Acacia'],
      ['E-VA-N16', 'Dublin', 'Acacia'],
      ['E-VA-N17', 'Ennis', 'Acacia'],
    ]],
    ['3/8" x 4", 5", 6" x 4\' RL (1.5mm)', 19.68, 25, 3.09, null, [
      ['E-VA-N24', 'Marfa', 'Hickory'],
      ['E-VA-N25', 'Menard', 'Hickory'],
      ['E-VA-N26', 'Odessa', 'Hickory'],
      ['E-VA-N27', 'Pecos', 'Hickory'],
    ]],
    ['3/8" x 5" x 4\' RL (2mm)', 19.68, 25, 2.89, null, [
      ['E-VA-N28', 'Poteet', 'Birch'],
      ['E-VA-N29', 'Rainbow', 'Birch'],
      ['E-VA-N30', 'Round Top', 'Birch'],
      ['E-VA-N31', 'Shiner', 'Birch'],
      ['E-VA-N32', 'Turkey', 'Birch'],
    ]],
  ]],

  ['Westwind Premium Collection', 'eng', 'eng-thin', [
    ['3/8" x 7-1/2" x 7\' RL (1.5mm)', 34.36, 45, 3.49, null, [
      ['E-VA-N33', 'Isabel', 'Hickory'],
      ['E-VA-N34', 'Liano', 'Hickory'],
      ['E-VA-N35', 'Bandera', 'European Oak'],
      ['E-VA-N36', 'Rockport', 'European Oak'],
      ['E-VA-N37', 'Luckenbach', 'European Oak'],
      ['E-VA-N38', 'Wimberley', 'European Oak'],
      ['E-VA-N39', 'Strawn', 'European Oak'],
      ['E-VA-N40', 'Bastrop', 'European Oak'],
    ]],
  ]],

  // ==================== ENGINEERED HARDWOOD (CÉLESTE) ====================
  ['Villa Collection', 'eng', 'eng-thick', [
    ['9/16" x 9-1/2" x 7\' RL (4mm)', 34.11, 67, 7.49, null, [
      ['E-VC-OCHE-CH', 'Chaumont', 'European Oak'],
      ['E-VC-OCHE-BE', 'Brightline Estates', 'European Oak'],
      ['E-VC-OCHE-BO', 'Bordeaux', 'European Oak'],
      ['E-VC-OCHE-BT', 'Bastia', 'European Oak'],
      ['E-VC-OCHE-PN', 'Pyrenees', 'European Oak'],
      ['E-VC-OCHE-NT', 'Nantes', 'European Oak'],
      ['E-VC-OCHE-CB', 'Chambers', 'European Oak'],
      ['E-VC-OCHE-CS', 'Cassinello', 'European Oak'],
      ['E-VC-OCHE-VA', 'Valence', 'European Oak'],
      ['E-VC-OCHE-FR', 'Frascati', 'European Oak'],
      ['E-VC-OCHE-CT', 'Carlotta', 'European Oak'],
      ['E-VC-OCHE-ST', 'Strasburg', 'European Oak'],
    ]],
  ]],

  ['Villa Collection Herringbone', 'eng', 'eng-thick', [
    ['5/8" x 6" x 3\' (3mm)', 11.63, 23, 7.49, null, [
      ['E-VC-OCHE-CHH', 'Chaumont', 'European Oak'],
      ['E-VC-OCHE-BOO', 'Bordeaux', 'European Oak'],
      ['E-VC-OCHE-BTT', 'Bastia', 'European Oak'],
      ['E-VC-OCHE-PNN', 'Pyrenees', 'European Oak'],
      ['E-VC-OCHE-CBB', 'Chambers', 'European Oak'],
      ['E-VC-OCHE-VAA', 'Valence', 'European Oak'],
    ]],
  ]],

  ['Villa Collection Parquet AB', 'eng', 'eng-thick', [
    ['5/8" x 31-1/2" x 31-1/2" (3mm)', 27.56, 14, 12.99, 4, [
      ['E-VC-OCHE-PNP-AB', 'Pyrenees', 'European Oak'],
      ['E-VC-OCHE-NTP-AB', 'Nantes', 'European Oak'],
      ['E-VC-OCHE-CBP-AB', 'Chambers', 'European Oak'],
    ]],
  ]],

  ['Villa Collection Parquet ABCD', 'eng', 'eng-thick', [
    ['5/8" x 31-1/2" x 31-1/2" (3mm)', 27.56, 14, 8.99, 4, [
      ['E-VC-OCHE-PNP-ABCD', 'Pyrenees', 'European Oak'],
      ['E-VC-OCHE-NTP-ABCD', 'Nantes', 'European Oak'],
      ['E-VC-OCHE-CBP-ABCD', 'Chambers', 'European Oak'],
    ]],
  ]],

  ['Milky Way Collection', 'eng', 'eng-thick', [
    ['9/16" x 7-1/2" x 6\' RL (4mm)', 31.09, 58, 5.39, null, [
      ['E-MW-OSOM-M5', 'Mercury', 'European Oak'],
      ['E-MW-OSOM-J5', 'Jupiter', 'European Oak'],
    ]],
    ['5/8" x 7-1/2" x 6\' RL (3mm)', 23.31, 45, 5.39, null, [
      ['E-MW-OWID-CO', 'Cosmic', 'European Oak'],
      ['E-MW-OWID-DA', 'Daphnis', 'European Oak'],
      ['E-MW-OWID-MO', 'Moonshadow', 'European Oak'],
    ]],
    ['5/8" x 7-1/2" x 6\' RL (3mm)', 23.31, 45, 5.59, null, [
      ['E-MW-OWID-CA', 'Callisto', 'European Oak'],
      ['E-MW-OWID-CE', 'Celestial', 'European Oak'],
    ]],
    ['5/8" x 9-1/2" x RL (up to 86-5/8")', 22.73, 43, 4.99, null, [
      ['E-MW-OWID-FR', 'Fish River Canyon', 'European Oak'],
    ]],
    ['9/16" x 9-1/2" x 7\' RL (4mm)', 34.11, 64, 5.99, null, [
      ['E-MW-OWID-LU', 'Lumiere', 'European Oak'],
      ['E-MW-OWID-AU', 'Aurora', 'European Oak'],
      ['E-MW-OWID-P5', 'Pluto', 'European Oak'],
      ['E-MW-OWID-N5', 'Neptune', 'European Oak'],
      ['E-MW-OWID-NL', 'Northern Lights', 'European Oak'],
      ['E-MW-OWID-SS', 'Saturn', 'European Oak'],
    ]],
    ['5/8" x 9-1/2" x 7\' RL (4mm)', 34.11, 68, 6.99, null, [
      ['E-MW-OWID-GE', 'Gemini', 'European Oak'],
      ['E-MW-OWID-LI', 'Libra', 'European Oak'],
      ['E-MW-OWID-KB', 'Kyber', 'European Oak'],
      ['E-MW-OWID-GL', 'Galio', 'European Oak'],
      ['E-MW-OWID-LN', 'Lumin', 'European Oak'],
    ]],
    ['9/16" x 8-7/10" x 7\' RL (3mm)', 31.26, 58, 7.49, null, [
      ['E-MW-OWID-HE', 'Helios', 'Walnut'],
    ]],
  ]],

  ['Milky Way Collection Herringbone', 'eng', 'eng-thick', [
    ['5/8" x 6" x 3\' (3mm)', 11.63, 23, 5.99, null, [
      ['E-MW-OWID-AUU', 'Aurora', 'European Oak'],
    ]],
    ['5/8" x 6" x 3\' (3mm)', 11.63, 23, 7.49, null, [
      ['E-MW-OWID-HEE', 'Helios', 'Walnut'],
    ]],
  ]],

  ['Karuna Collection', 'eng', 'eng-thin', [
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 22.85, 37, 4.39, null, [
      ['E-KC-UP', 'Upenda', 'Oak Lt Brushed'],
      ['E-KC-LA', 'Laska', 'Oak Lt Brushed'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (1.2mm)', 23.32, 41, 4.19, null, [
      ['E-KC-PP', 'Pacific Palisades', 'Oak'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 39, 4.19, null, [
      ['E-KC-EV', 'Evin', 'Oak'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (1.5mm)', 23.32, 39, 4.69, null, [
      ['E-KC-TR', 'Tresna', 'Walnut'],
    ]],
    ['1/2" x 7-1/2" x 7\' RL (2mm)', 34.36, 54, 4.39, null, [
      ['E-KC-LI', 'Lief', 'Euro Oak Lt Brushed'],
      ['E-KC-GA', 'Gaol', 'Maple 3D Distress'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 39, 4.39, null, [
      ['E-KC-AL', 'Aloha', 'Maple 3D Distress'],
      ['E-KC-ME', 'Melle', 'Maple 3D Distress'],
      ['E-KC-RA', 'Rakkaus', 'Maple 3D Distress'],
      ['E-KC-AM', 'Amore', 'Maple 3D Distress'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 38, 4.49, null, [
      ['E-KC-RU', 'Rumi', 'Maple'],
      ['E-KC-PH', 'Phileo', 'Maple'],
      ['E-KC-EL', 'Elska', 'Maple'],
      ['E-KC-PR', 'Priti', 'Maple'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 41, 4.59, null, [
      ['E-KC-EA', 'Ezra', 'Maple'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 41, 4.59, null, [
      ['E-KC-CR', 'Metro', 'Hickory'],
    ]],
    ['1/2" x 7-1/2" x 6\' RL (2mm)', 23.32, 38, 4.59, null, [
      ['E-KC-TO', 'Tano', 'Hickory'],
    ]],
    ['1/2" x 7-1/2" x 7\' RL (1.5mm)', 25.77, 38, 4.79, null, [
      ['E-KC-JS', 'Jarrus', 'European Oak'],
      ['E-KC-KT', 'Kestis', 'European Oak'],
    ]],
  ]],

  // ==================== SPC FLOORING ====================
  ['Borrowed Scenery Collection', 'lvp', 'spc-wpc', [
    ['5mm (4mm+1mm IXPE) x 7" x 48"', 29.07, 51, 2.39, 12, [
      ['X-BS-TP', 'Tanned Palms', 'SPC'],
      ['X-BS-CS', 'Crushed Sand', 'SPC'],
      ['X-BS-GV', 'Garden Vista', 'SPC'],
      ['X-BS-WL', 'Water Lilie', 'SPC'],
      ['X-BS-GD', 'Golden Desert', 'SPC'],
      ['X-BS-WB', 'West Bay', 'SPC'],
      ['X-BS-RP', 'Rum Point', 'SPC'],
      ['X-BS-EE', 'East End', 'SPC'],
      ['X-BS-SB', 'Stoke Bay', 'SPC'],
      ['X-BS-CI', 'Citron', 'SPC'],
    ]],
  ]],

  ['Treasure Lakes Collection', 'lvp', 'spc-wpc', [
    ['7mm (5mm SPC+2mm EVA) x 9" x 60"', 30.11, 64.44, 2.99, 8, [
      ['X-TL-TE', 'Tenaya', 'SPC'],
      ['X-TL-SN', 'Snyder', 'SPC'],
      ['X-TL-PO', 'Poudre', 'SPC'],
      ['X-TL-KI', 'Kintla', 'SPC'],
      ['X-TL-JO', 'Josephine', 'SPC'],
      ['X-TL-IC', 'Iceberg', 'SPC'],
      ['X-TL-EM', 'Emerald', 'SPC'],
      ['X-TL-CR', 'Crater', 'SPC'],
      ['X-TL-CA', 'Cathedral', 'SPC'],
      ['X-TL-BE', 'Berryessa', 'SPC'],
      ['X-TL-CO', 'Caddo', 'SPC'],
      ['X-TL-TA', 'Tahoe', 'SPC'],
    ]],
  ]],

  ['Treasure Lakes Herringbone', 'lvp', 'spc-wpc', [
    ['7mm x 25" x 5" (2.0mm EVA)', 12.16, 26.01, 3.29, null, [
      ['X-TL-CRR', 'Crater', 'SPC'],
      ['X-TL-JOO', 'Josephine', 'SPC'],
      ['X-TL-BEE', 'Berryessa', 'SPC'],
    ]],
  ]],

  ['Painted Sky Collection', 'lvp', 'spc-wpc', [
    ['7mm (5mm SPC+2mm EVA) x 9-1/4" x 72"', 27.78, 61.1, 3.29, 6, [
      ['X-PS-AL', 'Alba', 'SPC'],
      ['X-PS-DA', 'Daybreak', 'SPC'],
      ['X-PS-SP', 'Spectacle', 'SPC'],
      ['X-PS-SU', 'Sunrise', 'SPC'],
      ['X-PS-RD', 'Rosy Dawn', 'SPC'],
      ['X-PS-DS', 'Del Sol', 'SPC'],
      ['X-PS-ME', 'Merriment', 'SPC'],
      ['X-PS-LA', 'Lumina', 'SPC'],
      ['X-PS-LU', 'Luz', 'SPC'],
      ['X-PS-BR', 'Brillo', 'SPC'],
    ]],
  ]],

  ['Painted Sky Herringbone', 'lvp', 'spc-wpc', [
    ['7mm x 25" x 5" (2.0mm EVA)', 12.16, 26.01, 3.59, null, [
      ['X-PS-ALL', 'Alba', 'SPC'],
      ['X-PS-DAA', 'Daybreak', 'SPC'],
      ['X-PS-SPP', 'Spectacle', 'SPC'],
      ['X-PS-SUU', 'Sunrise', 'SPC'],
      ['X-PS-RDD', 'Rosy Dawn', 'SPC'],
    ]],
  ]],

  ['Aquarius Collection', 'lvp', 'spc-wpc', [
    ['5mm (4mm+1mm IXPE) x 7" x 48"', 18.91, 33, 1.99, 8, [
      ['X-AQU-23995', 'Natural Hickory', 'SPC'],
      ['X-AQU-24005', 'French Oak', 'SPC'],
      ['X-AQU-24015', 'Masters Taupe', 'SPC'],
      ['X-AQU-24025', 'Lady Grey', 'SPC'],
      ['X-AQU-1425', 'Cascade', 'SPC'],
      ['X-AQU-1435', 'Sweet Vanilla', 'SPC'],
      ['X-AQU-1445', 'Canyon Trails', 'SPC'],
    ]],
  ]],

  // ==================== WPC FLOORING ====================
  ['Cayman Collection', 'lvp', 'spc-wpc', [
    ['5.5mm x 7.13" x 48"', 33.3, 47.4, 2.59, null, [
      ['W-CC-EE', 'East End', 'WPC'],
    ]],
  ]],

  ['La Salle Collection', 'lvp', 'spc-wpc', [
    ['6.5mm x 7.13" x 60.2"', 29.8, 48.5, 2.79, null, [
      ['W-LS-JE', 'Jefferson', 'WPC'],
    ]],
  ]],

  ['Arcadian Collection', 'lvp', 'spc-wpc', [
    ['7.5mm (6.5mm+1mm IXPE) x 7.13" x 72"', 28.21, 45.42, 3.19, null, [
      ['W-AC-BR', 'Brittia', 'WPC'],
      ['W-AC-CA', 'Camelot', 'WPC'],
      ['W-AC-OL', 'Olympus', 'WPC'],
      ['W-AC-AT', 'Atlantis', 'WPC'],
      ['W-AC-ED', 'Eden', 'WPC'],
    ]],
  ]],

  ['Provincial Collection', 'lvp', 'spc-wpc', [
    ['8.5mm (7.5mm+1mm IXPE) x 7.13" x 72"', 28.21, 51.6, 2.99, null, [
      ['W-PR-CA', 'Calico', 'WPC'],
      ['W-PR-BO', 'Bodie', 'WPC'],
      ['W-PR-JE', 'Jerome', 'WPC'],
    ]],
    ['13mm (11mm+2mm IXPE) x 9" x 60"', 22.5, 55, 3.79, null, [
      ['W-PR-AL', 'Altelas', 'WPC'],
      ['W-PR-DA', 'Davis', 'WPC'],
      ['W-PR-GE', 'Geneva', 'WPC'],
      ['W-PR-BR', 'Brandy', 'WPC'],
      ['W-PR-BZ', 'Breezy', 'WPC'],
      ['W-PR-TD', 'Thonder', 'WPC'],
      ['W-PR-CD', 'Candy', 'WPC'],
    ]],
  ]],

  ['Provincial Supreme Collection', 'lvp', 'spc-wpc', [
    ['15mm (13mm+2mm IXPE) x 8.86" x 72"', 22.17, 63, 4.19, 5, [
      ['W-PR-NP', 'Napa', 'WPC'],
      ['W-PR-SM', 'Sonoma', 'WPC'],
      ['W-PR-MT', 'Monterey', 'WPC'],
      ['W-PR-PB', 'Paso Robles', 'WPC'],
      ['W-PR-SH', 'Saint Helens', 'WPC'],
    ]],
  ]],

  ['Venetian Collection', 'lvp', 'spc-wpc', [
    ['6.5mm x 12" x 24"', 36.05, 52, 2.89, null, [
      ['W-VC-BA', 'Basilica', 'WPC'],
      ['W-VC-CA', 'Castillo', 'WPC'],
    ]],
  ]],

  // ==================== LAMINATE FLOORING ====================
  ['Pacific Vineyard Collection', 'laminate', 'laminate-wp', [
    ['1/2" x 7-1/2" x 4\'', 25.77, 55.47, 2.79, null, [
      ['L-PV-AR', 'Arroyo', 'Oak'],
      ['L-PV-BV', 'Bella Victorian', 'Oak'],
      ['L-PV-CA', 'Corto Oaks', 'Oak'],
      ['L-PV-CL', 'Carellia', 'Oak'],
      ['L-PV-PM', 'Promontory', 'Oak'],
    ]],
    ['1/2" x 7.67" x 71.85"', 22.98, 50.7, 2.79, null, [
      ['L-PV-AB', 'Abeja', 'Oak'],
      ['L-PV-AS', 'Artesa', 'Oak'],
      ['L-PV-HY', 'Hyde', 'Oak'],
      ['L-PV-ID', 'Idlewild', 'Oak'],
      ['L-PV-KN', 'Kiona', 'Oak'],
    ]],
  ]],

  ['Harmony Collection', 'laminate', 'laminate', [
    ['1/2" x 5.75" x 4\'', 18.97, 43, 1.99, null, [
      ['L-HC-AP', 'Apex', 'Oak'],
      ['L-HC-BL', 'Bliss', 'Oak'],
    ]],
    ['1/2" x 6.5" x 4\'', 19.43, 44, 1.99, null, [
      ['L-HC-EU', 'Euphoria', 'Oak'],
      ['L-HC-LE', 'Levity', 'Oak'],
    ]],
  ]],

  ['Island Collection', 'laminate', 'laminate', [
    ['1/2" x 7.5" x 4\'', 20.4, 44, 2.19, null, [
      ['L-IC-RI', 'Rippleside', 'Maple'],
      ['L-IC-SC', 'Seacrest', 'Maple'],
      ['L-IC-SE', 'Seahome', 'Maple'],
      ['L-IC-OG', 'Ocean Glory', 'Maple'],
      ['L-IC-GR', 'Gracemere', 'Maple'],
    ]],
  ]],

  ['Mediterranean Collection', 'laminate', 'laminate', [
    ['1/2" x 7.5" x 6\'', 22.86, 52.9, 2.29, null, [
      ['L-MC-CO', 'Corsica', 'Oak'],
      ['L-MC-FI', 'Figari', 'Oak'],
      ['L-MC-SA', 'Sardinia', 'Oak'],
      ['L-MC-MA', 'Malta', 'Oak'],
      ['L-MC-PA', 'Palermo', 'Oak'],
      ['L-MC-NA', 'Napoli', 'Oak'],
      ['L-MC-GE', 'Genoa', 'Oak'],
    ]],
  ]],

  ['Preservation Collection Herringbone', 'laminate', 'laminate', [
    ['1/2" x 3-3/4" x 18-1/2"', 17.3, 37.48, 2.59, null, [
      ['L-PC-SF', 'Sante Fe', 'Oak'],
      ['L-PC-BH', 'Beacon Hill', 'Oak'],
      ['L-PC-OC', 'Old City', 'Oak'],
      ['L-PC-LC', 'La Crosse', 'Oak'],
      ['L-PC-LR', 'Little Rock', 'Oak'],
    ]],
  ]],

  ['Preservation Collection Straight', 'laminate', 'laminate', [
    ['1/2" x 3-3/4" x 48"', 24.86, 54, 2.59, null, [
      ['L-PC-SFF', 'Sante Fe', 'Oak'],
      ['L-PC-BHH', 'Beacon Hill', 'Oak'],
      ['L-PC-OCC', 'Old City', 'Oak'],
    ]],
    ['1/2" x 5" x 48"', 19.94, 42, 2.59, null, [
      ['L-PC-LCC', 'La Crosse', 'Oak'],
      ['L-PC-LRR', 'Little Rock', 'Oak'],
    ]],
  ]],

  // ==================== SOLID HARDWOOD ====================
  ['Solids Hardwood Collection', 'solid', 'solid', [
    ['3/4" x 5" x RL', 19.38, 55, 5.29, null, [
      ['S-MOO-01', 'Moonya', 'Oak'],
      ['S-ADO-01', 'Adori', 'Oak'],
      ['S-MER-01', 'Merindah', 'Oak'],
    ]],
    ['3/4" x 4-3/4" x 12"-48" RL', 21.7, 55, 5.29, null, [
      ['S-SIE-01', 'Sienna', 'Maple'],
      ['S-MOO-02', 'Modena', 'Maple'],
      ['S-ADI-01', 'Adina', 'Maple'],
      ['S-MAR-01', 'Marlee', 'Maple'],
    ]],
    ['3/4" x 4-3/4" x RL', 18.6, 43, 5.19, null, [
      ['S-RAN-01', 'Rangal', 'Acacia'],
    ]],
    ['3/4" x 3-1/2", 4-3/4" (mixed) x 12"-48" RL', 20.35, 60, 5.89, null, [
      ['S-FAI-01', 'Fairbanks', 'Oak'],
      ['S-KEN-01', 'Kenna', 'Oak'],
      ['S-BAR-01', 'Barrow', 'Oak'],
    ]],
    ['3/4" x 3-1/2", 4-3/4" (mixed) x 12"-48" RL', 24.07, 45, 5.79, null, [
      ['S-COR-01', 'Cordova', 'Acacia'],
      ['S-YUK-01', 'Yukon', 'Acacia'],
    ]],
    ['3/4" x 4-3/4" x RL', 18.6, 55, 5.59, null, [
      ['S-DAN-01', 'Dandaloo', 'Semo Mahogany'],
    ]],
    ['3/4" x 4-3/4" x 48"-72" RL', 22.01, 70, 6.19, null, [
      ['S-CAR-01', 'Caryo', 'Hickory'],
    ]],
    ['3/4" x 4.85" x 48"-72" RL', 22.56, 66, 6.19, null, [
      ['S-CER-01', 'Cereja', 'Brazilian Cherry'],
    ]],
    ['3/4" x 4.85" x 48"-72" RL', 22.56, 80, 5.39, null, [
      ['S-DUR-01', 'Duro', 'Brazilian Oak'],
    ]],
    ['3/4" x 3-1/2", 4-3/4" (mixed) x 12"-48" RL', 24.07, 54, 5.79, null, [
      ['S-CND-01', 'Cinder', 'Acacia'],
      ['S-ELD-01', 'Elden', 'Acacia'],
    ]],
  ]],

  // ==================== GLUE DOWN LVT ====================
  ['Prime Specimens Collection', 'lvt', 'lvt', [
    ['6" x 48" x 2.5mm', 46.00, 45.3, 1.49, null, [
      ['D-SC-AL', 'Alba', 'Sleek Woods'],
      ['D-SC-DA', 'Daybreak', 'Sleek Woods'],
      ['D-SC-SP', 'Spectacle', 'Sleek Woods'],
      ['D-SC-TA', 'Tahoe', 'Sleek Woods'],
      ['D-SC-RD', 'Rosy Dawn', 'Sleek Woods'],
      ['D-SC-DS', 'Del Sol', 'Sleek Woods'],
      ['D-SC-ME', 'Merriment', 'Sleek Woods'],
      ['D-SC-LU', 'Luz', 'Sleek Woods'],
      ['D-SC-SU', 'Sunrise', 'Sleek Woods'],
    ]],
    ['12" x 24" x 2.5mm', 47.86, 47.8, 1.49, null, [
      ['D-SC-AB', 'Alabaster', 'Modern Marble'],
      ['D-SC-PG', 'Palace Gray', 'Modern Marble'],
      ['D-SC-ON', 'Onyx', 'Modern Marble'],
    ]],
    ['18" x 36" x 2.5mm', 47.86, 47.8, 1.49, null, [
      ['D-SC-SD', 'Sand', 'Creme De La Crete'],
      ['D-SC-PE', 'Pewter', 'Creme De La Crete'],
      ['D-SC-ST', 'Stone', 'Creme De La Crete'],
    ]],
  ]],

  ['Project Plus Collection', 'lvt', 'lvt', [
    ['7" x 48" x 2.0mm', 46.72, 36, 1.05, 20, [
      ['D-PP-1201', 'Whisper Grey', 'LVT'],
      ['D-PP-1202', 'Greystone', 'LVT'],
      ['D-PP-1203', 'Brown Sawn', 'LVT'],
      ['D-PP-1204', 'Smoked Charcoal', 'LVT'],
      ['D-PP-1205', 'Rustic Hickory', 'LVT'],
      ['D-PP-1206', 'Golden Oak', 'LVT'],
      ['D-PP-1207', 'Cinnamon Oak', 'LVT'],
      ['D-PP-1208', 'All Spice', 'LVT'],
    ]],
  ]],
];

// ============ UPSERT HELPERS ============

async function upsertVendor() {
  const r = await pool.query(`
    INSERT INTO vendors (code, name, website)
    VALUES ('SLCC', 'SLCC Flooring', 'https://www.slccflooring.com')
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      website = EXCLUDED.website
    RETURNING id
  `);
  return r.rows[0].id;
}

async function upsertProduct(vendorId, { name, collection, categoryId }) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status)
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
    DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, name, collection, categoryId]);
  return r.rows[0];
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType }) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = EXCLUDED.vendor_sku,
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = EXCLUDED.sell_by,
      variant_type = EXCLUDED.variant_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName, sellBy, variantType || null]);
  return r.rows[0];
}

async function upsertPricing(skuId, cost, retail, priceBasis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retail, priceBasis]);
}

async function upsertPackaging(skuId, { sqftPerBox, pcsPerBox, lbPerBox }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, weight_per_box_lbs)
    VALUES ($1, $2, $3, NULL, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs)
  `, [skuId, sqftPerBox, pcsPerBox || null, lbPerBox]);
}

async function upsertAttribute(skuId, attrName, attrValue) {
  // Get or create attribute
  let attrRes = await pool.query(`SELECT id FROM attributes WHERE name = $1`, [attrName]);
  if (!attrRes.rows.length) {
    attrRes = await pool.query(
      `INSERT INTO attributes (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [attrName, attrName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
    );
  }
  const attrId = attrRes.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, attrValue]);
}

// ============ MAIN ============

async function main() {
  const vendorId = await upsertVendor();
  console.log(`Vendor SLCC: ${vendorId}\n`);

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;
  let accessoriesCreated = 0;

  for (const [collection, catKey, moldingTier, groups] of COLLECTIONS) {
    const categoryId = CAT[catKey];
    console.log(`\n--- ${collection} (${catKey}) ---`);

    for (const [size, sqftPerBox, lbPerBox, pricePerSqft, pcsPerBox, items] of groups) {
      for (const [itemCode, colorName, species] of items) {
        // Create product
        const product = await upsertProduct(vendorId, {
          name: colorName,
          collection,
          categoryId,
        });
        if (product.is_new) productsCreated++;
        else productsUpdated++;

        // Create main flooring SKU
        const internalSku = `SLCC-${itemCode}`;
        const sku = await upsertSku(product.id, {
          vendorSku: itemCode,
          internalSku,
          variantName: colorName,
          sellBy: 'sqft',
          variantType: null,
        });
        if (sku.is_new) skusCreated++;
        else skusUpdated++;

        // Pricing: cost = listed price, retail = cost × 2
        const cost = pricePerSqft;
        const retail = parseFloat((cost * 2).toFixed(2));
        await upsertPricing(sku.id, cost, retail, 'per_sqft');

        // Packaging
        await upsertPackaging(sku.id, { sqftPerBox, pcsPerBox, lbPerBox });

        // Attributes
        await upsertAttribute(sku.id, 'Collection', collection);
        await upsertAttribute(sku.id, 'Color', colorName);
        if (species) await upsertAttribute(sku.id, 'Species', species);
        if (size) await upsertAttribute(sku.id, 'Size', size);

        // Create accessory SKUs (moldings)
        const moldings = MOLDINGS[moldingTier] || [];
        for (const [suffix, accName, accCost] of moldings) {
          const accInternalSku = `SLCC-${itemCode}-${suffix}`;
          const accSku = await upsertSku(product.id, {
            vendorSku: `${itemCode}-${suffix}`,
            internalSku: accInternalSku,
            variantName: accName,
            sellBy: 'unit',
            variantType: 'accessory',
          });
          if (accSku.is_new) accessoriesCreated++;

          // Accessory pricing: cost = listed price, retail = cost × 2
          await upsertPricing(accSku.id, accCost, accCost * 2, 'per_unit');
        }
      }
    }
    const count = groups.reduce((n, g) => n + g[5].length, 0);
    console.log(`  ${count} products, each with ${(MOLDINGS[moldingTier] || []).length} accessories`);
  }

  console.log('\n=== SLCC Import Complete ===');
  console.log(`Products created: ${productsCreated}`);
  console.log(`Products updated: ${productsUpdated}`);
  console.log(`Flooring SKUs created: ${skusCreated}`);
  console.log(`Flooring SKUs updated: ${skusUpdated}`);
  console.log(`Accessory SKUs created: ${accessoriesCreated}`);
  console.log(`Total SKUs: ${skusCreated + skusUpdated + accessoriesCreated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
