/**
 * Akua swatch images: trim the off-center white border and re-center on a square,
 * and add the tear-sheet (label) as an alternate gallery image.
 *
 * The akuamosaics.com swatches (images/swatches/<slug>.jpg, 195x178) have the tile
 * shifted left with a big right white margin, so they render off-center. This
 * downloads each, sharp.trim()s the border and centers it on a 600x600 white
 * square saved to uploads/akua/<slug>.jpg (served at /uploads/akua/…), then:
 *   primary   → /uploads/akua/<slug>.jpg (centered swatch)
 *   alternate → the tear sheet (images/labels/<slug>.jpg)  [user wants it kept]
 *   lifestyle → the room render (unchanged)
 *
 * MUST run inside the api container (writes to the uploads volume, needs sharp).
 * Idempotent; re-running re-processes and re-points. No dry-run (safe, reversible
 * by re-import).
 *   docker compose … exec -T api node scripts/fix-akua-swatch-images.mjs
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const UPLOADS = process.env.UPLOADS_PATH || path.resolve('uploads');
const OUTDIR = path.join(UPLOADS, 'akua');

const slugOf = (u) => (u || '').split('/').pop().replace(/\.[a-z]+$/i, '');
const swatchUrl = (slug) => `https://akuamosaics.com/images/swatches/${slug}.jpg`;
const labelUrl = (slug) => `https://akuamosaics.com/images/labels/${slug}.jpg`;

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const brand = (await pool.query(`SELECT id FROM brands WHERE code='AKUA' LIMIT 1`)).rows[0];
  if (!brand) throw new Error('Akua brand not found');

  // Each Akua product's primary media (currently the /swatches/ or /labels/ url).
  const { rows } = await pool.query(`
    SELECT p.id AS product_id, s.id AS sku_id, m.id AS media_id, COALESCE(m.original_url, m.url) AS src
    FROM products p JOIN skus s ON s.product_id = p.id
    JOIN media_assets m ON m.product_id = p.id AND m.asset_type = 'primary'
    WHERE p.brand_id = $1`, [brand.id]);

  let processed = 0, alts = 0, failed = 0;
  for (const r of rows) {
    const slug = slugOf(r.src);
    if (!slug) { failed++; continue; }
    const localPath = path.join(OUTDIR, `${slug}.jpg`);
    const localUrl = `/uploads/akua/${slug}.jpg`;
    try {
      const resp = await fetch(swatchUrl(slug), { signal: AbortSignal.timeout(25000) });
      if (!resp.ok) throw new Error(`swatch ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const out = await sharp(buf).trim({ threshold: 15 }).resize(600, 600, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
      fs.writeFileSync(localPath, out);
      // Repoint primary to the centered local image (keep the source in original_url).
      await pool.query(`UPDATE media_assets SET url=$1, original_url=$2 WHERE id=$3`, [localUrl, swatchUrl(slug), r.media_id]);
      processed++;
    } catch (e) {
      failed++; console.error(`  ! ${slug}: ${e.message}`); continue;
    }
    // Add the tear sheet as an alternate (idempotent).
    const lbl = labelUrl(slug);
    const exists = (await pool.query(
      `SELECT 1 FROM media_assets WHERE product_id=$1 AND original_url=$2`, [r.product_id, lbl])).rowCount;
    if (!exists) {
      await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,'alternate',$3,$3,2)`, [r.product_id, r.sku_id, lbl]);
      alts++;
    }
  }
  console.log(`\n✓ Akua swatches: ${processed} centered, ${alts} tear-sheet alternates added, ${failed} failed.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
