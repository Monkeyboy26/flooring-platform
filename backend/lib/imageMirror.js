// Image mirroring — self-host vendor images so a vendor CDN can't break them.
//
// Downloads a vendor image, normalizes it (resize to fit 1600x1600, re-encode
// webp), and writes it to uploads/mirror/<hash>.webp. That path is served the
// same proven way as every other self-hosted image: optimizeImg wraps /uploads/
// into /api/img (local-disk read + resize), nginx serves /uploads/ directly, and
// uploads/ is synced to S3 nightly — so mirrored files inherit offsite backup.
//
// Deliberately NOT MinIO/public-S3: this reuses the existing /uploads path with
// zero nginx/proxy/SSRF changes and no provisioning. A later migration to a
// dedicated public S3 bucket only has to rewrite media_assets.url + copy files.
//
// Durability > perfection: a source that won't download or decode is skipped
// (returns null), never a broken write. Callers keep the vendor URL as
// original_url so a skip can be retried later.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';
const MIRROR_SUBDIR = 'mirror';
const MAX_EDGE = 1600;
const WEBP_QUALITY = 82;
const MIN_DOWNLOAD = 100; // an empty/HTML error body; a real image is never this small
const MIN_DIM = 16;       // skip 1x1 tracking pixels / placeholder chips, keep real swatches

function mirrorPaths(sourceUrl) {
  const key = crypto.createHash('md5').update(sourceUrl).digest('hex');
  // Shard by first 2 hex chars so a single dir doesn't hold 60k files.
  const rel = `/${path.posix.join('uploads', MIRROR_SUBDIR, key.slice(0, 2), key + '.webp')}`;
  const abs = path.join(UPLOADS_DIR, MIRROR_SUBDIR, key.slice(0, 2), key + '.webp');
  return { rel, abs };
}

// True for URLs we should not (re)mirror: already self-hosted, or not http(s).
export function isMirrorable(url) {
  if (!url) return false;
  if (url.startsWith('/uploads/') || url.startsWith('/assets/')) return false;
  return /^https?:\/\//i.test(url);
}

/**
 * Mirror one source URL to uploads/mirror. Returns { rel, bytes, cached } or null.
 * Idempotent: an already-mirrored source is detected on disk and not re-fetched.
 */
export async function mirrorImage(sourceUrl, opts = {}) {
  if (!isMirrorable(sourceUrl)) return null;
  const { rel, abs } = mirrorPaths(sourceUrl);

  try {
    const st = fs.statSync(abs);
    if (st.size >= 64) return { rel, bytes: st.size, cached: true };
  } catch { /* not mirrored yet */ }

  let buf;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
    const res = await fetch(sourceUrl, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RomaImageMirror/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  } catch { return null; }
  if (!buf || buf.length < MIN_DOWNLOAD) return null;

  // Successful sharp decode is the real validity signal (an HTML error page
  // throws here); dimensions gate out tracking pixels. Output byte size is NOT
  // a validity signal — legitimate small swatches compress well under 1KB.
  let out;
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height || meta.width < MIN_DIM || meta.height < MIN_DIM) return null;
    out = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch { return null; } // undecodable (HTML error page, corrupt, etc.)
  if (!out || out.length < 64) return null;

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, abs); // atomic — a concurrent reader never sees a partial file
  } catch (err) {
    // Almost always a perms issue on uploads/ (must be writable by the api
    // container's gid). Warn ONCE and loudly — a silent skip here looks like a
    // dead source and would quietly mirror nothing. See ops note in schema.sql.
    if (!mirrorImage._warned) { mirrorImage._warned = true; console.error(`[imageMirror] cannot write ${abs}: ${err.message} — is uploads/ writable by the container user?`); }
    return null;
  }
  return { rel, bytes: out.length, cached: false };
}

/**
 * Mirror a media_assets row and persist the result. Moves the vendor URL to
 * original_url (kept for refresh/retry), points url at the local mirror, stamps
 * mirrored_at. No-op if already mirrored or unmirrorable. Returns bytes or null.
 */
export async function mirrorMediaRow(pool, row) {
  const source = row.original_url && isMirrorable(row.original_url) ? row.original_url
    : (isMirrorable(row.url) ? row.url : null);
  if (!source) return null;
  const r = await mirrorImage(source);
  if (!r) return null;
  await pool.query(
    `UPDATE media_assets
       SET original_url = COALESCE(original_url, $2),
           url = $3, mirrored_at = CURRENT_TIMESTAMP, mirror_bytes = $4
     WHERE id = $1`,
    [row.id, source, r.rel, r.bytes]
  );
  return r.bytes;
}
