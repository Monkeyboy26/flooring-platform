/**
 * fix-daltile-cheap-mosaics-2026-09.mjs — reprice 40 stale-import Daltile mosaic SKUs.
 *
 * Context (2026-09-03 investigation): 40 active Daltile mosaic-tile SKUs retailed at
 * $1.69–$4.39/sheet vs $27–34/sheet market (Keystones, Idyllic Blends, Uptown Glass,
 * Lucent Skies, Lavaliere, Keystones Red/Clementine). Their prices are artifacts of
 * the original 2026-04 catalog import; the SKUs were never crosswalked to the 832
 * feed (the feed renamed them, e.g. D617PENNYMT → D617PNYRDMS1P), so neither the
 * crosswalk passes nor the nightly EDI overlay ever corrected them. All 40 were
 * flagged + drafted by the 2026-08-16 underpriced pass, then reactivated unfixed.
 *
 * Fix: hand-verified live→EDI mappings (color+shape+finish+size checked against the
 * live feed). For each, mirror the crosswalk/overlay conventions so the nightly
 * daltile-edi-overlay sees no delta afterward:
 *   - SF-priced sheet goods keep the per-sheet rule (sell_by=unit/per_unit):
 *     cost = EDI $/SF × sheet sqft (deriveSheetSqft on the feed's per-pack area),
 *     retail = nine-ending(cost × 1.6); packaging gets the sheet coverage.
 *   - LF-priced border strips (Keystones MB5A/MB5B): per_unit, EDI cost as-is.
 *   - Lucent Skies: Daltile publishes no sheet size (sold by 11-SF carton, per
 *     Ferguson) → box/per_sqft with sqft_per_box=carton coverage, and the
 *     resulting mosaic-not-per-sheet violations are waived with a note.
 *
 * Idempotent: re-running skips rows whose retail already exceeds the stale-price
 * ceiling. Writes a before-backup to backend/data/. Dry-run unless --apply.
 *
 *   docker compose exec -T api node scripts/fix-daltile-cheap-mosaics-2026-09.mjs
 *   docker compose exec -T api node scripts/fix-daltile-cheap-mosaics-2026-09.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
import { deriveSheetSqft } from '../scrapers/base.js';
import { runQualityAudit } from '../quality/runner.js';

const { parse832 } = __test__;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const KEYSTONE = 1.6;
const APPLY = process.argv.includes('--apply');
// Only rows still carrying a stale cheap price are touched — anything at or above
// this is treated as already fixed (keeps re-runs and future mapping drift safe).
const STALE_RETAIL_CEILING = 8;
const round2 = (n) => Math.round(n * 100) / 100;
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;

// live_vendor_sku → { edi, carton? }  (carton: no published sheet size — sell by
// the vendor carton as box/per_sqft instead of guessing a sheet area)
const MAPPINGS = {
  // Keystones 1x1 straight-joint blends + windmill
  DK23STJ11MT: { edi: 'DK2311MS1P' },
  DK24STJ11MT: { edi: 'DK2411MS1P' },
  DK25STJ11MT: { edi: 'DK2511MS1P' },
  DK20WIN12MT: { edi: 'DK2021WINDMS1P' },
  // Keystones MB5A/MB5B border strips (feed prices per LF)
  D117MB5BMT: { edi: 'D117MB5B1P' },
  D200MB5AMT: { edi: 'D200MB5A1P' },
  D200MB5BMT: { edi: 'D200MB5B1P' },
  D317MB5AMT: { edi: 'D317MB5A1P' },
  D317MB5BMT: { edi: 'D317MB5B1P' },
  D335MB5AMT: { edi: 'D335MB5A1P' },
  D335MB5BMT: { edi: 'D335MB5B1P' },
  // Keystones penny rounds (straight + offset)
  D335PENNYMT: { edi: 'D335PNYRDMS1P' },
  D617PENNYMT: { edi: 'D617PNYRDMS1P' },
  D335ORPNY1MT: { edi: 'D335PNYORMS1P' },
  D617ORPNY1MT: { edi: 'D617PNYORMS1P' },
  D618ORPNY1MT: { edi: 'D618PNYORMS1P' },
  // Keystones Red / Clementine (premium colorbody — genuinely ~$55/SF)
  D017STJ11MT: { edi: 'D01711MS1P' },
  D017STJ22MT: { edi: 'D01722MS1P' },
  D622STJ11MT: { edi: 'D62211MS1P' },
  D622STJ22MT: { edi: 'D62222MS1P' },
  // Idyllic Blends
  IB01HEX2MX: { edi: 'IB012HEXMS1U' },
  IB04HEX2MX: { edi: 'IB042HEXMS1U' },
  IB01RNL1MX: { edi: 'IB01LNRANMSX1U' },
  IB04RNL1MX: { edi: 'IB04LNRANMSX1U' },
  // Uptown Glass hex
  UP17HEX1MX: { edi: 'UP171HEXMS1P' },
  UP18HEX1MX: { edi: 'UP181HEXMS1P' },
  UP19HEX1MX: { edi: 'UP191HEXMS1P' },
  UP23HEX1MT: { edi: 'UP231HEXMS1P' },
  UP24HEX1MT: { edi: 'UP241HEXMS1P' },
  UP25HEX1MT: { edi: 'UP251HEXMS1P' },
  UP26HEX1MT: { edi: 'UP261HEXMS1P' },
  UP27HEX1MX: { edi: 'UP271HEXMS1P' },
  UP28HEX1MX: { edi: 'UP281HEXMS1P' },
  UP29HEX1MX: { edi: 'UP291HEXMS1P' },
  // Lavaliere chain link
  LV15CHAINSEPL: { edi: 'LV15CHNLNKMS1L' },
  // Lucent Skies — no published sheet size; sold by 11-SF carton
  'LS08STK3/84ST': { edi: 'LS08384MS1P', carton: true },
  'LS09STK3/84ST': { edi: 'LS09384MS1P', carton: true },
  'LS10STK3/84ST': { edi: 'LS10384MS1P', carton: true },
  'LS11STK3/84ST': { edi: 'LS11384MS1P', carton: true },
  'LS12STK3/84ST': { edi: 'LS12384MS1P', carton: true },
};

// ── fetch current (non-archive) 832 feed ──
const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const ftp = await createFtpConnection(cfg);
const items = [];
try {
  const files = (await findRemote832Files(ftp)).filter((f) => !/archive/i.test(f.remotePath));
  for (const f of files) {
    const local = '/tmp/dal-cheapfix-' + f.name;
    await ftp.downloadTo(local, f.remotePath);
    try { items.push(...parse832(fs.readFileSync(local, 'utf-8')).items); } catch (e) { console.error('parse fail', f.name, e.message); }
    try { fs.unlinkSync(local); } catch {}
  }
} finally { try { ftp.close(); } catch {} }
const byEdiSku = new Map(items.filter((it) => it.vendor_sku).map((it) => [it.vendor_sku.toUpperCase(), it]));
console.log(`feed: ${items.length} EDI items`);

// ── load the live rows ──
const live = (await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, s.sell_by, s.status, p.id product_id, p.name,
         s.variant_name, pr.cost, pr.retail_price, pr.price_basis, pr.sale_price,
         COALESCE(pr.retail_locked, false) retail_locked,
         pk.sqft_per_box pk_spb, pk.pieces_per_box pk_ppb
  FROM skus s
  JOIN products p ON p.id = s.product_id AND p.vendor_id = $1
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.vendor_sku = ANY($2)`, [DAL, Object.keys(MAPPINGS)])).rows;

const plan = [], skipped = [];
for (const r of live) {
  const m = MAPPINGS[r.vendor_sku];
  const edi = byEdiSku.get(m.edi.toUpperCase());
  if (!edi || !(edi.cost > 0)) { skipped.push([r.vendor_sku, `EDI ${m.edi} not in feed / unpriced`]); continue; }
  if (Number(r.retail_price) >= STALE_RETAIL_CEILING) { skipped.push([r.vendor_sku, `retail $${r.retail_price} already above stale ceiling`]); continue; }
  const uom = (edi.unit_of_measure || '').toUpperCase();
  const perSqftFeed = uom === 'SF' || uom === 'SY';
  if (perSqftFeed && edi.cost < 3) { skipped.push([r.vendor_sku, `EDI cost $${edi.cost}/SF implausibly low — check mapping`]); continue; }

  let out;
  if (m.carton) {
    // carton model: box/per_sqft at the feed's per-SF cost + carton coverage
    if (!perSqftFeed || !(edi.sqft_per_box > 0)) { skipped.push([r.vendor_sku, 'carton mode needs SF price + carton coverage']); continue; }
    out = {
      sell_by: 'box', basis: 'per_sqft', cost: round2(edi.cost),
      spb: edi.sqft_per_box, ppb: edi.pieces_per_box || null, note: `carton ${edi.sqft_per_box} SF`,
    };
  } else if (perSqftFeed) {
    // per-sheet rule: convert $/SF → $/sheet via the feed's per-pack sheet area
    const sheetSqft = deriveSheetSqft(edi.sqft_per_box, edi.pieces_per_box);
    if (!sheetSqft) { skipped.push([r.vendor_sku, `sheet coverage underivable (spb=${edi.sqft_per_box} ppb=${edi.pieces_per_box})`]); continue; }
    out = {
      sell_by: 'unit', basis: 'per_unit', cost: round2(edi.cost * sheetSqft),
      spb: edi.sqft_per_box, ppb: edi.pieces_per_box || 1, note: `$${edi.cost}/SF × ${sheetSqft} SF sheet`,
    };
  } else {
    // LF/EA/PC — per-piece as quoted
    out = { sell_by: 'unit', basis: 'per_unit', cost: round2(edi.cost), spb: null, ppb: null, note: `$${edi.cost}/${uom || '?'} as-is` };
  }
  out.retail = r.retail_locked ? Number(r.retail_price) : nineEnding(out.cost * KEYSTONE);
  plan.push({ ...r, ...out, edi_sku: m.edi });
}

console.log(`\nPLAN: ${plan.length} to fix | ${skipped.length} skipped`);
for (const p of plan) {
  console.log(`  ${p.vendor_sku.padEnd(14)} → ${p.edi_sku.padEnd(16)} | $${p.retail_price}/${p.price_basis} → $${p.retail}/${p.basis} (cost $${p.cost}; ${p.note})${p.sale_price ? ' [clears stale sale_price]' : ''}`);
}
for (const [sku, why] of skipped) console.log(`  SKIP ${sku}: ${why}`);
const missing = Object.keys(MAPPINGS).filter((k) => !live.some((r) => r.vendor_sku === k));
if (missing.length) console.log(`  NOT IN DB: ${missing.join(', ')}`);

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }
if (!plan.length) { console.log('nothing to apply'); await pool.end(); process.exit(0); }

// before-backup
const backupPath = path.join(__dirname, '..', 'data', `daltile-cheap-mosaic-fix-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backupPath, JSON.stringify(live, null, 2));
console.log(`\nbackup: ${backupPath}`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const p of plan) {
    await client.query(
      `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
       VALUES ($1,$2,'high','manual:cheap-mosaic-fix-2026-09')
       ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
      [p.vendor_sku, p.edi_sku]);
    await client.query(
      `INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, price_basis=EXCLUDED.price_basis,
         retail_price=CASE WHEN pricing.retail_locked THEN pricing.retail_price ELSE EXCLUDED.retail_price END,
         sale_price=NULL, sale_ends_at=NULL`,
      [p.sku_id, p.cost, p.retail, p.basis]);
    await client.query(`UPDATE skus SET sell_by=$2, updated_at=now() WHERE id=$1`, [p.sku_id, p.sell_by]);
    if (p.spb) {
      await client.query(
        `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
         ON CONFLICT (sku_id) DO UPDATE SET
           sqft_per_box=COALESCE(packaging.sqft_per_box, EXCLUDED.sqft_per_box),
           pieces_per_box=COALESCE(packaging.pieces_per_box, EXCLUDED.pieces_per_box)`,
        [p.sku_id, p.spb, p.ppb]);
    }
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
console.log(`APPLIED: mapped + repriced ${plan.length} SKUs.`);

const prods = [...new Set(plan.map((p) => p.product_id))];
for (const id of prods) await pool.query('SELECT refresh_search_vectors($1)', [id]).catch(() => {});
console.log(`refreshed search vectors (${prods.length} products)`);

// Re-audit the affected rules, then waive the expected Lucent Skies carton rows
// (box/per_sqft is deliberate there — no published sheet size to sell by).
const cartonSkuIds = plan.filter((p) => p.sell_by === 'box').map((p) => p.sku_id);
await runQualityAudit(pool, { vendorId: DAL, triggeredBy: 'fix-daltile-cheap-mosaics-2026-09', ruleKeys: ['mosaic-not-per-sheet', 'mosaic-underpriced'] });
if (cartonSkuIds.length) {
  const { rowCount } = await pool.query(
    `UPDATE quality_violations SET status='waived', waived_by='fix-daltile-cheap-mosaics-2026-09',
       waived_at=now(), waive_note='Daltile publishes no sheet size for Lucent Skies — sold by 11-SF carton (box/per_sqft) like Ferguson; do not convert to per-sheet without real sheet coverage'
     WHERE rule_key='mosaic-not-per-sheet' AND status='open' AND sku_id = ANY($1)`, [cartonSkuIds]);
  console.log(`waived ${rowCount} expected mosaic-not-per-sheet violation(s) for Lucent Skies cartons`);
}
console.log('audit re-run complete');
await pool.end();
