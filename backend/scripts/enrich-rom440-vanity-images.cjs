/**
 * enrich-rom440-vanity-images.cjs
 *
 * Pulls vanity-cabinet images from Hardware Resources' public site for ROM440
 * SKUs that the main image scraper couldn't match. Those cabinets are grouped
 * products on HR (e.g. /vanities/vanities/vn2gar-30-group.html), so a plain
 * vendor_sku catalog search returns nothing — this resolves the group page
 * from the SKU stem instead.
 *
 * HR only publishes group-level photos (VN2xxx-<size>-Group_N.jpg) for these
 * vanities, not per-finish photos, so every finish variant of a size shares the
 * same group images (mirrors how HR's own product page presents them).
 *
 * Usage:
 *   docker compose exec -T api node scripts/enrich-rom440-vanity-images.cjs [flags]
 *   --stem=VN2GAR-30    Only SKUs whose vendor_sku starts with this (default: VN2GAR-30)
 *   --dry-run           Fetch + match, download/write nothing
 *   --activate          Set status='active' on products that got a primary image
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ACTIVATE = args.includes('--activate');
const STEM = (args.find(a => a.startsWith('--stem=')) || '--stem=VN2GAR-30').split('=')[1].toUpperCase();

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const ROM440_UPLOAD_DIR = path.join(UPLOADS_BASE, 'rom440');
const HR_BASE = 'https://www.hardwareresources.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// SKU stem -> HR group page URL. VN2GAR-30-BS-NT -> vn2gar-30-group.html
function groupUrlFor(vendorSku) {
  const m = vendorSku.toUpperCase().match(/^(VN2[A-Z]+)-(\d+)/);
  if (!m) return null;
  return `${HR_BASE}/vanities/vanities/${m[1].toLowerCase()}-${m[2]}-group.html`;
}

// full-res catalog URL for an HR media filename: /media/catalog/product/V/N/<file>
function catalogUrl(filename) {
  return `${HR_BASE}/media/catalog/product/${filename[0]}/${filename[1]}/${filename}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FETCH_DELAY_MS = 600; // polite pause after each real HR page fetch

const pageCache = new Map(); // url -> [filenames] (group hero shots, ordered)
async function groupImages(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  let files = [];
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR_BASE + '/' } });
    if (resp.ok) {
      const html = await resp.text();
      const stem = url.split('/').pop().replace('-group.html', '').toUpperCase(); // VN2GAR-30
      const re = new RegExp(`${stem}-Group_(\\d+)_[a-f0-9]+\\.jpg`, 'gi');
      const seen = new Map();
      for (const m of html.matchAll(re)) {
        const idx = parseInt(m[1], 10);
        if (!seen.has(idx)) seen.set(idx, m[0]);
      }
      files = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    }
  } catch (e) {
    console.log(`  [warn] fetch failed ${url}: ${e.message}`);
  }
  pageCache.set(url, files);
  await sleep(FETCH_DELAY_MS); // only after a real (non-cached) fetch
  return files;
}

async function download(url, destPath) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR_BASE + '/' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}

async function insertMediaAsset(productId, skuId, assetType, publicUrl, originalUrl, sortOrder) {
  await pool.query(
    `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING`,
    [productId, skuId, assetType, publicUrl, originalUrl, sortOrder]
  );
}

async function main() {
  console.log(`\n  ROM440 Vanity Image Enrichment — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  stem=${STEM}  activate=${ACTIVATE}\n`);

  const { rows: skus } = await pool.query(
    `SELECT s.id AS sku_id, s.product_id, s.vendor_sku, p.status
       FROM skus s
       JOIN products p ON p.id = s.product_id
       JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'HR' AND UPPER(s.vendor_sku) LIKE $1
       AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id)
      ORDER BY s.vendor_sku`,
    [STEM + '%']
  );
  console.log(`  target SKUs: ${skus.length}`);

  let attached = 0, activated = 0, noImg = 0;
  const activatedProducts = new Set();

  for (const sku of skus) {
    const url = groupUrlFor(sku.vendor_sku);
    const files = url ? await groupImages(url) : [];
    if (!files.length) { noImg++; console.log(`  [skip] ${sku.vendor_sku} — no group images (${url || 'no-url'})`); continue; }

    let sort = 0;
    for (const filename of files) {
      const origUrl = catalogUrl(filename);
      const assetType = sort === 0 ? 'primary' : 'alternate';
      const localName = sort === 0 ? 'primary.jpg' : `alternate-${sort - 1}.jpg`;
      const localPath = path.join(ROM440_UPLOAD_DIR, sku.vendor_sku, localName);
      const publicUrl = `/uploads/rom440/${sku.vendor_sku}/${localName}`;
      if (!DRY_RUN) {
        const bytes = await download(origUrl, localPath);
        await insertMediaAsset(sku.product_id, sku.sku_id, assetType, publicUrl, origUrl, sort);
        if (sort === 0) console.log(`  [ok]   ${sku.vendor_sku} <- ${filename} (${bytes}B) +${files.length - 1} alt`);
      } else if (sort === 0) {
        console.log(`  [dry]  ${sku.vendor_sku} would attach ${files.length} imgs (primary=${filename})`);
      }
      sort++;
    }
    attached++;
    if (ACTIVATE && !DRY_RUN) activatedProducts.add(sku.product_id);
  }

  if (ACTIVATE && !DRY_RUN && activatedProducts.size) {
    const res = await pool.query(
      `UPDATE products SET status='active', updated_at=CURRENT_TIMESTAMP
        WHERE id = ANY($1::uuid[]) AND status <> 'active'`,
      [[...activatedProducts]]
    );
    activated = res.rowCount;
  }

  console.log(`\n  Summary: ${attached} SKUs imaged, ${noImg} without images, ${activated} products activated\n`);
  await pool.end();
}

main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
