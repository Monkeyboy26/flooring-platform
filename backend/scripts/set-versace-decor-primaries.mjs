// Set official Versace decor swatches as the PRIMARY photo for 4 of the 6
// Maximvs decor pieces, sourced from the maker's **Manifesto** collection page
// (versace-ceramics.com/en/surface/manifesto → collezioneColori, 800x800).
// These replace the earlier low-res (204px) catalogue-PDF crops, which looked
// soft. The Melange product shot is kept as 'alternate'; room scenes stay
// 'lifestyle'. The old /uploads/versace-decor/*.webp primaries are dropped.
//
// Not covered (kept on their Melange primary — no isolated official swatch):
// 4356 Greca Sabbiata Statuario White and 4357 Lux Avori-Oro.
//
// Website images are self-hosted via the mirror pipeline (uploads/mirror).
// Idempotent: a SKU whose primary already points at the official URL is skipped.
//
//   node backend/scripts/set-versace-decor-primaries.mjs [--dry-run]

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'https://www.versace-ceramics.com/public/collezioneColori';

// vendor_sku → official Manifesto-collection swatch filename
const DECOR = {
  '4349': '133-893-lettere-Brid.jpg',                 // Manifesto Lettering
  '4350': '132-798-Foulardrid.jpg',                   // Manifesto Foulard
  '4351': '128-100-MEGABAROCCO-COLOR-120X280rid.jpg', // Manifesto Megabarocco Color
  '4352': '124-100-Barocco-Biancorid.jpg',            // (Mega)barocco Maxi White
};

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');
  let changed = 0, skipped = 0;
  const toMirror = [];

  for (const [sku, file] of Object.entries(DECOR)) {
    const internalSku = `MLG-VRS-${sku}`;
    const officialUrl = `${BASE}/${file}`;

    const skuRes = await pool.query(
      `SELECT s.id, p.name, p.id AS product_id FROM skus s JOIN products p ON p.id = s.product_id
       WHERE s.internal_sku = $1`, [internalSku]);
    if (!skuRes.rows.length) { console.log(`  ! ${internalSku} not found`); continue; }
    const { id: skuId, name, product_id: productId } = skuRes.rows[0];

    const media = (await pool.query(
      `SELECT id, asset_type, url, original_url, sort_order
       FROM media_assets WHERE sku_id = $1 ORDER BY sort_order`, [skuId])).rows;

    // Already official?
    const curPrimary = media.find(m => m.asset_type === 'primary');
    if (curPrimary && curPrimary.original_url === officialUrl) {
      console.log(`  = ${name}: already official`); skipped++; continue;
    }

    // Keep everything EXCEPT the old low-res PDF swatch (drop it entirely).
    // Whatever primary exists now (the PDF crop) is dropped; Melange shots that
    // were demoted to 'alternate' are preserved as alternates.
    const keep = media
      .filter(m => !m.url.startsWith('/uploads/versace-decor/'))
      .map(m => ({
        url: m.url, original_url: m.original_url,
        // demote any lingering primary that isn't the PDF file
        asset_type: m.asset_type === 'primary' ? 'alternate' : m.asset_type,
      }));
    const newList = [
      { url: officialUrl, original_url: officialUrl, asset_type: 'primary' },
      ...keep,
    ];

    if (DRY_RUN) {
      const dropped = media.filter(m => m.url.startsWith('/uploads/versace-decor/')).length;
      console.log(`  → ${name}: primary ← ${file}  (drop ${dropped} PDF, keep ${keep.length}; total ${newList.length})`);
      changed++; continue;
    }

    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
    for (let i = 0; i < newList.length; i++) {
      const m = newList[i];
      const r = await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, url, original_url`,
        [productId, skuId, m.asset_type, m.url, m.original_url, i]);
      if (i === 0) toMirror.push(r.rows[0]);
    }
    console.log(`  ✓ ${name}: official web primary set (${newList.length} imgs)`);
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
