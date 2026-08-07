/**
 * Update Orion dealer costs from the July 15, 2026 wholesale price list PDF:
 * "ORION WHOLESALE NET PRICE LIST JULY 15T 2026 UPDATED (1).pdf"
 *
 * Only covers items still on the July 2026 list AND in our catalog.
 * Items dropped from the list (Arno Azzurro, Bois de Lille, Taj Mahal, Albany,
 * Augusto, AU Dusk, Blond, Boston, Bracciano, Coreu Gris, Gery, Jet Antracita,
 * Jungle Blanco, Neowood, Sequoia Maxi, Silke, Sybil, TMG, Natural Terrazzo,
 * the vinyl/SPC section, and the countertop slab pages) keep their existing
 * Q4-2025 costs — reported at the end so they can be reviewed with the vendor.
 *
 * Packaging in this revision is identical to Nov 2025 for all shared items,
 * so import-orion-packaging.mjs data remains valid.
 *
 * Usage: node backend/scripts/import-orion-costs-jul2026.mjs [--dry-run]
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

// ── July 2026 JOB PACK costs (per sqft) ──
// [name_pattern, size (must match SKU size attr; null = name-only), cost]
const COST_LIST = [
  ['AETERNA',              '24X48', 3.99],
  ['AMAZONA JADE',         '24X48', 5.19],
  ['ASPEN',                '8X48',  3.39],
  ['ASTRO',                '24X48', 4.69],
  ['AXE',                  '8X48',  3.49],
  ['BLUE FOREST',          '60X120', 7.75], // DECO/WALL PAPER $62.00/pc ÷ 8 sf/pc
  ['PALMA',                '60X120', 7.75], // DECO/WALL PAPER $62.00/pc ÷ 8 sf/pc
  ['CF LIGHT',             '32X32', 4.69],
  ['CALACATTA BLACK',      '24X48', 5.19], // polished
  ['CREMA ROMA',           '24X48', 4.19],
  ['CROMATIC BLACK',       '24X24', 3.39],
  ['CROMATIC BLANCO',      '24X24', 3.39],
  ['DARK ROSE',            '24X48', 2.59],
  ['EKALI NOIR',           '24X48', 4.69],
  ['ELEGANCE WHITE',       '24X48', 3.79],
  ['ESSENTIAL',            '8X48',  3.49],
  ['GARE WHITE',           '24X48', 4.09],
  ['HEISINKI',             null,    3.59], // list spells it HELSINKI, 10x60
  ['HORTON WHITE',         '24X48', 3.79],
  ['IKON AMBER',           null,    4.19],
  ['ILLUSION SNOW',        '24X48', 4.19],
  ['KM BLANCO',            null,    3.79],
  ['KOMI NOCE',            null,    3.79],
  ['LA BLUE GRIGIO',       '24X24', 4.19],
  ['LA BLUE NERO',         '24X24', 4.19],
  ['LABRADORITE BLUE',     '24X48', 5.15],
  ['LILAC PURPLE',         '24X48', 2.49],
  ['LUX DANAE',            '24X48', 5.59], // list: DANAE NAVI-OPAL
  ['MACAUBA AZUL',         '24X48', 4.69], // list: MACAUBA BLUE
  ['MARMETTE',             '24X24', 4.19],
  ['MARVEL',               '24X48', 2.49],
  ['MAZERO GOLD',          '24X48', 2.99],
  ['MONTCLAIR',            '24X24', 3.39],
  ['MUKALI',               null,    2.59],
  ['ONI CORAL',            '24X48', 5.59],
  ['ONI PEARL',            '24X48', 5.59],
  ['ONI WHITE',            '24X48', 5.59],
  ['OLYMPIA WHITE',        '24X48', 3.79],
  ['PAINT',                '24X48', 4.99],
  ['PAMESA CREMA MARFIL',  '24X48', 4.49], // list: CREMA MARFIL polished
  ['PAMESA CREMA MARFIL',  '48X48', 4.69],
  ['PISA GOLD',            '24X48', 4.19],
  ['ROMA',                 '24X48', 3.99],
  ['ROSSO VERONA',         '24X24', 4.19], // list: MARMOREA
  ['SCARLET',              '24X48', 4.69],
  ['SEGESTA IVORY',        '24X48', 4.69], // polished
  ['SERENE',               '24X48', 2.99], // list: SERENE ONYX
  ['SPARK',                '48X48', 3.09], // list: SPARK GREY
  ['STAR',                 '24X48', 5.19],
  ['TOSCANA',              '24X48', 4.19],
  ['VIKEN',                '24X48', 4.49],
  ['WETWOOD',              null,    4.19],
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
    SELECT s.id AS sku_id, s.variant_type, p.name AS product_name,
      sa.value AS size, pr.cost AS old_cost, pr.retail_price
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN attributes a ON a.slug = 'size'
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = a.id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [VENDOR_ID]);

  console.log(`Found ${skus.length} Orion SKUs${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  let updated = 0;
  const untouched = [];
  const marginRisk = [];

  for (const sku of skus) {
    const name = normalize(sku.product_name);
    const skuSize = normSize(sku.size);

    let best = null;
    for (const [pattern, size, cost] of COST_LIST) {
      if (!name.startsWith(normalize(pattern))) continue;
      if (size && normSize(size) !== skuSize) continue;
      if (!best || pattern.length > best.pattern.length) best = { pattern, cost };
    }

    if (!best) {
      untouched.push(`${sku.product_name} (${sku.size || 'no size'}, ${sku.variant_type}) — cost stays $${sku.old_cost ?? '—'}`);
      continue;
    }

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, 'per_sqft')
        ON CONFLICT (sku_id) DO UPDATE SET cost = $2
      `, [sku.sku_id, best.cost, sku.retail_price || 0]);
    }
    updated++;

    const oldCost = sku.old_cost != null ? parseFloat(sku.old_cost) : null;
    const retail = sku.retail_price != null ? parseFloat(sku.retail_price) : null;
    const delta = oldCost != null ? (best.cost - oldCost).toFixed(2) : '—';
    console.log(`  ✓ ${sku.product_name} (${sku.size || '—'}) → $${best.cost}/sf (was $${oldCost ?? '—'}, Δ ${delta})  [${best.pattern}]`);
    if (retail != null && retail > 0 && retail < best.cost) {
      marginRisk.push(`${sku.product_name} (${sku.size || '—'}): cost $${best.cost} > retail $${retail}`);
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`Total SKUs:      ${skus.length}`);
  console.log(`Costs updated:   ${updated}`);
  console.log(`Left untouched:  ${untouched.length} (not on the July 2026 list)`);

  if (marginRisk.length) {
    console.log(`\n── ⚠ NEGATIVE MARGIN (cost > retail) — reprice these ──`);
    for (const m of marginRisk) console.log(`  ⚠ ${m}`);
  }
  if (untouched.length) {
    console.log(`\n── Untouched (keep old cost; confirm with vendor if still stocked) ──`);
    for (const n of untouched) console.log(`  · ${n}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
