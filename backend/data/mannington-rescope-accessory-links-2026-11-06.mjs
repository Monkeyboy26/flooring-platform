// Rescope Mannington sku_accessories per COLOR using the 11/06/2026 price
// list's per-row trim catalogs (mannington/mannington-pricelist-2026-11-06.json,
// fields[].trims — each color row lists ITS OWN trim catalog numbers).
//
// Why: the original import linked every color SKU to every trim on the product
// (all-to-all) and created the trim SKUs color-anonymous (no color attribute,
// catalog # in the name). The PDP accessory query (server.js ~3784) color-gates
// via sku_attributes and dedupes by (label, variant_name) — both guards pass
// these trims, so e.g. Hillside Hickory Acorn showed all 21 product trims (7
// types x 3 colors) instead of its own 7. 22 products / 167 parent SKUs showed
// duplicate cards.
//
// What it does, per active MANN field SKU whose vendor_sku is a list color code:
//   1. onboards trim catalogs on its row that have no MANN SKU yet (e.g.
//      Hillside Hickory Coal's 7 trims were never imported), priced via
//      upsertPricing house rules;
//   2. rebuilds its MANN-accessory links to exactly the row's catalogs
//      (sort_order = PDF column order; cross-vendor links untouched);
//   3. stamps a color attribute on each trim whose linked parents agree on a
//      single color, so the PDP color gate works for any future links.
// Parents not in the list (discontinued colors, already deactivated) keep
// their links untouched — the PDP only renders active SKUs.
//
// Backups: sku_accessories_backup_mann_rescope_20261106 (all pre-change rows
// with a MANN parent), skus_mann_trims_onboarded_20261106 (created SKU rows).
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-rescope-accessory-links-2026-11-06.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import { upsertPricing } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd'; // Mannington
const COLOR_ATTR_ID = 'd50e8400-e29b-41d4-a716-446655440001'; // attributes.slug = 'color'
const LINK_BACKUP = 'sku_accessories_backup_mann_rescope_20261106';
const ONBOARD_BACKUP = 'skus_mann_trims_onboarded_20261106';
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;
const ALIASES = { LWB06CT1: 'LWB06CT' }; // DB key -> PDF key (PDF's own drift)

function trimClass(s) {
  const t = (s || '').toLowerCase();
  if (t.startsWith('quarter') || t.startsWith('qtr')) return 'quarter-round';
  if (t.startsWith('reducer')) return 'reducer';
  if (t.startsWith('t-mold')) return 't-mold';
  if (t.startsWith('stepnose')) return t.includes('flush') ? 'stepnose-flush' : 'stepnose';
  if (t.startsWith('end')) return 'end-cap';
  if (t.startsWith('simplest')) return 'simplest';
  if (t.startsWith('onenose')) return 'onenose';
  if (t.startsWith('topstep')) return 'topstep';
  if (t.startsWith('wall')) return 'wall-base';
  if (t.startsWith('threshold')) return 'threshold';
  if (t.startsWith('care')) return 'care-kit';
  return null;
}
function canonicalTrimName(label) {
  const cls = trimClass(label);
  const sz = (label.match(/(\d{2}")/) || [])[1] || '94"';
  switch (cls) {
    case 'quarter-round': return `Quarter Round ${sz}`;
    case 'reducer': return `Reducer ${sz}`;
    case 't-mold': return `T-Mold ${sz}`;
    case 'stepnose': return `StepNose ${sz}`;
    case 'stepnose-flush': return `StepNose Flush ${sz}`;
    case 'end-cap': return 'End Cap';
    case 'simplest': return 'SimpleSt 48"';
    case 'onenose': return 'OneNose 94"';
    case 'topstep': return 'Topstep 48"';
    case 'wall-base': return `Wall Base ${sz}`;
    case 'threshold': return `Threshold ${sz}`;
    case 'care-kit': return 'Care Kit';
    default: return label;
  }
}

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const fieldByCode = new Map(list.fields.map(f => [f.color_code, f]));
  if (!list.fields.some(f => (f.trims || []).length)) {
    throw new Error('fields[].trims missing — re-run the parser (v2) first');
  }

  // Active MANN field parents that are on the list (directly or via alias)
  const { rows: parents } = await pool.query(
    `SELECT s.id, s.vendor_sku, s.product_id, p.name AS product_name,
            (SELECT sa.value FROM sku_attributes sa WHERE sa.sku_id = s.id AND sa.attribute_id = $2 LIMIT 1) AS color
       FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND s.sell_by = 'box'`,
    [VENDOR_ID, COLOR_ATTR_ID]);
  const scoped = parents
    .map(par => ({ ...par, row: fieldByCode.get(ALIASES[par.vendor_sku] || par.vendor_sku) }))
    .filter(par => par.row);
  console.log(`Active MANN field SKUs: ${parents.length}; on-list (rescope targets): ${scoped.length}`);

  // All existing MANN SKUs by vendor_sku (to resolve trim catalogs)
  const { rows: mannSkus } = await pool.query(
    `SELECT s.id, s.vendor_sku, s.status, s.product_id FROM skus s
       JOIN products p ON p.id = s.product_id WHERE p.vendor_id = $1`, [VENDOR_ID]);
  const skuByKey = new Map(mannSkus.map(s => [s.vendor_sku, s]));

  // Existing MANN-accessory links for the scoped parents
  const parentIds = scoped.map(p => p.id);
  const { rows: existingLinks } = await pool.query(
    `SELECT sa.parent_sku_id, sa.accessory_sku_id, acc.vendor_sku
       FROM sku_accessories sa
       JOIN skus acc ON acc.id = sa.accessory_sku_id
       JOIN products pacc ON pacc.id = acc.product_id
      WHERE sa.parent_sku_id = ANY($1::uuid[]) AND pacc.vendor_id = $2`,
    [parentIds, VENDOR_ID]);
  const linksByParent = new Map();
  for (const l of existingLinks) {
    (linksByParent.get(l.parent_sku_id) ?? linksByParent.set(l.parent_sku_id, new Map()).get(l.parent_sku_id))
      .set(l.vendor_sku, l.accessory_sku_id);
  }

  // Plan
  const onboard = new Map(); // catalog -> {label, price, product_id, product_name}
  let toDelete = [], toInsert = [], parentsTouched = new Set();
  const trimParents = new Map(); // catalog -> Set(parent colors), for the color stamp
  for (const par of scoped) {
    const want = new Map((par.row.trims || []).map(t => [t.catalog, t]));
    const have = linksByParent.get(par.id) || new Map();
    for (const [cat, t] of want) {
      (trimParents.get(cat) ?? trimParents.set(cat, new Set()).get(cat)).add(par.color || '∅');
      if (!skuByKey.has(cat) && !onboard.has(cat)) {
        onboard.set(cat, { label: t.label, price: t.price, product_id: par.product_id, product_name: par.product_name });
      }
      if (!have.has(cat)) { toInsert.push({ parent: par, catalog: cat, sort: t.col }); parentsTouched.add(par.id); }
    }
    for (const [cat, accId] of have) {
      if (!want.has(cat)) { toDelete.push({ parent: par, catalog: cat, accId }); parentsTouched.add(par.id); }
    }
  }

  // Color stamps: unambiguous single-color trims only (existing + to-onboard)
  const colorStamps = [];
  for (const [cat, colors] of trimParents) {
    const real = [...colors].filter(c => c !== '∅');
    if (real.length === 1 && colors.size === 1) colorStamps.push({ catalog: cat, color: real[0] });
  }

  console.log(`Links to delete (wrong-color): ${toDelete.length}`);
  console.log(`Links to insert (missing own-color): ${toInsert.length}`);
  console.log(`Parents touched: ${parentsTouched.size}`);
  console.log(`Trim SKUs to onboard: ${onboard.size}`);
  for (const [cat, o] of [...onboard].slice(0, 10)) console.log(`  + ${cat} ${canonicalTrimName(o.label)} @${o.price} -> ${o.product_name}`);
  if (onboard.size > 10) console.log(`  … and ${onboard.size - 10} more`);
  console.log(`Color attributes to stamp (unambiguous): ${colorStamps.length} of ${trimParents.size} trims`);

  if (!APPLY) {
    console.log('\nDRY RUN — sample deletions:');
    for (const d of toDelete.slice(0, 8)) console.log(`  ${d.parent.product_name}/${d.parent.vendor_sku} (${d.parent.color}) -x- ${d.catalog}`);
    console.log('\nRe-run with --apply to back up + write.');
    await pool.end();
    return;
  }

  // Backup ALL links with a MANN parent (superset of what we touch)
  await pool.query(`DROP TABLE IF EXISTS ${LINK_BACKUP}`);
  await pool.query(
    `CREATE TABLE ${LINK_BACKUP} AS
       SELECT sa.* FROM sku_accessories sa
        JOIN skus par ON par.id = sa.parent_sku_id
        JOIN products p ON p.id = par.product_id
       WHERE p.vendor_id = $1`, [VENDOR_ID]);

  // 1. Onboard missing trims
  const created = [];
  for (const [cat, o] of onboard) {
    const canon = canonicalTrimName(o.label);
    const { rows: [sku] } = await pool.query(
      `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, accessory_label, sell_by, variant_type, status)
       VALUES ($1, $2, $3, $4, $5, 'unit', 'accessory', 'active')
       ON CONFLICT (internal_sku) DO UPDATE SET status = 'active'
       RETURNING id`,
      [o.product_id, cat, `MANN-${cat}`, `${canon}, (${cat})`, canon]);
    await upsertPricing(pool, sku.id, { cost: o.price, retail_price: o.price * 2 });
    skuByKey.set(cat, { id: sku.id, vendor_sku: cat, status: 'active', product_id: o.product_id });
    created.push(sku.id);
  }
  if (created.length) {
    await pool.query(`DROP TABLE IF EXISTS ${ONBOARD_BACKUP}`);
    await pool.query(`CREATE TABLE ${ONBOARD_BACKUP} AS SELECT * FROM skus WHERE id = ANY($1::uuid[])`, [created]);
  }
  console.log(`Onboarded ${created.length} trim SKUs (rows copied to ${ONBOARD_BACKUP}).`);

  // 2. Rebuild links
  let del = 0, ins = 0;
  for (const d of toDelete) {
    const r = await pool.query(
      `DELETE FROM sku_accessories WHERE parent_sku_id = $1 AND accessory_sku_id = $2`,
      [d.parent.id, d.accId]);
    del += r.rowCount;
  }
  for (const i of toInsert) {
    const acc = skuByKey.get(i.catalog);
    if (!acc) continue;
    const r = await pool.query(
      `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [i.parent.id, acc.id, i.sort]);
    ins += r.rowCount;
  }
  console.log(`Links: deleted ${del}, inserted ${ins} (backup ${LINK_BACKUP}).`);

  // 3. Color attributes (never overwrites an existing value)
  let stamped = 0;
  for (const c of colorStamps) {
    const acc = skuByKey.get(c.catalog);
    if (!acc) continue;
    const r = await pool.query(
      `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (sku_id, attribute_id) DO NOTHING`,
      [acc.id, COLOR_ATTR_ID, c.color]);
    stamped += r.rowCount;
  }
  console.log(`Color attributes stamped: ${stamped}.`);

  // Verify the headline case: Hillside Hickory Acorn should link exactly 7
  const { rows: check } = await pool.query(
    `SELECT acc.vendor_sku, acc.variant_name
       FROM sku_accessories sa JOIN skus par ON par.id = sa.parent_sku_id
       JOIN skus acc ON acc.id = sa.accessory_sku_id
      WHERE par.vendor_sku = '28210' ORDER BY sa.sort_order`);
  console.log(`\nAcorn (28210) now links ${check.length} accessories:`);
  for (const c of check) console.log(`  ${c.vendor_sku}  ${c.variant_name}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
