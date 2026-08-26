/**
 * scrape-vanity-finish-images.cjs
 *
 * Fully-scripted, finish-ACCURATE vanity cabinet imagery from Hardware
 * Resources. HR vanities are grouped/configurable products whose per-finish
 * photos load via a swatch media AJAX call (not inline HTML). This script:
 *
 *   1. Derives each collection's group page from our cabinet SKUs
 *      (VN2<COLL>-<SIZE>-<FINISH>-NT -> vn2<coll>-<size>-group.html).
 *   2. Fetches the group page and regexes out childProductId -> our vendor_sku
 *      from the embedded Magento swatch config.
 *   3. Calls GET /swatches/ajax/media/?product_id=<childPid>&isAjax=true to get
 *      that finish's exact photo (filename is finish-coded, e.g.
 *      VN2CHA-36-BL-NT_0_<hash>.jpg — matches our vendor_sku).
 *   4. Downloads ONE primary image per SKU (no gallery -> no color mixing),
 *      inserts media_assets, and (with --activate) publishes the product.
 *
 * Idempotent: skips SKUs that already have media. Rate-limited.
 *
 * Usage:
 *   docker compose exec -T api node scripts/scrape-vanity-finish-images.cjs [flags]
 *   --stem=VN2CHA   Only collections/SKUs whose vendor_sku starts with this (default VN2 = all)
 *   --dry-run       Resolve mappings, fetch nothing to disk/DB
 *   --activate      Publish products that received a primary image
 *   --limit=N       Cap number of group pages processed
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ACTIVATE = args.includes('--activate');
const STEM = (args.find(a => a.startsWith('--stem=')) || '--stem=VN2').split('=')[1].toUpperCase();
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '--limit=99999').split('=')[1], 10);

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const ROM440_UPLOAD_DIR = path.join(UPLOADS_BASE, 'rom440');
const HR = 'https://www.hardwareresources.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FETCH_DELAY = 500;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR + '/', 'X-Requested-With': 'XMLHttpRequest' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// stem like VN2CHA-36 -> group page URL
function groupUrl(stem) {
  const m = stem.toUpperCase().match(/^(VN2[A-Z]+)-(\d+)/);
  return m ? `${HR}/vanities/vanities/${m[1].toLowerCase()}-${m[2]}-group.html` : null;
}

// childProductId -> our vendor_sku, from the embedded swatch/json config
function extractChildren(html) {
  const map = new Map(); // vendorSku(UPPER) -> childPid
  const re = /"(\d+)":"(VN2[A-Z]+-\d+-[A-Z]{2,3}-NT)"/g;
  let m;
  while ((m = re.exec(html))) map.set(m[2].toUpperCase(), m[1]);
  return map;
}

// media endpoint -> full-res catalog image URL for a child product
async function finishImageUrl(childPid) {
  const j = JSON.parse(await fetchText(`${HR}/swatches/ajax/media/?product_id=${childPid}&isAjax=true&_=${childPid}`));
  const large = j.large || j.medium || j.small || '';
  const file = large.split('/').pop().split('?')[0];
  if (!/^VN2[A-Z]+-\d+-[A-Z]{2,3}-NT_\d+_[a-f0-9]+\.jpg$/i.test(file)) return null;
  return `${HR}/media/catalog/product/${file[0]}/${file[1]}/${file}`;
}

async function download(url, destPath) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR + '/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}

async function main() {
  console.log(`\n  Vanity finish-image scraper — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}  stem=${STEM} activate=${ACTIVATE}\n`);

  // distinct group stems among our cabinet SKUs that still need imagery
  const { rows: stems } = await pool.query(
    `SELECT DISTINCT substring(upper(s.vendor_sku) from '^(VN2[A-Z]+-[0-9]+)') AS stem
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='HR' AND upper(s.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+-[A-Z]{2,3}-NT'
        AND upper(s.vendor_sku) LIKE $1
        AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id=s.id)
      ORDER BY stem`,
    [STEM + '%']
  );
  console.log(`  group pages to process: ${stems.length}${stems.length > LIMIT ? ` (capped at ${LIMIT})` : ''}`);

  let imaged = 0, noMap = 0, noImg = 0, pagesDone = 0;
  const productIds = new Set();

  for (const { stem } of stems.slice(0, LIMIT)) {
    const url = groupUrl(stem);
    let children;
    try { children = extractChildren(await fetchText(url)); }
    catch (e) { console.log(`  [page-fail] ${stem}: ${e.message}`); await sleep(FETCH_DELAY); continue; }
    await sleep(FETCH_DELAY);
    pagesDone++;

    // only children of THIS stem that exist in our DB without media
    const { rows: need } = await pool.query(
      `SELECT s.id AS sku_id, s.product_id, upper(s.vendor_sku) AS sku
         FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
        WHERE v.code='HR' AND upper(s.vendor_sku) LIKE $1
          AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id=s.id)`,
      [stem + '-%']
    );

    for (const row of need) {
      const childPid = children.get(row.sku);
      if (!childPid) { console.log(`  [no-map] ${row.sku}`); noMap++; continue; }
      let imgUrl;
      try { imgUrl = await finishImageUrl(childPid); } catch (e) { imgUrl = null; }
      await sleep(FETCH_DELAY);
      if (!imgUrl) { console.log(`  [no-img] ${row.sku} (pid ${childPid})`); noImg++; continue; }
      if (DRY_RUN) { console.log(`  [dry] ${row.sku} <- ${imgUrl.split('/').pop()}`); imaged++; productIds.add(row.product_id); continue; }
      const localPath = path.join(ROM440_UPLOAD_DIR, row.sku, 'primary.jpg');
      const bytes = await download(imgUrl, localPath);
      await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,'primary',$3,$4,0)
         ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING`,
        [row.product_id, row.sku_id, `/uploads/rom440/${row.sku}/primary.jpg`, imgUrl]
      );
      console.log(`  [ok]  ${row.sku} <- ${imgUrl.split('/').pop()} (${bytes}B)`);
      imaged++; productIds.add(row.product_id);
    }
  }

  let activated = 0;
  if (ACTIVATE && !DRY_RUN && productIds.size) {
    const res = await pool.query(
      `UPDATE products SET status='active', updated_at=CURRENT_TIMESTAMP
        WHERE id = ANY($1::uuid[]) AND status <> 'active'`, [[...productIds]]);
    activated = res.rowCount;
  }
  console.log(`\n  Summary: ${pagesDone} pages, ${imaged} imaged, ${noMap} unmapped, ${noImg} no-image, ${activated} activated\n`);
  await pool.end();
}
main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
