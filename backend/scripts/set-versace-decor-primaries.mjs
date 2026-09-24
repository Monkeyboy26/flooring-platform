// Set official Versace decor swatches as the PRIMARY photo for 4 of the 6
// Maximvs decor pieces. Swatches were extracted from the maker's official
// catalogue (versace-ceramics.com collezioneFile Maximvs PDF, "Matching
// Proposal" pages) and self-hosted at uploads/versace-decor/<code>.webp.
// The Melange product shot is demoted to 'alternate'.
//
// Not covered (kept on their Melange primary — no usable isolated official
// swatch): 4356 Greca Sabbiata Statuario White (catalogue swatch is a
// 166x28 border strip) and 4357 Lux Avori-Oro (only appears in a room scene).
//
// The webp files must already be present in uploads/versace-decor/ (committed).
// Idempotent: skips a SKU whose primary is already the official decor file.
//
//   node backend/scripts/set-versace-decor-primaries.mjs [--dry-run]

import { pool } from '../db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PDF = 'https://www.versace-ceramics.com/public/collezioneFile/13-986-catalogo-maximvsversace-ceramics.pdf';

// vendor_sku → { url, official_code } (official Versace article code for provenance)
const DECOR = {
  '4349': { url: '/uploads/versace-decor/4349.webp', code: '0067640' }, // Manifesto Lettering A
  '4350': { url: '/uploads/versace-decor/4350.webp', code: '0067672' }, // Manifesto Foulard
  '4351': { url: '/uploads/versace-decor/4351.webp', code: '0067642' }, // Manifesto Megabarocco Color
  '4352': { url: '/uploads/versace-decor/4352.webp', code: '0067671' }, // Barocco Maxi White
};

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');
  let changed = 0, skipped = 0;

  for (const [sku, { url, code }] of Object.entries(DECOR)) {
    const internalSku = `MLG-VRS-${sku}`;
    const provenance = `${PDF}#${code}`;

    const skuRes = await pool.query(
      `SELECT s.id, p.name, p.id AS product_id FROM skus s JOIN products p ON p.id = s.product_id
       WHERE s.internal_sku = $1`, [internalSku]);
    if (!skuRes.rows.length) { console.log(`  ! ${internalSku} not found`); continue; }
    const { id: skuId, name, product_id: productId } = skuRes.rows[0];

    const media = (await pool.query(
      `SELECT id, asset_type, url, original_url, sort_order
       FROM media_assets WHERE sku_id = $1 ORDER BY sort_order`, [skuId])).rows;
    const curPrimary = media.find(m => m.asset_type === 'primary');

    if (curPrimary && curPrimary.url === url) {
      console.log(`  = ${name}: already official`); skipped++; continue;
    }

    const rest = media
      .filter(m => m.id !== curPrimary?.id)
      .map(m => ({ url: m.url, original_url: m.original_url, asset_type: m.asset_type }));
    const demotedOld = curPrimary
      ? [{ url: curPrimary.url, original_url: curPrimary.original_url, asset_type: 'alternate' }]
      : [];
    const newList = [
      { url, original_url: provenance, asset_type: 'primary' },
      ...demotedOld,
      ...rest,
    ];

    if (DRY_RUN) {
      console.log(`  → ${name}: primary ← ${url} (was ${curPrimary ? curPrimary.original_url?.split('/').pop() : 'none'}; ${newList.length} imgs)`);
      changed++; continue;
    }

    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
    for (let i = 0; i < newList.length; i++) {
      const m = newList[i];
      await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [productId, skuId, m.asset_type, m.url, m.original_url, i]);
    }
    console.log(`  ✓ ${name}: official decor primary set (${newList.length} imgs)`);
    changed++;
  }

  console.log(`\nDone: ${changed} changed, ${skipped} already-official`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
