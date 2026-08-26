#!/usr/bin/env node
/**
 * Backfill photos for the Genuine Materials sinks + Thinmaxx products, whose images
 * live only inside "Q3 PL 2026.pdf" (no web product page). Images were extracted from
 * the PDF into backend/data/genuine-materials/pdf-images/ and are copied here into
 * /uploads/products/<productId>/ and registered as media_assets (product-level).
 *
 * Idempotent. Usage:
 *   docker compose exec -e GM_DATA_DIR=/app/data/genuine-materials api node scripts/backfill-genuine-sink-images.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });
const DATA_DIR = process.env.GM_DATA_DIR || '/app/data/genuine-materials';
const SRC = path.join(DATA_DIR, 'pdf-images');
const UPLOADS = path.join(process.cwd(), 'uploads', 'products');

// internal_sku -> [primary, gallery...] source filenames in SRC
const MAP = {
  'GM-GQS1812':          ['sink_GQS1812.jpeg'],
  'GM-GQSSK25WH':        ['sink_GQSSK25WH.jpeg'],
  'GM-GQS3018S':         ['sink_GQS3018S.jpeg'],
  'GM-GQS3118S-18':      ['sink_GQS3018S.jpeg'],          // bar sink — reuse single-bowl photo
  'GM-GQS3219S-18-10D':  ['sink_GQS3219S.jpeg'],
  'GM-GQS503-18':        ['sink_GQS503-18.jpeg'],
  'GM-GQS2318-12D':      ['sink_GQS2318-12D.png'],
  'GM-GQS3318D':         ['sink_GQS3318D.jpeg', 'sink_GQS3318D_acc.png'],
  'GM-TMXHS-10':         ['thinmaxx_foam.jpeg', 'thinmaxx_slab.jpeg'],
  'GM-TMXPT-10':         ['thinmaxx_slab.jpeg', 'thinmaxx_foam.jpeg'],
};

async function productIdFor(internalSku) {
  const r = await pool.query('SELECT product_id FROM skus WHERE internal_sku=$1', [internalSku]);
  return r.rows.length ? r.rows[0].product_id : null;
}
async function upsertMedia(productId, url, assetType, sortOrder) {
  await pool.query(`
    INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
    VALUES ($1,$2,$3,$3,$4)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url
  `, [productId, assetType, url, sortOrder]);
}

async function main() {
  console.log('=== Genuine Materials sink/Thinmaxx image backfill ===');
  let done = 0;
  for (const [sku, files] of Object.entries(MAP)) {
    const pid = await productIdFor(sku);
    if (!pid) { console.warn('! no product for', sku); continue; }
    const destDir = path.join(UPLOADS, pid);
    fs.mkdirSync(destDir, { recursive: true });
    files.forEach((f, i) => {
      const ext = path.extname(f);
      const destName = `gm-${sku.toLowerCase()}-${i}${ext}`;
      fs.copyFileSync(path.join(SRC, f), path.join(destDir, destName));
    });
    // register media (primary = 0, rest alternate)
    for (let i = 0; i < files.length; i++) {
      const ext = path.extname(files[i]);
      const url = `/uploads/products/${pid}/gm-${sku.toLowerCase()}-${i}${ext}`;
      await upsertMedia(pid, url, i === 0 ? 'primary' : 'alternate', i);
    }
    console.log(`  ${sku} -> ${files.length} image(s)`);
    done++;
  }
  console.log(`\nBackfilled ${done}/${Object.keys(MAP).length} products.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
