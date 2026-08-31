#!/usr/bin/env node
/**
 * fix-bed-zero-cost.mjs
 *
 * 311 active Bedrosians SKUs sell with real (site-scraped) retails but
 * cost = $0 — the Q4-2025 dealer price list ingest (bed-pricing.js) never
 * matched them, so every cost-based guard (covering floor, margin reports,
 * cost-outlier rule) is blind on them. Root cause of the misses: stone rows in
 * the PDF carry a thickness dimension ("3x12x3/8") that the size normalizer
 * kept, so "3x12" never matched; and stone rows carry full item codes the
 * matcher ignored.
 *
 * This backfill re-reads the SAME PDF and matches each zero-cost SKU by:
 *   1. ITEM CODE — the SKU's vendor_sku appearing verbatim in a price row
 *      (stone MRB/TRV/LEDG codes; strongest match)
 *   2. series + size (thickness stripped) + finish, via the shared helpers
 *      exported from scrapers/bed-pricing.js — only when the surviving
 *      candidates agree on ONE price.
 *
 * Writes COST ONLY (existing retails are the live selling prices and stay),
 * except: mosaic/stacked-stone SKUs get the per-sheet conversion (S/F rate ×
 * sheet area → unit/per_unit) to match the platform convention, and any SKU
 * whose retail would be at or below its new cost is repriced to keystone
 * cost×1.7 (BED's catalog norm) — those are listed. Unmatched SKUs are
 * reported and left at $0 for a follow-up pass.
 *
 * Usage (inside the api container — needs pdftotext + the uploaded PDF):
 *   node scripts/fix-bed-zero-cost.mjs           # dry run
 *   node scripts/fix-bed-zero-cost.mjs --apply   # write (with backup)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';
import { parsePriceList, normalizeSize, normalizeSeriesName } from '../scrapers/bed-pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const PDF = '/app/uploads/pricelists/9f377422-1d8d-484d-90c7-29477ea70d18/1771439722151-Bedrosians_Q-4-2025.pdf';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});
const r2 = v => Math.round(v * 100) / 100;

// Strip a trailing thickness dimension: "3x12x3/8" → "3x12" (before normalize).
const stripThickness = s => (s || '').replace(/x\s*\d+(?:-\d+\/\d+|\.\d+|\/\d+)?\s*$/i, (m, off, str) =>
  (str.slice(0, off).match(/x/i) ? '' : m));
const normSize = s => normalizeSize(stripThickness(String(s || '')));

function parseDims(s) {
  const m = String(s || '').replace(/["″]/g, '').match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

// Hand-verified matches where the PDF wraps the description across lines so no
// generic matcher can see it (Jumbo Basketweave 11.22x11.22 marble mosaics,
// PCS-priced; color-suffix codes read straight off the book).
const SPECIALS = {
  '100007359': { price: 12.77, unit: 'PCS' }, // Oriental White & Cinder Grey (ORI)
  '100007360': { price: 11.57, unit: 'PCS' }, // Crema Marfil & Calacatta (CRE)
  '100007361': { price: 11.57, unit: 'PCS' }, // Beige Marble & Thassos (CAS)
  '100007362': { price: 11.63, unit: 'PCS' }, // Glorious Blue & Thassos (GLB)
  '100007363': { price: 11.57, unit: 'PCS' }, // Sahara Noir & Beige (SAH)
  '100007364': { price: 16.61, unit: 'PCS' }, // Dolomite & Bardiglio (DOL)
  '100007365': { price: 17.09, unit: 'PCS' }, // Calacatta & Jura Beige (CAL)
  '100007366': { price: 11.63, unit: 'PCS' }, // White Carrara & Absolute Black (CAR)
  '100007367': { price: 16.61, unit: 'PCS' }, // Dolomite & White Sand (DLS)
  '100007368': { price: 11.57, unit: 'PCS' }, // Pietra Grey & Thassos (PIE)
};

async function main() {
  console.log(`\n=== BED zero-cost backfill (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const text = execSync(`pdftotext -layout "${PDF}" -`, { maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8' });

  // Parsed series entries (series+size+finish+price) via the ingest's own parser.
  const entries = parsePriceList(text);
  console.log(`Parsed ${entries.length} price entries.`);

  // Raw price rows for item-code + stone-layout matching. The stone section
  // (travertine/marble/slate/granite) uses a DIFFERENT layout parsePriceList
  // never handled — "Origin  Category  ItemCode  Size  Description  Unit
  // Price" rows under a bare series-title line — which is why the original
  // ingest missed all of it.
  const codeRows = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(.*?)\s{2,}.*?\s(S\/F|PCS|LNF|SHT|SET)\s+(\d+\.?\d{0,2})\s*$/i);
    if (!m) continue;
    const cols = line.trim().split(/\s{2,}/).map(c => c.trim());
    // stone layout: [Origin, Category, Code, Size, Desc..., Unit, Price]
    let desc = null, size = null;
    if (cols.length >= 6 && /^[A-Z0-9●\-\/.]{5,}$/.test(cols[2]) && /\d\s*[xX]\s*\d|s\/f Set/i.test(cols[3] || '')) {
      size = cols[3];
      desc = cols.slice(4, cols.length - 2).join(' ');
    }
    codeRows.push({ line: line.trim(), unit: m[2].toUpperCase(), price: parseFloat(m[3]), desc, size });
  }

  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.name, p.collection, c.slug AS cat,
           s.sell_by, pr.price_basis, pr.retail_price::float AS retail,
           pk.sqft_per_box::float AS sfbx, pk.pieces_per_box AS pcs,
           (SELECT sa.value FROM sku_attributes sa WHERE sa.sku_id=s.id
             AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='size')) AS size,
           (SELECT sa.value FROM sku_attributes sa WHERE sa.sku_id=s.id
             AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='finish')) AS finish
    FROM skus s
    JOIN products p ON p.id=s.product_id AND p.is_active
    JOIN vendors v ON v.id=p.vendor_id AND v.code='BED'
    LEFT JOIN categories c ON c.id=p.category_id
    JOIN pricing pr ON pr.sku_id=s.id AND pr.cost = 0
    LEFT JOIN packaging pk ON pk.sku_id=s.id
    WHERE s.status='active'
    ORDER BY p.collection, p.name`);
  console.log(`${skus.length} zero-cost SKUs loaded.\n`);

  // Index parsed entries by series|size (thickness-stripped).
  const bySeriesSize = new Map();
  for (const e of entries) {
    const k = `${normalizeSeriesName(e.series)}|${normSize(e.size)}`;
    if (!bySeriesSize.has(k)) bySeriesSize.set(k, []);
    bySeriesSize.get(k).push(e);
  }

  const plan = [], unmatched = [], repriced = [];
  for (const s of skus) {
    let hit = null, how = null;
    // 0) hand-verified specials (wrapped-description rows)
    if (SPECIALS[s.vendor_sku]) { hit = SPECIALS[s.vendor_sku]; how = 'hand-verified'; }
    if (!hit && s.vendor_sku && /[A-Za-z]/.test(s.vendor_sku)) {
      const token = new RegExp(`(^|\\s)${s.vendor_sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      const rows = codeRows.filter(r => token.test(r.line));
      if (rows.length && rows.every(r => r.price === rows[0].price && r.unit === rows[0].unit)) {
        hit = { unit: rows[0].unit, price: rows[0].price };
        how = 'item code';
      }
    }
    // 2) stone-layout description match: desc = "<Series> [piece] - <Finish>";
    //    require desc to start with the collection (longest-collection-first
    //    guard: reject if the char after the prefix continues a longer series
    //    name like "Calacatta Oro" for collection "Calacatta") + same size.
    if (!hit && s.size && s.collection) {
      const coll = normalizeSeriesName(s.collection);
      const cands = codeRows.filter(r => {
        if (!r.desc || !r.size) return false;
        const d = normalizeSeriesName(r.desc);
        if (!d.startsWith(coll)) return false;
        const rest = d.slice(coll.length);
        if (/^[a-z0-9]/.test(rest.trimStart()) && !/^(cane|chair|chevron|hex|ledger|cnr|corner|mosaic|paver|coping|pencil|liner|\d)/.test(rest.trim())) return false;
        return normSize(r.size) === normSize(s.size);
      });
      let filtered = cands;
      const fin = (s.finish || '').toLowerCase();
      if (filtered.length > 1 && fin) {
        const f = filtered.filter(r => r.desc.toLowerCase().includes(fin));
        if (f.length) filtered = f;
      }
      if (filtered.length && filtered.every(r => r.price === filtered[0].price && r.unit === filtered[0].unit)) {
        hit = { unit: filtered[0].unit, price: filtered[0].price };
        how = 'stone desc+size';
      }
    }
    // 3) series+size(+finish) match with single-price agreement
    if (!hit && s.size) {
      const k = `${normalizeSeriesName(s.collection || '')}|${normSize(s.size)}`;
      let cands = bySeriesSize.get(k) || [];
      if (cands.length > 1 && s.finish) {
        const f = cands.filter(e => e.finish && e.finish.toLowerCase() === s.finish.toLowerCase());
        if (f.length) cands = f;
      }
      if (cands.length > 1) {
        const f = cands.filter(e => (s.name || '').toLowerCase().includes((e.finish || '').toLowerCase()) && e.finish);
        if (f.length) cands = f;
      }
      if (cands.length && cands.every(e => e.netPrice === cands[0].netPrice && e.unit === cands[0].unit)) {
        hit = { unit: cands[0].unit, price: cands[0].netPrice };
        how = `series+size${s.finish ? '+finish' : ''}`;
      }
    }
    if (!hit || !(hit.price > 0)) { unmatched.push(s); continue; }

    // Basis + cost by category/unit. BED's catalog prices retail at ~1.67–1.7×
    // cost, which disambiguates whether the stored retail is per-piece or
    // per-sqft (site-scraped retails are inconsistent about this): pick the
    // interpretation whose ratio lands in the normal band.
    const OK = r => r >= 1.25 && r <= 2.4;
    let cost, basis = null, sellBy = null, note = '';
    const isSheetCat = s.cat === 'mosaic-tile' || s.cat === 'stacked-stone';
    if (hit.unit === 'PCS' || hit.unit === 'SHT' || hit.unit === 'SET') {
      cost = hit.price; basis = 'per_unit'; sellBy = 'unit';
    } else if (isSheetCat) {
      let sheetSf = (s.pcs > 0 && s.sfbx > 0) ? s.sfbx / s.pcs : null;
      if (!sheetSf) {
        const d = parseDims(s.size);
        if (d && Math.min(d[0], d[1]) >= 4.5) sheetSf = d[0] * d[1] / 144;
      }
      const costSheet = sheetSf ? r2(hit.price * sheetSf) : null;
      if (costSheet && s.retail > 0 && OK(s.retail / costSheet)) {
        // retail is a piece price → true per-sheet/panel item
        cost = costSheet; basis = 'per_unit'; sellBy = 'unit';
        note = ` (S/F ${hit.price} × ${r2(sheetSf)}sf sheet)`;
      } else if (s.retail > 0 && OK(s.retail / hit.price)) {
        // retail is a sqft rate → field/paver variant inside a sheet-category
        // product (miscategorized product; category fix is a separate pass)
        cost = hit.price; basis = 'per_sqft'; sellBy = s.sell_by || 'box';
        note = ' (retail is per-sqft — product likely miscategorized)';
      } else if (costSheet) {
        cost = costSheet; basis = 'per_unit'; sellBy = 'unit';
        note = ` (S/F ${hit.price} × ${r2(sheetSf)}sf sheet; retail off-band)`;
      } else { unmatched.push({ ...s, why: 'sheet cat, no sheet area' }); continue; }
    } else {
      cost = hit.price; basis = 'per_sqft'; sellBy = s.sell_by || 'box';
    }

    // Retail: keep the live retail unless it no longer clears cost.
    let retail = s.retail;
    if (!(retail > cost)) {
      retail = r2(cost * 1.7); // upsertPricing nine-ends + floors it
      repriced.push({ ...s, cost, oldRetail: s.retail, newRetail: retail });
    }
    plan.push({ ...s, cost, basis, sellBy, retail, how, note });
  }

  for (const p of plan) {
    console.log(
      `  ${p.vendor_sku}  ${p.name} ${p.size ? '(' + p.size + ')' : ''}`.slice(0, 62).padEnd(63) +
      ` cost 0→$${p.cost} ${p.basis}${p.note}  retail $${p.retail}  [${p.how}]`);
  }
  if (unmatched.length) {
    console.log(`\n— unmatched (${unmatched.length}) — left at $0 —`);
    for (const u of unmatched) console.log(`  ${u.vendor_sku}  [${u.collection}] ${u.name} ${u.size ?? ''} ${u.why ?? ''}`);
  }
  if (repriced.length) {
    console.log(`\n— retail no longer clears cost, repriced keystone (${repriced.length}) —`);
    for (const r of repriced) console.log(`  ${r.vendor_sku}  ${r.name}: retail ${r.oldRetail} → ${r.newRetail} (cost ${r.cost})`);
  }
  console.log(`\n${plan.length} matched, ${unmatched.length} unmatched.`);
  if (!APPLY) { console.log('Dry run — re-run with --apply.'); await pool.end(); return; }

  const backupName = `bed-zero-cost-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(({ sku_id, vendor_sku, sell_by, price_basis, retail, sfbx, pcs }) =>
    ({ sku_id, vendor_sku, sell_by, price_basis, old_cost: 0, retail, sfbx, pcs })), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`Backup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      if (p.sellBy && p.sellBy !== p.sell_by) {
        await client.query(`UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1`, [p.sku_id, p.sellBy]);
      }
      await upsertPricing(client, p.sku_id, {
        cost: p.cost, retail_price: p.retail, price_basis: p.basis, map_price: null,
      }, { coveringFloor: true });
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} cost backfills.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
