// Repair primaries flagged by the broken-image rule.
//
// For each open broken-image violation:
//   1. Re-check the flagged primary URL — if it resolves now (CDN hiccup,
//      mirror caught up), leave it (the next heavy audit auto-closes it).
//   2. Else look for a WORKING sibling image on the same SKU (then the same
//      product): test each candidate's live URL (original_url || url) and, if
//      one resolves, promote it to 'primary' (sort_order 0) and demote the dead
//      row to 'lifestyle_hidden' (a type no customer-facing query renders — see
//      storefront.jsx:8504 allow-list). Principle: no image > wrong/broken image.
//   3. Else (no working candidate) record it as unresolved — needs a re-source,
//      not a swap, so we leave the row and report it.
//
//   node fix-broken-primary-images-2026-11.mjs [--dry-run | --apply]
//
// Idempotent: a promoted row is no longer 'primary'-broken next run; an
// unresolved row stays flagged. Writes a JSON backup of every row it changes.

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');

async function checkUrl(url) {
  if (!url) return 'no-url';
  if (url.includes('&amp;')) url = url.replace(/&amp;/gi, '&');
  if (/[ -￿]/.test(url)) url = encodeURI(url);
  for (const method of ['HEAD', 'GET']) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        method, redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RomaQualityBot/1.0' },
      });
      clearTimeout(timer);
      if (res.body && method === 'GET') { try { await res.body.cancel(); } catch {} }
      if (res.ok) return 'ok';
      if (method === 'GET') return `http ${res.status}`;
      if (res.status !== 405 && res.status !== 403 && res.status !== 400) return `http ${res.status}`;
    } catch (err) {
      if (method === 'GET') return err.name === 'AbortError' ? 'timeout' : 'unreachable';
    }
  }
  return 'ok';
}

// Resolve the actual URL a mirrored row serves (prefer the mirror, fall back to
// the vendor original) — the storefront serves `url`, so test that first.
const liveUrl = (m) => m.url || m.original_url;

const { rows: vios } = await pool.query(`
  SELECT qv.id AS violation_id, (qv.detail->>'media_id')::uuid AS media_id, qv.product_id
  FROM quality_violations qv
  WHERE qv.status='open' AND qv.rule_key='broken-image'
`);
console.log(`${vios.length} open broken-image violations`);

const changes = [];   // { action, media_id, ... } for backup
let stillBroken = 0, healed = 0, promoted = 0, unresolved = 0;
const unresolvedList = [];

for (const v of vios) {
  if (!v.media_id) { unresolved++; unresolvedList.push({ product_id: v.product_id, reason: 'no media_id in detail' }); continue; }
  const { rows: broken } = await pool.query(
    `SELECT id, sku_id, product_id, url, original_url, asset_type, sort_order FROM media_assets WHERE id=$1`, [v.media_id]);
  if (!broken.length) { healed++; continue; } // row gone => resolved
  const b = broken[0];
  const bStatus = await checkUrl(liveUrl(b));
  if (bStatus === 'ok') { healed++; continue; }        // resolves now
  stillBroken++;

  // Candidate pool: same SKU first, then product-level siblings. Exclude the
  // broken row and spec PDFs. Prefer alternate, then lifestyle/swatch, then other primary.
  const { rows: cands } = await pool.query(`
    SELECT id, sku_id, url, original_url, asset_type, sort_order FROM media_assets
    WHERE id <> $1 AND asset_type <> 'spec_pdf'
      AND ( ($2::uuid IS NOT NULL AND sku_id = $2) OR (sku_id IS NULL AND product_id = $3) )
    ORDER BY (sku_id = $2) DESC NULLS LAST,
             CASE asset_type WHEN 'alternate' THEN 0 WHEN 'lifestyle' THEN 1 WHEN 'swatch' THEN 2 WHEN 'primary' THEN 3 ELSE 4 END,
             sort_order
  `, [b.id, b.sku_id, b.product_id]);

  let winner = null;
  for (const c of cands) {
    if ((await checkUrl(liveUrl(c))) === 'ok') { winner = c; break; }
  }
  if (!winner) { unresolved++; unresolvedList.push({ media_id: b.id, product_id: b.product_id, sku_id: b.sku_id, url: liveUrl(b) }); continue; }

  promoted++;
  changes.push({ action: 'demote-broken', before: b });
  changes.push({ action: 'promote-winner', before: winner, winner_id: winner.id });
  if (APPLY) {
    await pool.query(`UPDATE media_assets SET asset_type='lifestyle_hidden', sort_order=sort_order+100 WHERE id=$1`, [b.id]);
    await pool.query(`UPDATE media_assets SET asset_type='primary', sort_order=0 WHERE id=$1`, [winner.id]);
  }
}

console.log(`\nhealed (now OK, no action): ${healed}`);
console.log(`still broken: ${stillBroken}`);
console.log(`  -> promoted a working sibling: ${promoted}`);
console.log(`  -> unresolved (no working image, left as-is): ${unresolved}`);
if (unresolvedList.length) {
  console.log('\nUnresolved (need re-source):');
  for (const u of unresolvedList.slice(0, 80)) console.log(`  ${u.url || u.reason} ${u.sku_id ? '(sku ' + u.sku_id + ')' : ''}`);
}

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/broken-image-repair-backup-${stamp}.json`, JSON.stringify({ changes, unresolvedList }, null, 2));
console.log(`\nApplied. Backup: ./data/broken-image-repair-backup-${stamp}.json`);
await pool.end();
