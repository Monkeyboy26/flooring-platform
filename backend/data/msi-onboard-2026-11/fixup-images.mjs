/**
 * Fixup after onboard.mjs: the live run completed all DB work but every image
 * download + the backup write failed with EACCES (docker exec user had no write
 * access to the bind mounts). Run as root: docker exec -u 0 …
 *  1. Re-attach images for the 90 created products (groups recomputed identically).
 *  2. Write the reconstructed prior-state backup (from msi-reactivate.json __db).
 */
import pg from 'pg';
import fs from 'fs';
import { upsertMediaAsset, downloadImage, resolveImageExtension } from '/app/scrapers/base.js';

const DIR = '/app/data/msi-onboard-2026-11';
const create = JSON.parse(fs.readFileSync(`${DIR}/msi-create.json`, 'utf8'));
const reactivate = JSON.parse(fs.readFileSync(`${DIR}/msi-reactivate.json`, 'utf8'));
const images = JSON.parse(fs.readFileSync(`${DIR}/create-images.json`, 'utf8'));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres',
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
});

const linkSegs = r => {
  const m = String(r['Web Link'] || '').match(/msisurfaces\.com\/([^/?]+)(?:\/([^/?]+))?/);
  return m ? [m[1], m[2] || null] : [null, null];
};

async function main() {
  // Rebuild groups exactly like onboard.mjs
  const groups = new Map();
  for (const r of create) {
    const link = String(r['Web Link'] || '').trim();
    let key;
    if (r.__item.startsWith('THD') && link.startsWith('http')) key = `thd:${linkSegs(r)[0]}`;
    else key = link.startsWith('http') ? link : `item:${r.__item}`;
    if (!groups.has(key)) groups.set(key, { rows: [], link: link.startsWith('http') ? link : null });
    groups.get(key).rows.push(r);
  }

  let done = 0, fail = 0, skippedHasImage = 0, noProduct = 0;
  for (const [, g] of groups) {
    const img = g.link ? images[g.link] : null;
    if (!img || !img.primary) continue;
    const pr = await pool.query(
      'SELECT product_id FROM skus WHERE internal_sku = $1', [`MSI-${g.rows[0].__item}`]);
    if (!pr.rows.length) { noProduct++; continue; }
    const productId = pr.rows[0].product_id;
    const existing = await pool.query(
      "SELECT 1 FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1", [productId]);
    if (existing.rows.length) { skippedHasImage++; continue; }

    const list = [{ url: img.primary, type: 'primary' }, ...(img.alts || []).map(u => ({ url: u, type: 'alternate' }))];
    let altIdx = 0;
    for (const im of list) {
      try {
        const ext = resolveImageExtension(im.url);
        const filename = im.type === 'primary' ? `primary${ext}` : `alt-${++altIdx}${ext}`;
        const destPath = `/app/uploads/products/${productId}/${filename}`;
        let ok = await downloadImage(im.url, destPath);
        // CDN is case-sensitive; some pages reference Capitalized names that only exist lowercase
        if (!ok) {
          const lower = im.url.replace(/[^/]+$/, s => s.toLowerCase());
          if (lower !== im.url) ok = await downloadImage(lower, destPath);
        }
        if (ok) {
          await upsertMediaAsset(pool, {
            product_id: productId, sku_id: null, asset_type: im.type,
            url: `/uploads/products/${productId}/${filename}`, original_url: im.url,
            sort_order: im.type === 'primary' ? 0 : altIdx,
          });
          done++;
        } else { fail++; console.log(`  dl-fail ${im.url}`); }
      } catch (e) { fail++; console.log(`  err ${im.url}: ${e.message}`); }
    }
  }
  console.log(`images attached=${done} failed=${fail} already-had=${skippedHasImage} no-product=${noProduct}`);

  // Reconstructed backup: prior state of every reactivated SKU/product
  const backup = {
    note: 'Reconstructed post-hoc (original write hit EACCES). Prior states from msi-reactivate.json __db snapshot taken 2026-11-12 before the run.',
    skus: reactivate.filter(r => !/\s/.test(r.__item) && !r.__item.startsWith('REFER'))
      .map(r => ({ skuId: r.__db.skuId, vendorSku: r.__item, prevSkuStatus: r.__db.status, prevProductActive: r.__db.pActive, productId: r.__db.productId })),
    createdSkus: create.map(r => `MSI-${r.__item}`),
  };
  fs.writeFileSync(`${DIR}/onboard-backup-reconstructed.json`, JSON.stringify(backup, null, 1));
  console.log(`backup written: ${DIR}/onboard-backup-reconstructed.json (${backup.skus.length} reactivated skus, ${backup.createdSkus.length} created skus)`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
