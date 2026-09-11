/**
 * Bosphorus images: de-grain the low-res CDN "preview" swatches.
 *
 * Bosphorus (vendor BOS) media are 149x150 `.preview.jpg` option swatches from
 * bosphorusimports.com — full-bleed (no border) but tiny, so the PDP hero looks
 * grainy/soft when upscaled (no higher-res variant exists; non-preview 404s).
 *
 * Same treatment as the Akua swatch fix (minus centering, since these are
 * full-bleed): download each DISTINCT source image, resize to 600 with a light
 * median denoise + unsharp to cut the amplified JPEG grain and crisp edges, save
 * to uploads/bosphorus/<key>.jpg (served at /uploads/bosphorus/…), and repoint
 * every media row on that source to the local file (original_url keeps the CDN
 * source). Idempotent — rows already pointing at /uploads/bosphorus are skipped.
 *
 * MUST run inside the api container (uploads volume + sharp). ~2,956 images.
 *   docker compose … exec -T api node scripts/fix-bosphorus-images.mjs
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
const OUTDIR = path.join(UPLOADS, 'bosphorus');
const CONCURRENCY = 8;

// bosphorusimports.com/cdn/uploads/capsule/attribute-option-value/2752/493.preview.jpg → "2752-493"
function keyOf(url) {
  const m = String(url).match(/attribute-option-value\/(\d+)\/(\d+)\.preview/i);
  if (m) return `${m[1]}-${m[2]}`;
  return String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').slice(-80);
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const vendor = (await pool.query(`SELECT id FROM vendors WHERE code='BOS' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('Bosphorus vendor not found');

  // Distinct CDN source images still pointing at the remote preview.
  const { rows } = await pool.query(`
    SELECT DISTINCT COALESCE(original_url, url) AS src
    FROM media_assets m JOIN products p ON p.id = m.product_id
    WHERE p.vendor_id = $1 AND COALESCE(m.original_url, m.url) LIKE 'http%bosphorusimports.com%'`, [vendor.id]);
  const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : null; })();
  if (LIMIT) rows.length = Math.min(rows.length, LIMIT);
  console.log(`${rows.length} distinct Bosphorus CDN images to process`);

  let done = 0, failed = 0, repointed = 0;
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const { src } = queue.shift();
      const key = keyOf(src);
      const localPath = path.join(OUTDIR, `${key}.jpg`);
      const localUrl = `/uploads/bosphorus/${key}.jpg`;
      try {
        if (!fs.existsSync(localPath)) {
          const resp = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
          if (!resp.ok) throw new Error(`${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const out = await sharp(buf)
            .resize(600, 600, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
            .median(2).sharpen({ sigma: 1.2 }).jpeg({ quality: 90 }).toBuffer();
          fs.writeFileSync(localPath, out);
        }
        const r = await pool.query(
          `UPDATE media_assets SET url=$1 WHERE COALESCE(original_url,url)=$2 AND url <> $1`, [localUrl, src]);
        repointed += r.rowCount;
        done++;
      } catch (e) { failed++; if (failed <= 20) console.error(`  ! ${key}: ${e.message}`); }
      if (done % 250 === 0) console.log(`  …${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n✓ Bosphorus: ${done} images processed, ${repointed} media rows repointed, ${failed} failed.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
