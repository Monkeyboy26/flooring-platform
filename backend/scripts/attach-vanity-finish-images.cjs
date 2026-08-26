/**
 * attach-vanity-finish-images.cjs
 *
 * Attaches FINISH-ACCURATE vanity cabinet photos captured from Hardware
 * Resources' grouped-product swatches. Input is a JSON list of {sku, url}
 * where sku is our exact vendor_sku (e.g. VN2CHA-36-BL-NT) and url is the
 * full-res HR product photo for that specific finish.
 *
 * Unlike the earlier group-gallery approach, this attaches exactly ONE
 * primary image per SKU (the correct finish), so nothing mixes.
 *
 * Usage:
 *   docker compose exec -T api node scripts/attach-vanity-finish-images.cjs [--file=...] [--dry-run] [--activate]
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ACTIVATE = args.includes('--activate');
const FILE = (args.find(a => a.startsWith('--file=')) || '--file=/app/data/ROM440/vanity-finish-images.json').split('=')[1];

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const ROM440_UPLOAD_DIR = path.join(UPLOADS_BASE, 'rom440');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function download(url, destPath) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.hardwareresources.com/' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
  return buf.length;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`\n  Attach finish-accurate vanity images — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} (${rows.length} entries)\n`);

  let attached = 0, missing = 0;
  const productIds = new Set();

  for (const { sku, url } of rows) {
    const { rows: hit } = await pool.query(
      `SELECT s.id AS sku_id, s.product_id FROM skus s
         JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = 'HR' AND upper(s.vendor_sku) = upper($1)`,
      [sku]
    );
    if (!hit.length) { console.log(`  [miss] ${sku} — not in DB`); missing++; continue; }
    const { sku_id, product_id } = hit[0];
    const localPath = path.join(ROM440_UPLOAD_DIR, sku, 'primary.jpg');
    const publicUrl = `/uploads/rom440/${sku}/primary.jpg`;
    if (DRY_RUN) { console.log(`  [dry]  ${sku} <- ${url.split('/').pop()}`); attached++; productIds.add(product_id); continue; }
    const bytes = await download(url, localPath);
    await pool.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
       VALUES ($1, $2, 'primary', $3, $4, 0)
       ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING`,
      [product_id, sku_id, publicUrl, url]
    );
    console.log(`  [ok]   ${sku} <- ${url.split('/').pop()} (${bytes}B)`);
    attached++; productIds.add(product_id);
  }

  let activated = 0;
  if (ACTIVATE && !DRY_RUN && productIds.size) {
    const res = await pool.query(
      `UPDATE products SET status='active', updated_at=CURRENT_TIMESTAMP
        WHERE id = ANY($1::uuid[]) AND status <> 'active'`,
      [[...productIds]]
    );
    activated = res.rowCount;
  }
  console.log(`\n  Summary: ${attached} imaged, ${missing} missing, ${activated} products activated\n`);
  await pool.end();
}
main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
