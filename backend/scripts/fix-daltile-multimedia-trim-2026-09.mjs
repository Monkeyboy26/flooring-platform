/**
 * fix-daltile-multimedia-trim-2026-09.mjs — crosswalk 62 Daltile SKUs whose stale
 * 2026-04 import prices were never EDI-verified (feed renamed their codes).
 *
 * Found in the 2026-09-03 pricing audit (follow-up to fix-daltile-cheap-mosaics):
 *   - Multimedia LVT/LVP (TitanGuard): 26 SKUs store the PER-PIECE price as the
 *     per-sqft rate — 18x36 planks (4.5 sqft) at $34.69/sqft retail and 18x18
 *     tiles (2.25 sqft) at $17.29/sqft, vs the feed's $4.82/SF (their own 9x72
 *     siblings are correctly at $7.69/sqft retail). ~4.5x / ~2.25x OVERPRICED.
 *     The 10 correct 9x72s are mapped too so the whole line tracks the feed.
 *   - Grantshire vinyl trim: quarter round $97.19 vs feed $16.10/PC (~4x over),
 *     slim cap $97.19 vs feed $47.71/PC.
 *   - Keystones C701 cove base (24 colors): NOT mispriced — pieces are 12" strips
 *     so per-piece == per-LF and current prices match the feed. Mapped only so
 *     costs stay current with EDI updates.
 *
 * This script ONLY inserts daltile_edi_map rows (after verifying each EDI code
 * exists in the live feed with a sane price and compatible UOM). Run the
 * daltile-edi-overlay afterwards to apply pricing through the canonical path
 * (it backs up changed rows to daltile_overlay_backup):
 *
 *   docker compose exec -T api node scripts/fix-daltile-multimedia-trim-2026-09.mjs          # dry run
 *   docker compose exec -T api node scripts/fix-daltile-multimedia-trim-2026-09.mjs --apply  # write map rows
 *   docker compose exec -T api node run-scraper.cjs daltile-edi-overlay                      # reprice
 */
import fs from 'fs';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';

const { parse832 } = __test__;
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const KEYSTONE = 1.6;
const APPLY = process.argv.includes('--apply');
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;

// live_vendor_sku → edi_vendor_sku. Renaming is mechanical per line:
//   Multimedia G18365M20L → G183620ML5M · G18185M20L → G181820ML5M · G9725M20L → GD97220ML5M
//   Grantshire vinyl trim ST → SX (SuperGuard → SuperGuardX)
//   Keystones C701MT → C701PM1P
const MAPPINGS = {};
// Multimedia: MT20-23 Stone + MF40-45 Fabric (18x36 + 9x72); MC80-83 Concrete + MZ30-33 Terrazzo (18x36 + 18x18)
for (const stem of ['MT20', 'MT21', 'MT22', 'MT23', 'MF40', 'MF41', 'MF42', 'MF43', 'MF44', 'MF45']) {
  MAPPINGS[`${stem}G18365M20L`] = `${stem}G183620ML5M`;
  MAPPINGS[`${stem}G9725M20L`] = `${stem}GD97220ML5M`;
}
for (const stem of ['MC80', 'MC81', 'MC82', 'MC83', 'MZ30', 'MZ31', 'MZ32', 'MZ33']) {
  MAPPINGS[`${stem}G18365M20L`] = `${stem}G183620ML5M`;
  MAPPINGS[`${stem}G18185M20L`] = `${stem}G181820ML5M`;
}
// Grantshire vinyl trim
MAPPINGS['GR41VQRNDST'] = 'GR41VQRNDSX';
MAPPINGS['GR41VSLCAPST'] = 'GR41VSLCAPSX';
// Keystones C701 cove base — all 24 live colors
for (const stem of ['D014', 'D037', 'D090', 'D116', 'D117', 'D118', 'D144', 'D148', 'D160', 'D161',
  'D169', 'D182', 'D195', 'D197', 'D200', 'D201', 'D202', 'D208', 'D311', 'D335', 'D617',
  'D619', 'D620', 'D621']) {
  MAPPINGS[`${stem}C701MT`] = `${stem}C701PM1P`;
}

// ── fetch current (non-archive) 832 feed, newest file wins (overlay convention),
//    with reconnect+retry (Daltile FTP resets data sockets) ──
const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const byEdiSku = new Map();
{
  let ftp = await createFtpConnection(cfg);
  try {
    const files = (await findRemote832Files(ftp))
      .filter((f) => !/archive/i.test(f.remotePath))
      .sort((a, b) => (a.modifiedAt?.getTime?.() || 0) - (b.modifiedAt?.getTime?.() || 0));
    for (const f of files) {
      const local = '/tmp/dal-mmfix-' + f.name;
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try { await ftp.downloadTo(local, f.remotePath); ok = true; }
        catch (e) {
          console.error(`download ${f.name} attempt ${attempt}: ${e.message}`);
          try { ftp.close(); } catch {}
          ftp = await createFtpConnection(cfg);
        }
      }
      if (!ok) { console.error(`SKIPPING ${f.name} after 3 attempts`); continue; }
      try {
        for (const it of parse832(fs.readFileSync(local, 'utf-8')).items) {
          if (it.vendor_sku && it.cost > 0) byEdiSku.set(it.vendor_sku.toUpperCase(), it);
        }
      } catch (e) { console.error('parse fail', f.name, e.message); }
      try { fs.unlinkSync(local); } catch {}
    }
  } finally { try { ftp.close(); } catch {} }
}
console.log(`feed: ${byEdiSku.size} priced EDI items`);

const live = (await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, s.sell_by, pr.cost, pr.retail_price, pr.price_basis,
         m.edi_vendor_sku AS already_mapped_to
  FROM skus s
  JOIN products p ON p.id = s.product_id AND p.vendor_id = $1
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN daltile_edi_map m ON m.live_vendor_sku = s.vendor_sku
  WHERE s.vendor_sku = ANY($2) AND s.status = 'active'`, [DAL, Object.keys(MAPPINGS)])).rows;

const plan = [], skipped = [];
for (const r of live) {
  const ediSku = MAPPINGS[r.vendor_sku];
  const edi = byEdiSku.get(ediSku.toUpperCase());
  if (!edi) { skipped.push([r.vendor_sku, `EDI ${ediSku} not in feed`]); continue; }
  if (r.already_mapped_to && r.already_mapped_to !== ediSku) { skipped.push([r.vendor_sku, `already mapped to ${r.already_mapped_to}`]); continue; }
  const uom = (edi.unit_of_measure || '').toUpperCase();
  const perSqftFeed = uom === 'SF' || uom === 'SY';
  // UOM must agree with how the live row sells — a mismatch means a wrong match
  if ((r.price_basis === 'per_sqft') !== perSqftFeed) { skipped.push([r.vendor_sku, `UOM mismatch: live ${r.price_basis} vs feed ${uom}`]); continue; }
  plan.push({
    live: r.vendor_sku, edi: ediSku, oldCost: Number(r.cost), oldRetail: Number(r.retail_price),
    newCost: edi.cost, newRetail: nineEnding(edi.cost * KEYSTONE), uom,
  });
}

console.log(`\nPLAN: ${plan.length} map rows | ${skipped.length} skipped`);
for (const p of plan.sort((a, b) => a.live.localeCompare(b.live))) {
  console.log(`  ${p.live.padEnd(15)} → ${p.edi.padEnd(16)} | $${p.oldCost}→$${p.newCost}/${p.uom} cost, retail $${p.oldRetail}→~$${p.newRetail}`);
}
for (const [sku, why] of skipped) console.log(`  SKIP ${sku}: ${why}`);
const missing = Object.keys(MAPPINGS).filter((k) => !live.some((r) => r.vendor_sku === k));
if (missing.length) console.log(`  NOT LIVE/ACTIVE: ${missing.join(', ')}`);

if (!APPLY) { console.log('\n(dry run — pass --apply to write map rows, then run daltile-edi-overlay)'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const p of plan) {
    await client.query(
      `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
       VALUES ($1,$2,'high','manual:multimedia-trim-fix-2026-09')
       ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
      [p.live, p.edi]);
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
console.log(`\nAPPLIED: ${plan.length} map rows. Now run: node run-scraper.cjs daltile-edi-overlay`);
await pool.end();
