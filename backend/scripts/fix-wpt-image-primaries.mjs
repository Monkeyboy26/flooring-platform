/**
 * Western Pacific Tile — fix image primaries (swatch-first) + kill duplicate primaries.
 *
 * WPT's image scrape left products with:
 *   - multiple `primary` rows (372 primaries across 185 products; Materia Prima
 *     had 5) — the scraper never cleared old media, so rows accumulated across
 *     runs with shifting sort_orders that defeated the ON CONFLICT dedup;
 *   - a room SCENE as the primary instead of the tile SWATCH (numeric CloudFront
 *     filenames defeat keyword-based lifestyle detection);
 *   - spec/scene images ranked ahead of the swatch.
 *
 * This reprocesses EXISTING media in the DB (no Ecwid access needed — CloudFront
 * originals are public): for each WPT product it measures every distinct image
 * with sharp, ranks them swatch-first via lib/wptImages (aspect ratio vs the
 * tile's own ratio), then rewrites the product's media so there is exactly ONE
 * primary (the best swatch), other swatches as `alternate`, and scenes as
 * `lifestyle`. Any local mirror `url` (/uploads/mirror/*.webp) is preserved for
 * its source. Products whose current media already matches the plan are skipped
 * (idempotent). Dry-run by default; --apply writes a JSON backup first.
 *
 * Usage:
 *   node backend/scripts/fix-wpt-image-primaries.mjs           # dry run
 *   node backend/scripts/fix-wpt-image-primaries.mjs --apply   # commit
 *   node backend/scripts/fix-wpt-image-primaries.mjs --limit 5 # first 5 products (debug)
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { classifyImages, toMediaRows } from '../lib/wptImages.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : null; })();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_IMAGES = 6;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const dimCache = new Map();
async function measure(srcUrl) {
  if (dimCache.has(srcUrl)) return dimCache.get(srcUrl);
  let out = null;
  try {
    const resp = await fetch(srcUrl, { signal: AbortSignal.timeout(25000) });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const md = await sharp(buf).metadata();
      if (md.width && md.height) out = { width: md.width, height: md.height };
    }
  } catch { /* unreachable / not an image → leave null */ }
  dimCache.set(srcUrl, out);
  return out;
}

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`
  )).rows[0];
  if (!vendor) throw new Error('Western Pacific Tile vendor not found');

  // Pull every WPT product that has media, with its tile size and current media rows.
  const { rows: products } = await pool.query(
    `SELECT p.id, p.name,
            (SELECT sz.value FROM skus s
               JOIN sku_attributes sz ON sz.sku_id=s.id
               JOIN attributes a ON a.id=sz.attribute_id AND a.slug='size'
              WHERE s.product_id=p.id LIMIT 1) AS size
       FROM products p
      WHERE p.vendor_id=$1
        AND EXISTS (SELECT 1 FROM media_assets m WHERE m.product_id=p.id)
      ORDER BY p.name ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
    [vendor.id]
  );

  let changed = 0, skipped = 0, noSwatch = 0;
  const plan = [];

  for (const p of products) {
    const { rows: media } = await pool.query(
      `SELECT url, original_url, asset_type, sort_order, sku_id
         FROM media_assets WHERE product_id=$1`, [p.id]
    );
    // Dominant sku_id to re-attach to (WPT is one SKU per product). Prefer the
    // sku_id carried by the most rows; NULL (product-level) only if none set.
    const skuCounts = new Map();
    for (const m of media) if (m.sku_id) skuCounts.set(m.sku_id, (skuCounts.get(m.sku_id) || 0) + 1);
    const dominantSkuId = [...skuCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    // Dedup by source (original_url ?? url). Keep a local mirror url if present.
    const bySrc = new Map();
    for (const m of media) {
      const src = m.original_url || m.url;
      if (!src) continue;
      const cur = bySrc.get(src) || { url: m.url, original_url: src, sku_id: m.sku_id };
      // Prefer a mirror url (served locally) as the display url.
      if (String(m.url).startsWith('/uploads/mirror/')) cur.url = m.url;
      bySrc.set(src, cur);
    }
    const uniq = [...bySrc.values()];
    if (!uniq.length) { skipped++; continue; }

    // Measure each source image.
    for (const im of uniq) {
      const dim = await measure(im.original_url);
      if (dim) { im.width = dim.width; im.height = dim.height; }
    }

    const ranked = classifyImages(uniq, p.size);
    const newRows = toMediaRows(ranked, { maxImages: MAX_IMAGES });
    const primary = newRows[0];
    const hasSwatch = newRows.some(r => r.kind === 'swatch');
    if (!hasSwatch) noSwatch++;

    // Idempotency: compare (original_url, asset_type, sort_order) sets.
    const curKey = media
      .filter(m => (m.original_url || m.url))
      .map(m => `${m.original_url || m.url}|${m.asset_type}|${m.sort_order}`)
      .sort().join('\n');
    const newKey = newRows.map(r => `${r.original_url}|${r.asset_type}|${r.sort_order}`).sort().join('\n');
    const primaryCount = media.filter(m => m.asset_type === 'primary').length;
    if (curKey === newKey && primaryCount === 1) { skipped++; continue; }

    changed++;
    plan.push({ product_id: p.id, name: p.name, size: p.size, sku_id: dominantSkuId,
                oldPrimaryCount: primaryCount, newRows, hasSwatch });
  }

  // Report
  console.log(`\nWPT image primaries — ${products.length} products with media`);
  console.log(`  ${changed} to fix · ${skipped} already correct · ${noSwatch} have no swatch (scene-only)\n`);
  for (const c of plan.slice(0, LIMIT || 40)) {
    const pr = c.newRows[0];
    console.log(`  ${c.name} [${c.size || 'no size'}]  primaries ${c.oldPrimaryCount}→1${c.hasSwatch ? '' : '  ⚠ scene-only (no swatch)'}`);
    console.log(`      primary(${pr.kind}) ← ${(pr.original_url || pr.url).split('/').pop()}  ${c.newRows.length} img total`);
  }
  if (plan.length > (LIMIT || 40)) console.log(`  … and ${plan.length - (LIMIT || 40)} more`);

  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  const backupPath = path.join(__dirname, '..', 'data', `wpt-image-primaries-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ generated_at: new Date().toISOString(), vendor_id: vendor.id, plan }, null, 2));
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of plan) {
      await client.query('DELETE FROM media_assets WHERE product_id=$1', [c.product_id]);
      for (const r of c.newRows) {
        await client.query(
          `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.product_id, c.sku_id, r.asset_type, r.url, r.original_url, r.sort_order]
        );
      }
    }
    await client.query('COMMIT');
    console.log(`\n✓ Rewrote media for ${plan.length} product(s).`);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
