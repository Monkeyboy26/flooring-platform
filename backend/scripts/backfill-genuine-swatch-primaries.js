#!/usr/bin/env node
/**
 * Re-point Genuine Materials web-product PRIMARY photos to the cleanest flat slab/swatch
 * image (chosen by vision agents), demoting lifestyle/room shots to alternates.
 *
 * Reads: <GM_DATA_DIR>/swatches.json  { slug: { primary, candidates:[...], is_swatch } }
 *        <GM_DATA_DIR>/catalog.json   (to map slug -> product via an internal_sku)
 * Only touches product-level media (sku_id IS NULL) of the mapped products; sinks/Thinmaxx
 * (which have no slug) are untouched. Idempotent: rebuilds each product's product-level media.
 *
 * Usage: docker compose exec -e GM_DATA_DIR=/app/data/genuine-materials api node scripts/backfill-genuine-swatch-primaries.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });
const DATA_DIR = process.env.GM_DATA_DIR || '/app/data/genuine-materials';
const swatches = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'swatches.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));

// slug -> a representative internal_sku (first sku of that product)
const slugToSku = {};
for (const p of catalog) {
  if (p.slug && p.skus && p.skus.length) slugToSku[p.slug] = p.skus[0].internal_sku;
}

async function productIdForSlug(slug) {
  const isku = slugToSku[slug];
  if (!isku) return null;
  const r = await pool.query('SELECT product_id FROM skus WHERE internal_sku=$1', [isku]);
  return r.rows.length ? r.rows[0].product_id : null;
}

async function main() {
  console.log('=== Genuine Materials swatch-primary backfill ===');
  let updated = 0, skipped = 0, swatchCount = 0, fallbackCount = 0;
  const missing = [];
  for (const [slug, info] of Object.entries(swatches)) {
    if (!info || !info.primary) { skipped++; continue; }
    const pid = await productIdForSlug(slug);
    if (!pid) { missing.push(slug); skipped++; continue; }

    // Ordered, de-duped media list: chosen primary first, then other candidates.
    const urls = [];
    const seen = new Set();
    for (const u of [info.primary, ...(info.candidates || [])]) {
      if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
    }

    // Rebuild product-level media for this product.
    await pool.query('DELETE FROM media_assets WHERE product_id=$1 AND sku_id IS NULL', [pid]);
    for (let i = 0; i < urls.length && i < 6; i++) {
      await pool.query(`
        INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
        VALUES ($1,$2,$3,$3,$4)
      `, [pid, i === 0 ? 'primary' : 'alternate', urls[i], i]);
    }
    info.is_swatch ? swatchCount++ : fallbackCount++;
    updated++;
  }
  console.log(`Updated ${updated} products (${swatchCount} true swatch, ${fallbackCount} fallback). Skipped ${skipped}.`);
  if (missing.length) console.log('No product mapping for:', missing.join(', '));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
