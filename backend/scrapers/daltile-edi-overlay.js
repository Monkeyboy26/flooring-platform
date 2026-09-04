/**
 * Daltile — EDI Price Overlay (productized)
 *
 * Applies authoritative EDI 832 pricing onto the LIVE, image-bearing Daltile catalog.
 *
 * Why this exists: our live Daltile catalog was built from a website/Coveo scrape
 * (has images + marketing names, but had wrong prices) using codes like VF05TPZ13GS.
 * The 832 EDI feed owns the correct price/UOM but uses different codes (VF0513TRAPMS1P)
 * and carries NO images. Neither source is complete, so we JOIN them: this module copies
 * the fixed-parser EDI price onto each mapped live SKU via the persistent `daltile_edi_map`.
 * It never touches media or coverage, so the storefront keeps its images.
 *
 * Run nightly after daltile-832. Idempotent; backs up changed rows to daltile_overlay_backup.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse832, getFtpConfig } from './daltile-832.js';
import { appendLog, deriveSheetSqft } from './base.js';

const DAL_VENDOR_ID = '550e8400-e29b-41d4-a716-446655440003';
const KEYSTONE = 1.6;
// retail: round DOWN to nearest .x9 (platform nine-ending convention)
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;
// Live outbox only — NOT the Archive (stale catalogs would override current prices,
// and there are ~130 of them). Configurable via source.config.outbox_dir.
const DEFAULT_OUTBOX = '/users/7149990009/Outbox';

/** Build edi vendor_sku -> {cost, basis, sell_by} from parsed 832 catalog items. */
export function ediPriceMap(items) {
  const m = new Map();
  for (const it of items) {
    if (!it.vendor_sku || it.cost == null) continue;
    const uom = (it.unit_of_measure || '').toUpperCase();
    const sell_by = it.sell_by || (uom === 'SF' || uom === 'SY' ? 'box' : 'unit');
    const basis = sell_by === 'box' ? 'per_sqft' : 'per_unit';
    m.set(it.vendor_sku, {
      cost: it.cost, basis, sell_by,
      sqft_per_box: it.sqft_per_box || null, pieces_per_box: it.pieces_per_box || null,
    });
  }
  return m;
}

/**
 * Core DB step: overlay `ediMap` prices onto mapped live active Daltile SKUs.
 * - Always refreshes cost + retail (retail = cost x keystone, but retail_locked rows keep theirs).
 * - Only SETS price_basis / sell_by when the live value is missing — never overwrites an
 *   existing basis. The one-time cutover already fixed bases, and flipping basis nightly
 *   regresses selling conventions (mosaics / ledger / stacked stone are sold per sheet, not
 *   per SF, even though the feed may tag them SF).
 * - Never writes media or coverage (sqft_per_box) — those stay from the live catalog.
 * Returns stats; set dryRun to roll back.
 */
export async function overlayFromEdiMap(pool, ediMap, { dryRun = false } = {}) {
  const client = await pool.connect();
  const stats = { mapped: 0, missingEdiPrice: 0, updated: 0, unchanged: 0, basisInit: 0, sheetAmbiguous: 0 };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS daltile_overlay_backup (
      sku_id uuid, live_vendor_sku text, sell_by text, cost numeric, retail_price numeric,
      price_basis text, retail_locked boolean, backed_up_at timestamptz DEFAULT now())`);
    const { rows } = await client.query(`
      SELECT ls.id AS sku_id, m.live_vendor_sku, m.edi_vendor_sku,
             pr.cost AS cur_cost, pr.retail_price AS cur_retail, pr.price_basis AS cur_basis,
             COALESCE(pr.retail_locked, false) AS retail_locked, ls.sell_by AS cur_sell_by,
             ls.variant_type, c.slug AS category,
             pk.sqft_per_box AS pk_sqft_per_box, pk.pieces_per_box AS pk_pieces_per_box
      FROM daltile_edi_map m
      JOIN skus ls ON ls.vendor_sku = m.live_vendor_sku AND ls.status = 'active'
      JOIN products p ON p.id = ls.product_id AND p.vendor_id = $1
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN packaging pk ON pk.sku_id = ls.id
      LEFT JOIN pricing pr ON pr.sku_id = ls.id`, [DAL_VENDOR_ID]);
    for (const r of rows) {
      stats.mapped++;
      const ep = ediMap.get(r.edi_vendor_sku);
      if (!ep) { stats.missingEdiPrice++; continue; }
      // Per-sheet rule (see migrate-mosaic-per-sheet.mjs): mosaics/stacked stone
      // sold per sheet carry a per-SHEET cost, but the 832 quotes per-SF. Convert
      // via sheet coverage (live packaging first, else the feed's per-pack area).
      // When coverage can't be derived, SKIP — writing a per-SF cost into a
      // per-sheet row is how sheets ended up retailing below cost.
      let effCost = ep.cost;
      const sellsPerSheet = r.cur_basis === 'per_unit'
        && (r.category === 'mosaic-tile' || r.category === 'stacked-stone')
        && r.variant_type !== 'accessory';
      if (sellsPerSheet && ep.basis === 'per_sqft') {
        const sheetSqft = deriveSheetSqft(r.pk_sqft_per_box, r.pk_pieces_per_box)
          || deriveSheetSqft(ep.sqft_per_box, ep.pieces_per_box);
        if (!sheetSqft) { stats.sheetAmbiguous++; continue; }
        effCost = ep.cost * sheetSqft;
      }
      const newCost = Math.round(effCost * 100) / 100;
      const newRetail = r.retail_locked
        ? r.cur_retail
        : (newCost > 0 ? nineEnding(newCost * KEYSTONE) : 0);
      // Only initialize basis/sell_by when the live value is missing; never overwrite.
      const basisMissing = !r.cur_basis;
      const sellByMissing = !r.cur_sell_by;
      const targetBasis = basisMissing ? ep.basis : r.cur_basis;
      const targetSellBy = sellByMissing ? ep.sell_by : r.cur_sell_by;
      const priceChanged = Number(r.cur_cost) !== newCost;
      const basisChanged = basisMissing || sellByMissing;
      if (!priceChanged && !basisChanged) { stats.unchanged++; continue; }
      await client.query(
        `INSERT INTO daltile_overlay_backup
           (sku_id, live_vendor_sku, sell_by, cost, retail_price, price_basis, retail_locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.sku_id, r.live_vendor_sku, r.cur_sell_by, r.cur_cost, r.cur_retail, r.cur_basis, r.retail_locked]);
      await client.query(
        `INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku_id) DO UPDATE SET
           cost = EXCLUDED.cost, price_basis = EXCLUDED.price_basis,
           retail_price = CASE WHEN pricing.retail_locked THEN pricing.retail_price ELSE EXCLUDED.retail_price END`,
        [r.sku_id, newCost, newRetail, targetBasis]);
      if (sellByMissing) {
        await client.query(`UPDATE skus SET sell_by = $2, updated_at = now() WHERE id = $1`,
          [r.sku_id, targetSellBy]);
      }
      if (basisChanged) stats.basisInit++;
      stats.updated++;
    }
    if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
  return stats;
}

/** Download + parse all 832 files, merged into one edi price map. */
async function fetchEdiPriceMap(source, job, pool) {
  const cfg = getFtpConfig(source);
  // Test / offline hook: parse a local file instead of hitting FTP.
  const local = (source.config || {}).local_edi_file;
  if (local) {
    const items = parse832(fs.readFileSync(local, 'latin1')).items;
    return ediPriceMap(items);
  }
  const outboxDir = (source.config || {}).outbox_dir || DEFAULT_OUTBOX;
  const client = new FtpClient(60000);
  const map = new Map();
  try {
    await client.access({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, secure: false });
    // Current outbox only. Sort oldest→newest so newer files (deltas / re-sends)
    // override older prices per SKU (newest-wins), not arbitrary parse order.
    const listing = (await client.list(outboxDir))
      .filter(f => f.isFile && /832|catalog|pricelist/i.test(f.name))
      .sort((a, b) => (a.modifiedAt?.getTime?.() || 0) - (b.modifiedAt?.getTime?.() || 0));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dal-overlay-'));
    for (const f of listing) {
      const localPath = path.join(tmpDir, f.name);
      try {
        await client.downloadTo(localPath, `${outboxDir}/${f.name}`);
        const fileMap = ediPriceMap(parse832(fs.readFileSync(localPath, 'latin1')).items);
        for (const [sku, v] of fileMap) map.set(sku, v);   // newest file wins
      } catch (e) {
        if (job) await appendLog(pool, job.id, `[overlay] skip ${f.name}: ${e.message}`);
      } finally {
        try { fs.unlinkSync(localPath); } catch {}
      }
    }
    try { fs.rmdirSync(tmpDir); } catch {}
  } finally {
    client.close();
  }
  return map;
}

/** Pipeline entrypoint. */
export async function run(pool, job, source) {
  if (job) await appendLog(pool, job.id, 'Daltile EDI overlay: fetching + parsing 832 feed…');
  const ediMap = await fetchEdiPriceMap(source, job, pool);
  if (job) await appendLog(pool, job.id, `Parsed ${ediMap.size} EDI-priced SKUs. Applying overlay…`);
  const dryRun = (source.config || {}).dry_run === true;
  const stats = await overlayFromEdiMap(pool, ediMap, { dryRun });
  const msg = `Daltile EDI overlay ${dryRun ? '(DRY RUN) ' : ''}complete: ${stats.updated} repriced, `
    + `${stats.unchanged} unchanged, ${stats.missingEdiPrice} mapped-but-not-in-feed, `
    + `${stats.sheetAmbiguous} sheet-coverage-unknown skipped (of ${stats.mapped} mapped).`;
  if (job) await appendLog(pool, job.id, msg, stats);
  return stats;
}
