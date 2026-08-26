/**
 * Daltile crosswalk backfill — map orphaned "super-cheap" live SKUs to the EDI feed.
 *
 * Why: the live Daltile catalog is a website/Coveo scrape (images + marketing names,
 * WRONG prices, descriptive codes like D317STJ11MT / EX31G74725M20L). Correct prices
 * come from the EDI 832 under DIFFERENT codes (D31711MS1P / EX31747GD1P), joined via
 * `daltile_edi_map`; `daltile-edi-overlay` overlays price onto MAPPED live SKUs nightly.
 * Some lines (Keystones field mosaics, EX/CY/PT LVP planks) were never mapped, so they
 * kept the scrape's cheap prices and had to be drafted. This tool matches them to the
 * EDI by decoded code attributes, inserts the missing map rows, sets the correct
 * per-sqft price + coverage, and reactivates them. See [[unit-basis-price-bugs]].
 *
 * Scope: Daltile SKUs that are status='draft', NOT already in daltile_edi_map, whose
 * vendor_sku is in the website-scrape LVP/mosaic format (EX/CY/PT + color, or
 * D### + STJ/HEX/PENNY). Targets by CODE FORMAT, not price, so it's robust to any
 * interim reprice. Idempotent. Dry-run by default; pass --apply.
 *
 *   docker exec flooring-api node scripts/daltile-crosswalk-backfill.mjs [--apply]
 *
 * Matches (field tile / plank only — never per-LF trim or per-PC stair treads):
 *   LVP plank : <linePrefix><colorCode> + mil   ↔ EDI plank SF item (same prefix/color/mil)
 *   mosaic    : color(3) + shape + size + finish + offset ↔ EDI Keystones SF field item
 * Leaves unmatched (blends, mini-brick cove-base trim, offset/ambiguous pennies) drafted.
 */
import fs from 'fs';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
const { parse832 } = __test__;

const DAL = '550e8400-e29b-41d4-a716-446655440003';
const KEYSTONE = 1.6;
const APPLY = process.argv.includes('--apply');
const round2 = (n) => Math.round(n * 100) / 100;

// ── EDI key parsers (field tile / plank only) ────────────────────────────────
function ediLvpKey(it) {
  const name = (it.product_name || '').toLowerCase();
  if (!/plank/.test(name)) return null;                 // exclude stair treads / mosaix
  if ((it.unit_of_measure || '').toUpperCase() !== 'SF') return null;
  const pc = (it.vendor_sku || '').match(/^([A-Z]{2})(\d\d)/);
  const mil = name.match(/(\d+)\s*mil/);
  if (!pc || !mil) return null;
  return `${pc[1]}|${pc[2]}|${mil[1]}`;
}
function liveLvpKey(sku) {
  const s = (sku || '').toUpperCase();
  const pc = s.match(/^([A-Z]{2})(\d\d)/);
  const mil = s.match(/M(\d+)L/);
  if (!pc || !mil) return null;
  return `${pc[1]}|${pc[2]}|${mil[1]}`;
}
function ediMosaicKey(it) {
  const code = (it.vendor_sku || '').toUpperCase();
  const name = (it.product_name || '').toLowerCase();
  if ((it.unit_of_measure || '').toUpperCase() !== 'SF') return null; // trim/base = LF/PC
  const cc = code.match(/^D(\d{3})/); if (!cc) return null;
  const shape = /penny/.test(name) ? 'penny' : /hexagon|hex/.test(name) ? 'hex' : /straight joint/.test(name) ? 'stj' : null;
  if (!shape) return null;
  const offset = /HEXOR|ORHEX|\bOR\b/.test(code) ? 'o' : '';
  const finish = /MS1A|abrasive|\bab\b/i.test(code + ' ' + name) ? 'ab' : /TXMS|textured|\btx\b/i.test(code + ' ' + name) ? 'tx' : 'mt';
  let size = '';
  if (shape === 'stj') { const m = code.match(/^D\d{3}(\d\d)/); size = m ? m[1] : ''; }
  else if (shape === 'hex') { const m = code.match(/(\d)HEX/); size = m ? m[1] : '1'; }
  return `${cc[1]}|${shape}|${size}|${finish}|${offset}`;
}
function liveMosaicKey(sku) {
  const code = (sku || '').toUpperCase();
  const cc = code.match(/^D(\d{3})/); if (!cc) return null;            // skip DK blends
  const shape = /PENNY|PNY/.test(code) ? 'penny' : /HEX/.test(code) ? 'hex' : /STJ/.test(code) ? 'stj' : null;
  if (!shape) return null;                                             // skip MB build-up base (trim)
  const offset = /OR/.test(code.replace(/^D\d{3}/, '')) ? 'o' : '';
  const finish = /AB$|AB[A-Z]/.test(code) ? 'ab' : /TX$|TX[A-Z]/.test(code) ? 'tx' : 'mt';
  let size = '';
  if (shape === 'stj') { const m = code.match(/STJ(\d\d)/); size = m ? m[1] : ''; }
  else if (shape === 'hex') { const m = code.match(/HEX(\d\d?)/); size = m ? (m[1] === '22' ? '2' : m[1] === '11' ? '1' : m[1]) : '1'; }
  return `${cc[1]}|${shape}|${size}|${finish}|${offset}`;
}

// ── fetch + merge all current (non-archive) 832 files ────────────────────────
async function fetchEdiItems(ediConfig) {
  const ftp = await createFtpConnection(ediConfig);
  try {
    const files = (await findRemote832Files(ftp)).filter(f => !/archive/i.test(f.remotePath));
    const items = [];
    for (const f of files) {
      const local = '/tmp/dal-xwalk-' + f.name;
      await ftp.downloadTo(local, f.remotePath);
      try { items.push(...parse832(fs.readFileSync(local, 'utf-8')).items); } catch {}
      fs.unlinkSync(local);
    }
    return items;
  } finally { try { ftp.close(); } catch {} }
}

// ── main ─────────────────────────────────────────────────────────────────────
const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const items = await fetchEdiItems(cfg);
console.log(`parsed ${items.length} EDI items`);

const lvpIdx = new Map(), mosIdx = new Map();
for (const it of items) {
  const lk = ediLvpKey(it); if (lk) { (lvpIdx.get(lk) || lvpIdx.set(lk, []).get(lk)).push(it); continue; }
  const mk = ediMosaicKey(it); if (mk) (mosIdx.get(mk) || mosIdx.set(mk, []).get(mk)).push(it);
}

const live = (await pool.query(`
  SELECT s.id AS sku_id, s.vendor_sku, c.slug AS cat
  FROM skus s JOIN products p ON p.id=s.product_id JOIN pricing pr ON pr.sku_id=s.id
  LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.vendor_id=$1 AND s.status='draft'
    AND (s.vendor_sku ~ '^(EX|CY|PT)[0-9][0-9]' OR s.vendor_sku ~ '^D[0-9]{3}(STJ|HEX|PENNY)')
    AND NOT EXISTS (SELECT 1 FROM daltile_edi_map m WHERE m.live_vendor_sku=s.vendor_sku)
  ORDER BY c.slug, s.vendor_sku`, [DAL])).rows;

const matches = [], skipped = [];
for (const r of live) {
  const lk = liveLvpKey(r.vendor_sku), lc = lk && lvpIdx.get(lk);
  if (lc && lc.length === 1) { matches.push({ ...r, edi: lc[0], method: 'lvp line+color+mil' }); continue; }
  const mk = liveMosaicKey(r.vendor_sku), mc = mk && mosIdx.get(mk);
  if (mc && mc.length === 1) { matches.push({ ...r, edi: mc[0], method: 'mosaic color+shape+size+finish' }); continue; }
  skipped.push({ ...r, why: lk ? (lc ? lc.length + ' LVP candidates' : 'no LVP match ' + lk) : mk ? (mc ? mc.length + ' mosaic candidates' : 'no mosaic match ' + mk) : 'unparseable (blend/trim)' });
}

console.log('\nMATCHED:');
matches.forEach(m => console.log('  ', m.vendor_sku, '→', m.edi.vendor_sku, '$' + m.edi.cost + '/' + m.edi.unit_of_measure, '→ $' + round2(m.edi.cost * KEYSTONE), 'spb=' + m.edi.sqft_per_box, '|', m.method));
console.log('\nSKIPPED (stay drafted):');
skipped.forEach(s => console.log('  ', s.vendor_sku, '::', s.why));
console.log(`\n== matched ${matches.length} | skipped ${skipped.length} | total ${live.length} ==`);

if (APPLY && matches.length) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of matches) {
      await client.query(
        `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
         VALUES ($1,$2,'high',$3)
         ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
        [m.vendor_sku, m.edi.vendor_sku, m.method]);
      await client.query(
        `UPDATE pricing SET cost=$2, retail_price=CASE WHEN retail_locked THEN retail_price ELSE $3 END, price_basis='per_sqft' WHERE sku_id=$1`,
        [m.sku_id, round2(m.edi.cost), round2(m.edi.cost * KEYSTONE)]);
      if (m.edi.sqft_per_box > 0) {
        await client.query(
          `INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
           ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=COALESCE(packaging.sqft_per_box, EXCLUDED.sqft_per_box)`,
          [m.sku_id, m.edi.sqft_per_box]);
      }
      await client.query(`UPDATE skus SET sell_by='box', status='active', updated_at=now() WHERE id=$1`, [m.sku_id]);
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED: mapped + repriced + reactivated ${matches.length} SKUs.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
} else if (!APPLY) {
  console.log('\n(dry run — pass --apply to write)');
}
await pool.end();
