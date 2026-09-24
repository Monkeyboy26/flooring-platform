// Replace the PRIMARY photo of the 12 Versace Maximvs marble/megabarocco slabs
// with the maker's official studio swatch from versace-ceramics.com
// (collezioneColori). The prior Melange primary product-shot is demoted to
// 'alternate'; existing alternates + room-scene lifestyles are preserved.
//
// Code→official-file mapping was verified visually against each swatch.
// The 6 decor pieces (Manifesto*, Megabarocco Maxi White, Greca, Lux Avori-Oro)
// have no collezioneColori swatch, so they keep their Melange primary.
//
// Idempotent: if a SKU's primary is already the official URL, it's skipped.
//
//   node backend/scripts/set-versace-official-primaries.mjs [--dry-run]

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'https://www.versace-ceramics.com/public/collezioneColori';

// vendor_sku (Melange item #) → official swatch filename
const OFFICIAL = {
  '4256': '92-612-675003.jpg',                 // Statuario White
  '4257': '150-568-megabarocco-stat.jpg',      // Statuario White Megabarocco
  '4249': '93-87-675024.jpg',                  // Calacatta Bright
  '4250': '151-782-megabarocco-calacatta-b.jpg', // Calacatta Bright Megabarocco
  '4248': '94-816-675043.jpg',                 // Black & Gold
  '4355': '152-722-megabarocco-bg.jpg',        // Black & Gold Megabarocco
  '4255': '95-294-675072.jpg',                 // Rosa Venezia
  '4353': '153-104-megabarocco-rosa-venezia.jpg', // Rosa Venezia Megabarocco
  '4254': '96-78-675012.jpg',                  // Panda White
  '4251': '97-33-675031.jpg',                  // Calacatta Green
  '4252': '98-335-675051.jpg',                 // Galaxy Blue
  '4253': '99-313-675062.jpg',                 // Galaxy Brown
};

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');
  let changed = 0, skipped = 0;
  const toMirror = [];

  for (const [code, file] of Object.entries(OFFICIAL)) {
    const officialUrl = `${BASE}/${file}`;
    const internalSku = `MLG-VRS-${code}`;

    const skuRes = await pool.query(
      `SELECT s.id, p.name FROM skus s JOIN products p ON p.id = s.product_id
       WHERE s.internal_sku = $1`, [internalSku]);
    if (!skuRes.rows.length) { console.log(`  ! ${internalSku} not found`); continue; }
    const skuId = skuRes.rows[0].id;
    const name = skuRes.rows[0].name;

    const media = (await pool.query(
      `SELECT id, product_id, asset_type, url, original_url, sort_order
       FROM media_assets WHERE sku_id = $1 ORDER BY sort_order`, [skuId])).rows;
    const productId = media[0]?.product_id
      || (await pool.query('SELECT product_id FROM skus WHERE id=$1', [skuId])).rows[0].product_id;

    // Already official? (idempotent)
    const curPrimary = media.find(m => m.asset_type === 'primary');
    if (curPrimary && curPrimary.original_url === officialUrl) {
      console.log(`  = ${name}: already official`); skipped++; continue;
    }

    // New order: official (primary) → old primary as alternate → rest (unchanged type)
    const rest = media
      .filter(m => m.id !== curPrimary?.id)
      .map(m => ({ url: m.url, original_url: m.original_url, asset_type: m.asset_type }));
    const demotedOld = curPrimary
      ? [{ url: curPrimary.url, original_url: curPrimary.original_url, asset_type: 'alternate' }]
      : [];
    const newList = [
      { url: officialUrl, original_url: officialUrl, asset_type: 'primary' },
      ...demotedOld,
      ...rest,
    ];

    if (DRY_RUN) {
      console.log(`  → ${name}: primary ← ${file}  (was ${curPrimary ? curPrimary.original_url.split('/').pop() : 'none'}; ${newList.length} imgs)`);
      changed++; continue;
    }

    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
    for (let i = 0; i < newList.length; i++) {
      const m = newList[i];
      const r = await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, url, original_url`,
        [productId, skuId, m.asset_type, m.url, m.original_url, i]);
      if (i === 0) toMirror.push(r.rows[0]); // only the new official image needs mirroring
    }
    console.log(`  ✓ ${name}: official primary set (${newList.length} imgs)`);
    changed++;
  }

  if (!DRY_RUN && toMirror.length) {
    console.log(`\nMirroring ${toMirror.length} official images…`);
    let ok = 0, skip = 0;
    for (const row of toMirror) {
      try { (await mirrorMediaRow(pool, row)) ? ok++ : skip++; } catch { skip++; }
    }
    console.log(`  mirrored ${ok}, kept vendor url ${skip}`);
  }

  console.log(`\nDone: ${changed} changed, ${skipped} already-official`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
