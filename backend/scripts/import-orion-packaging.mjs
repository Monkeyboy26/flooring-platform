/**
 * Import Orion packaging data (sqft/box, pcs/box, boxes/pallet) from the
 * dealer price list PDF: ORION Q-4-2025.pdf (November 2025 revision).
 * Packaging is embedded in the DESCRIPTION column ("16 SF/BOX", "2PCS/16SF BOX/32 BOXES PALLET").
 *
 * Notes:
 *  - The Nov 2025 revision no longer lists the vinyl/SPC section, the countertop
 *    slab pages (L-series etc.), or some tiles from the older Q4 list
 *    (Albany, Augusto, AU Dusk, Blond, Boston, Bracciano, Coreu Gris, Gery,
 *    Jet Antracita, Jungle Blanco, Neowood, Sequoia Maxi, Silke, Sybil, TMG,
 *    Natural Terrazzo) — those SKUs are left without packaging and reported.
 *  - pieces_per_box is set when explicit in the PDF or exactly derivable from
 *    the tile size; ambiguous cases stay NULL.
 *
 * Usage: node backend/scripts/import-orion-packaging.mjs [--dry-run]
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Packaging transcription from the price list ──
// [name_pattern, size (must match the SKU size attr; null = match by name only), sqft_per_box, pieces_per_box, boxes_per_pallet]
const PACKAGING_LIST = [
  ['AETERNA',              '24X48', 16,    2,    null],
  ['AMAZONA JADE',         '24X48', 16,    2,    null],
  ['ARNO AZZURRO',         '24X48', 16,    2,    null], // PDF: "ARNO / AZUL POLISHED 16 SF/BOX"
  ['ASPEN',                '8X48',  13.30, 5,    null],
  ['ASTRO',                '24X48', 16,    2,    36],
  ['AXE',                  '8X48',  10.66, 4,    null],
  ['BLUE FOREST',          '60X120', 16,   2,    null], // DECO/WALL PAPER: 2 PCS/BOX
  ['BOIS DE LILLE',        '8X48',  13.33, 5,    null],
  ['CF LIGHT',             '32X32', 14.08, 2,    null],
  ['CALACATTA BLACK',      '24X48', 16,    2,    null],
  ['CROMATIC BLACK',       '24X24', 16,    4,    null],
  ['CROMATIC BLANCO',      '24X24', 16,    4,    null],
  ['DARK ROSE',            '24X48', 16,    2,    32],
  ['EKALI NOIR',           '24X48', 16,    2,    null],
  ['ELEGANCE WHITE',       '24X48', 16,    2,    null],
  ['ESSENTIAL',            '8X48',  11,    null, null],
  ['HORTON WHITE',         '24X48', 16,    2,    null],
  ['IKON AMBER',           null,    16.10, 4,    null], // PDF size is 12x48 (DB says 8x48)
  ['ILLUSION SNOW',        '24X48', 16,    2,    null],
  ['KM BLANCO',            null,    11,    null, null], // PDF size is 6.5x40
  ['KOMI NOCE',            null,    11,    null, null], // PDF size is 6.5x40
  ['LA BLUE GRIGIO',       '24X24', 12,    3,    null],
  ['LA BLUE NERO',         '24X24', 12,    3,    null],
  ['LABRADORITE BLUE',     '24X48', 16,    2,    null],
  ['LILAC PURPLE',         '24X48', 16,    2,    32],
  ['LUX DANAE',            '24X48', 16,    2,    null], // PDF: "DANAE / NAVI-OPAL 16SF/BOX"
  ['MACAUBA AZUL',         '24X48', 16,    2,    null], // PDF: "MACAUBA BLUE 16.00 SF/BOX"
  ['MARMETTE',             '24X24', 12,    3,    null],
  ['MARVEL',               '24X48', 16,    2,    33],
  ['MONTCLAIR',            '24X24', 16,    4,    null],
  ['MUKALI',               null,    12.3,  4,    null], // PDF size is 9.2x48 (DB says 8x48)
  ['ONI CORAL',            '24X48', 16,    2,    null],
  ['ONI PEARL',            '24X48', 16,    2,    null],
  ['ONI WHITE',            '24X48', 16,    2,    null],
  ['OLYMPIA WHITE',        '24X48', 16,    2,    null],
  ['PAINT',                '24X48', 16,    2,    null], // Blue/Gray/Rosé/Salvia/White
  ['PALMA',                '60X120', 16,   2,    null], // DECO/WALL PAPER: 2 PCS/BOX
  ['PAMESA CREMA MARFIL',  '24X48', 16,    2,    32],   // PDF CREMA MARFIL: 2PC/16SF BOX/32 BOXES PALLET
  ['PAMESA CREMA MARFIL',  '48X48', 16,    1,    36],   // PDF CREMA MARFIL: 1PC/16SF BOX 36 BOXES/PALLET
  ['ROMA',                 '24X48', 16,    2,    null],
  ['ROSSO VERONA',         '24X24', 11.88, 3,    40],   // PDF MARMOREA: 3 PCS. 11.88SF/BOX / 40 BX/PAL
  ['SCARLET',              '24X48', 16,    2,    null], // 2PCS./16SF/BOX
  ['SEGESTA IVORY',        '24X48', 16,    2,    null],
  ['SERENE',               '24X48', 16,    2,    null], // PDF: "SERENE ONYX 16.00/SF /BOX"
  ['SPARK',                '48X48', 32,    2,    null], // PDF SPARK GREY: 2PCS. / 32 SF PER BOX
  ['STAR',                 '24X48', 8,     1,    null], // KRYSTAL SURFACE 8/SF BOX
  ['TAJ MAHAL',            '24X48', 16,    2,    null],
  ['TOSCANA',              '24X48', 16,    2,    null],
  ['VIKEN',                '24X48', 16,    2,    null],
  ['WETWOOD',              null,    11.66, 5,    null], // PDF size 7.2x47.2
];

function normalize(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[""''|()\/\\,\-–—.×&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normSize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

async function main() {
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.internal_sku, s.variant_type, p.name AS product_name,
      sa.value AS size, pk.sqft_per_box AS existing_sqft
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN attributes a ON a.slug = 'size'
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = a.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [VENDOR_ID]);

  console.log(`Found ${skus.length} Orion SKUs${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  let updated = 0;
  const unmatched = [];

  for (const sku of skus) {
    const name = normalize(sku.product_name);
    const skuSize = normSize(sku.size);

    // Longest matching pattern wins; entries with a size require the SKU size to match
    let best = null;
    for (const [pattern, size, sqft, pcs, bxPal] of PACKAGING_LIST) {
      if (!name.startsWith(normalize(pattern))) continue;
      if (size && normSize(size) !== skuSize) continue;
      if (!best || pattern.length > best.pattern.length) {
        best = { pattern, sqft, pcs, bxPal };
      }
    }

    if (!best) {
      unmatched.push(`${sku.product_name} (${sku.size || 'no size'}, ${sku.variant_type})`);
      continue;
    }

    const sqftPerPallet = best.bxPal ? +(best.sqft * best.bxPal).toFixed(2) : null;
    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = $2, pieces_per_box = $3, boxes_per_pallet = $4, sqft_per_pallet = $5
      `, [sku.sku_id, best.sqft, best.pcs, best.bxPal, sqftPerPallet]);
    }
    updated++;
    console.log(`  ✓ ${sku.product_name} (${sku.size || '—'}) → ${best.sqft} sf/box`
      + (best.pcs ? `, ${best.pcs} pcs` : '')
      + (best.bxPal ? `, ${best.bxPal} bx/pal` : '')
      + `  [${best.pattern}]`);
  }

  console.log(`\n── Summary ──`);
  console.log(`Total SKUs:   ${skus.length}`);
  console.log(`Packaged:     ${updated}`);
  console.log(`No data:      ${unmatched.length} (not in the Nov 2025 price list revision)`);
  if (unmatched.length) {
    console.log(`\n── SKUs without packaging data ──`);
    for (const n of unmatched) console.log(`  ✗ ${n}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
