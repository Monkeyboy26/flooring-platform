/**
 * scrape-vanity-accessory-images.cjs
 *
 * Finish/material-accurate images for HR vanity ACCESSORIES (tops TKIT/TOPR/
 * TOPO, mirrors MIR2 and VMIR, sidesplashes SSPLASH, legs VNLEG, sinks) - the
 * non-cabinet SKUs left unpublished after the cabinet run.
 *
 * These accessories are grouped members ON the vanity group pages, so their
 * Magento childProductId -> our vendor_sku pairs are in the same page config.
 * We harvest those pairs across all vanity pages, then reuse the swatch media
 * endpoint (GET /swatches/ajax/media/?product_id=<childPid>&isAjax=true) to get
 * each accessory's own photo — one primary image per SKU.
 *
 * Usage:
 *   docker compose exec -T api node scripts/scrape-vanity-accessory-images.cjs [--dry-run] [--activate] [--limit=N]
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ACTIVATE = args.includes('--activate');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '--limit=99999').split('=')[1], 10);

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const ROM440_UPLOAD_DIR = path.join(UPLOADS_BASE, 'rom440');
const HR = 'https://www.hardwareresources.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 400;

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
async function download(url, destPath) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR + '/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}
async function finishImageUrl(childPid) {
  const j = JSON.parse(await fetchText(`${HR}/swatches/ajax/media/?product_id=${childPid}&isAjax=true&_=${childPid}`));
  const large = j.large || j.medium || j.small || '';
  const file = large.split('/').pop().split('?')[0];
  if (!/\.jpg$/i.test(file)) return null;
  return `${HR}/media/catalog/product/${file[0]}/${file[1]}/${file}`;
}
function groupUrl(stem) {
  const m = stem.toUpperCase().match(/^(VN2[A-Z]+)-(\d+)/);
  return m ? `${HR}/vanities/vanities/${m[1].toLowerCase()}-${m[2]}-group.html` : null;
}

async function main() {
  console.log(`\n  Vanity ACCESSORY image scraper — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} activate=${ACTIVATE}\n`);

  // our accessory SKUs still needing imagery
  const { rows: needRows } = await pool.query(
    `SELECT s.id AS sku_id, s.product_id, upper(s.vendor_sku) AS sku
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
       JOIN categories c ON c.id=p.category_id
      WHERE v.code='HR' AND c.name='Vanity' AND p.status='inactive'
        AND upper(s.vendor_sku) !~ '^VN2[A-Z]+-[0-9]+-[A-Z]{2,3}-NT'
        AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id=s.id)`
  );
  const need = new Map(needRows.map(r => [r.sku, r]));
  console.log(`  accessory SKUs needing images: ${need.size}`);

  // all vanity group pages to crawl (distinct collection+size)
  const { rows: stems } = await pool.query(
    `SELECT DISTINCT substring(upper(s.vendor_sku) from '^(VN2[A-Z]+-[0-9]+)') AS stem
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='HR' AND upper(s.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+' ORDER BY stem`
  );

  // harvest accessorySku -> childPid across pages, keeping only SKUs we need
  const pidFor = new Map();
  let pages = 0;
  for (const { stem } of stems.slice(0, LIMIT)) {
    const url = groupUrl(stem);
    let html;
    try { html = await fetchText(url); } catch (e) { await sleep(DELAY); continue; }
    pages++;
    const re = /"(\d{4,})":"([A-Z][A-Z0-9-]{4,})"/g;
    let m;
    while ((m = re.exec(html))) {
      const sku = m[2].toUpperCase();
      if (need.has(sku) && !pidFor.has(sku)) pidFor.set(sku, m[1]);
    }
    await sleep(DELAY);
  }
  console.log(`  crawled ${pages} pages; matched ${pidFor.size}/${need.size} accessory SKUs to a childPid\n`);

  let imaged = 0, noImg = 0;
  const productIds = new Set();
  for (const [sku, childPid] of pidFor) {
    const row = need.get(sku);
    let imgUrl;
    try { imgUrl = await finishImageUrl(childPid); } catch (e) { imgUrl = null; }
    await sleep(DELAY);
    if (!imgUrl) { console.log(`  [no-img] ${sku} (pid ${childPid})`); noImg++; continue; }
    if (DRY_RUN) { console.log(`  [dry] ${sku} <- ${imgUrl.split('/').pop()}`); imaged++; productIds.add(row.product_id); continue; }
    const bytes = await download(imgUrl, path.join(ROM440_UPLOAD_DIR, sku, 'primary.jpg'));
    await pool.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
       VALUES ($1,$2,'primary',$3,$4,0)
       ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING`,
      [row.product_id, row.sku_id, `/uploads/rom440/${sku}/primary.jpg`, imgUrl]
    );
    console.log(`  [ok]  ${sku} <- ${imgUrl.split('/').pop()} (${bytes}B)`);
    imaged++; productIds.add(row.product_id);
  }

  let activated = 0;
  if (ACTIVATE && !DRY_RUN && productIds.size) {
    const res = await pool.query(
      `UPDATE products SET status='active', updated_at=CURRENT_TIMESTAMP
        WHERE id = ANY($1::uuid[]) AND status <> 'active'`, [[...productIds]]);
    activated = res.rowCount;
  }
  const unmatched = need.size - pidFor.size;
  console.log(`\n  Summary: ${imaged} imaged, ${noImg} no-image, ${unmatched} not found on any page, ${activated} products activated\n`);
  await pool.end();
}
main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
