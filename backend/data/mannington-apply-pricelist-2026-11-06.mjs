// Apply Mannington (vendor MANN) dealer-cost changes from the Acct-80985 price
// update PDFs (Issue/Effective Date 11/06/2026, emailed "Mannington Price Update
// Cartons-Detail" + "Rolls-Detail"). The Dec-14-2026 5-7% increase notice from
// October materialized as these lists.
//
// Source: backend/data/mannington/mannington-pricelist-2026-11-06.json, parsed
// from the PDFs by mannington/parse-mannington-pdfs-2026-11-06.py (pdfplumber,
// x-position column mapping). Match keys:
//   - field SKUs (sell_by box): vendor_sku = PDF "Color Code" (APX020 / LWB06AL1 / 28610)
//   - accessories (sell_by unit): vendor_sku = trim catalog # (price from the
//     per-piece $ column header of the series block)
//   - rolls (sheet vinyl): catalog # — expected zero matches, sheet isn't in PIM
//
// Retail is re-derived through upsertPricing() so house rules apply (1.70x
// keystone rewrite from the handed 2x, charm-to-9, margin floors); basis is not
// passed so each row keeps its per_sqft/per_unit.
//
// ALSO fixes trim mislabels: the original onboarding
// (backend/scripts/import-mannington.cjs) hand-transcribed each row's trim
// catalogs into positional slots and collapsed the PDF's BLANK columns, so a
// subset of trims took the wrong column's NAME and PRICE (e.g. 591850 named
// "End Cap" @27.87 when the PDF places it under OneNose @62.90; 68 "OneNose"
// rows @75.02 — a price that exists nowhere in the current list). Where the
// PDF column label class disagrees with the DB variant_name type, this script
// renames variant_name + accessory_label (old names backed up).
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-apply-pricelist-2026-11-06.mjs [--apply]
// Without --apply it's a dry run (prints the diff, writes the CSV, no DB writes).

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
const BACKUP = 'pricing_backup_mann_20261106';
const NAME_BACKUP = 'skus_trim_names_backup_mann_20261106';

// Trim profile class, from either a DB variant_name/accessory_label or a PDF
// column label. Classes are what we compare — size/packaging suffixes vary.
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

// Canonical display name for a PDF label, in the DB's existing style.
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
    default: return null;
  }
}
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;
const CSV_OUT = new URL('./mannington/mannington-pricelist-diff-2026-11-06.csv', import.meta.url).pathname;

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const fieldByCode = new Map(list.fields.map(f => [f.color_code, f]));
  const trimByCatalog = new Map(Object.entries(list.trims));
  const rollByCatalog = new Map(list.rolls.map(r => [r.catalog, r]));
  console.log(`List: ${fieldByCode.size} field colors, ${trimByCatalog.size} trim catalogs, ${rollByCatalog.size} roll rows`);

  const { rows: skus } = await pool.query(
    `SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.accessory_label, s.sell_by, s.status,
            pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked, p.name AS product_name
       FROM products p JOIN skus s ON s.product_id = p.id
       LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1`, [VENDOR_ID]);
  console.log(`DB: ${skus.length} Mannington SKUs`);

  const changes = [], same = [], notInList = [], noPricing = [], rollHits = [], renames = [];
  const matchedKeys = new Set();
  for (const s of skus) {
    const f = fieldByCode.get(s.vendor_sku);
    const t = trimByCatalog.get(s.vendor_sku);
    const r = rollByCatalog.get(s.vendor_sku);
    const newCost = f ? f.cost_sqft : t ? t.price : null;
    if (r) rollHits.push(s);
    // trim-type mislabel check (independent of cost delta)
    if (t && t.label) {
      const dbCls = trimClass(s.variant_name);
      const pdfCls = trimClass(t.label);
      if (dbCls && pdfCls && dbCls !== pdfCls) {
        const canon = canonicalTrimName(t.label);
        const idx = s.variant_name.indexOf(',');
        const suffix = idx >= 0 ? s.variant_name.slice(idx) : '';
        renames.push({
          sku_id: s.sku_id, vendor_sku: s.vendor_sku, product_name: s.product_name,
          old_name: s.variant_name, new_name: `${canon}${suffix}`,
          old_label: s.accessory_label, new_label: canon,
        });
      }
    }
    if (newCost == null) { notInList.push(s); continue; }
    matchedKeys.add(s.vendor_sku);
    if (s.cost == null) { noPricing.push({ ...s, newCost }); continue; }
    if (Math.abs(parseFloat(s.cost) - newCost) < 0.005) same.push(s);
    else changes.push({ ...s, newCost, src: f ? `field:${f.series}` : `trim:${t.series}` });
  }
  const listOnlyFields = list.fields.filter(f => !matchedKeys.has(f.color_code));
  const listOnlyTrims = [...trimByCatalog.keys()].filter(k => !matchedKeys.has(k));

  console.log(`\nMatched unchanged: ${same.length}`);
  console.log(`PRICE_CHANGE:      ${changes.length}`);
  console.log(`DB not in list:    ${notInList.length} (discontinued/not carried in these lists)`);
  console.log(`Matched, no pricing row: ${noPricing.length}`);
  console.log(`List-only field colors (not in PIM): ${listOnlyFields.length}`);
  console.log(`List-only trim catalogs (not in PIM): ${listOnlyTrims.length}`);
  console.log(`Roll (sheet) catalog matches in PIM: ${rollHits.length}${rollHits.length ? ' — REVIEW, not applied' : ''}`);

  const inc = changes.filter(c => c.newCost > parseFloat(c.cost));
  const dec = changes.filter(c => c.newCost < parseFloat(c.cost));
  const pct = changes.map(c => (c.newCost / parseFloat(c.cost) - 1) * 100);
  if (changes.length) {
    const avg = pct.reduce((a, b) => a + b, 0) / pct.length;
    console.log(`  increases ${inc.length}, decreases ${dec.length}, avg ${avg.toFixed(1)}% (min ${Math.min(...pct).toFixed(1)}%, max ${Math.max(...pct).toFixed(1)}%)`);
  }
  const locked = changes.filter(c => c.retail_locked);
  if (locked.length) console.log(`  (${locked.length} retail_locked — cost updated, retail kept)`);
  console.log(`Trim-type RENAMES (import column-collapse fix): ${renames.length}`);

  // CSV for provenance/review
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['type,vendor_sku,product_name,variant_name,status,old_cost,new_cost,old_retail,basis,source'];
  for (const c of changes) csv.push(['PRICE_CHANGE', c.vendor_sku, c.product_name, c.variant_name, c.status, c.cost, c.newCost, c.retail_price, c.price_basis, c.src].map(esc).join(','));
  for (const s of notInList) csv.push(['DB_ONLY', s.vendor_sku, s.product_name, s.variant_name, s.status, s.cost, '', s.retail_price, s.price_basis, ''].map(esc).join(','));
  for (const f of listOnlyFields) csv.push(['LIST_ONLY_FIELD', f.color_code, f.series, f.desc, '', '', f.cost_sqft, '', '', f.series_code].map(esc).join(','));
  for (const r of renames) csv.push(['RENAME', r.vendor_sku, r.product_name, r.old_name, '', '', '', '', '', r.new_name].map(esc).join(','));
  try {
    fs.writeFileSync(CSV_OUT, csv.join('\n') + '\n');
    console.log(`\nWrote ${CSV_OUT} (${csv.length - 1} rows)`);
  } catch (e) {
    // prod bind mount is read-only to the container user — CSV is provenance
    // only (already committed from the local run), not required to apply
    console.log(`\n(CSV not written: ${e.code} — fine on prod, file is in git)`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — first 15 planned changes:');
    for (const c of changes.slice(0, 15)) {
      console.log(`  ${c.vendor_sku.padEnd(10)} ${String(c.cost).padStart(7)} -> ${String(c.newCost).padStart(7)}  (retail ${c.retail_price}, ${c.price_basis})  ${c.product_name} / ${c.variant_name}`);
    }
    console.log('\nDRY RUN — first 15 renames:');
    for (const r of renames.slice(0, 15)) {
      console.log(`  ${r.vendor_sku.padEnd(10)} "${r.old_name}" -> "${r.new_name}"  (${r.product_name})`);
    }
    console.log('\nRe-run with --apply to back up + write.');
    await pool.end();
    return;
  }

  const ids = changes.map(c => c.sku_id);
  await pool.query(`DROP TABLE IF EXISTS ${BACKUP}`);
  await pool.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM pricing WHERE sku_id = ANY($1::uuid[])`, [ids]);
  const { rows: [{ count }] } = await pool.query(`SELECT count(*) FROM ${BACKUP}`);
  console.log(`Backed up ${count} rows to ${BACKUP}.`);

  let done = 0;
  for (const c of changes) {
    await upsertPricing(pool, c.sku_id, { cost: c.newCost, retail_price: c.newCost * 2 });
    done++;
  }
  console.log(`Applied ${done} cost updates (retail re-derived via house rules).`);

  if (renames.length) {
    const rids = renames.map(r => r.sku_id);
    await pool.query(`DROP TABLE IF EXISTS ${NAME_BACKUP}`);
    await pool.query(
      `CREATE TABLE ${NAME_BACKUP} AS SELECT id AS sku_id, vendor_sku, variant_name, accessory_label
         FROM skus WHERE id = ANY($1::uuid[])`, [rids]);
    for (const r of renames) {
      await pool.query(
        `UPDATE skus SET variant_name = $2, accessory_label = $3, updated_at = now() WHERE id = $1`,
        [r.sku_id, r.new_name, r.new_label]);
    }
    console.log(`Renamed ${renames.length} mislabeled trims (old names in ${NAME_BACKUP}).`);
  }

  const sample = changes.slice(0, 10).map(c => c.sku_id);
  const { rows: after } = await pool.query(
    `SELECT s.vendor_sku, pr.cost, pr.retail_price, round(pr.retail_price/NULLIF(pr.cost,0),2) ratio
       FROM skus s JOIN pricing pr ON pr.sku_id = s.id WHERE s.id = ANY($1::uuid[]) ORDER BY s.vendor_sku`, [sample]);
  console.log('\nSample after:');
  for (const a of after) console.log(`  ${a.vendor_sku.padEnd(10)} cost ${a.cost} retail ${a.retail_price} (${a.ratio}x)`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
