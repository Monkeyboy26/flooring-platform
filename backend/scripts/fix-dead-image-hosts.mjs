// Repair media_assets rows whose vendor image host died out from under us.
//
// Two known-dead hosts (2026-09-28 audit, see docs-thumbnail investigation):
//   digitalassets.daltile.com — Daltile killed the AEM/JCR renditions after the
//     Sept re-onboard. The SAME assets are still served by their Scene7 CDN:
//     .../DAL_images/<x>/<BASE>.jpg/jcr:content/renditions/...  →
//     https://s7d9.scene7.com/is/image/daltile/<BASE>
//   icontileus.com — Icon rebranded to icontile.com and the old wp-content
//     paths 404. No URL transform exists; the only copies left are the ones in
//     our own /api/img origin cache (_cache/orig/<sha256(url)>).
//
// For every media row on those hosts (any asset_type):
//   1. Probe the current URL — if it's actually alive, leave the row alone
//      (the nightly image-mirror cron will self-host it in due course).
//   2. digitalassets rows: probe the Scene7 candidate; if alive, mirror it to
//      uploads/mirror immediately (mirrorImage) and repoint the row.
//   3. Otherwise, rescue from the local /api/img origin cache: normalize the
//      cached bytes exactly like imageMirror does and write them under
//      uploads/mirror, repointing the row.
//   4. Rows that are dead with no replacement are DELETED (backed up first) so
//      the storefront/doc image lookups fall through to a sibling asset
//      instead of rendering a dead URL.
//
// Dry-run by default; pass --commit to write. Run INSIDE the api container
// (uploads/ and _cache/ live there; see the Versace onboard landmine).
//   docker exec flooring-api node scripts/fix-dead-image-hosts.mjs [--commit]

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import pg from 'pg';
import { mirrorImage } from '../lib/imageMirror.js';

const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const HOSTS = ['digitalassets.daltile.com', 'icontileus.com'];
const ORIG_CACHE_DIR = path.join(process.cwd(), '_cache', 'orig');
const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function probe(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(encodeURI(url), { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA } });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!ct.startsWith('image/') || buf.length < 2000) return null;
    return buf;
  } catch { clearTimeout(t); return null; }
}

// digitalassets .../<BASE>.<ext>/jcr:content/... → Scene7 asset name <BASE>
function scene7Candidate(url) {
  const m = url.match(/\/([^/]+)\.(?:jpe?g|tiff?|png|webp)\/jcr:content\//i)
    || url.match(/\/([^/]+)\.(?:jpe?g|tiff?|png|webp)(?:\?|$)/i);
  if (!m) return null;
  return `https://s7d9.scene7.com/is/image/daltile/${m[1]}`;
}

// Same normalize+write recipe as lib/imageMirror.js, but from a local buffer
// (the /api/img origin cache) instead of a network fetch.
function mirrorPathsFor(sourceUrl) {
  const key = crypto.createHash('md5').update(sourceUrl).digest('hex');
  const rel = `/${path.posix.join('uploads', 'mirror', key.slice(0, 2), key + '.webp')}`;
  const abs = path.join(UPLOADS_DIR, 'mirror', key.slice(0, 2), key + '.webp');
  return { rel, abs };
}
async function rescueFromCache(url) {
  // A mirror file may already exist (earlier run on another box, synced over) —
  // reuse it rather than requiring the origin cache locally.
  const existing = mirrorPathsFor(url);
  try {
    const st = fs.statSync(existing.abs);
    if (st.size >= 64) return { rel: existing.rel, bytes: st.size };
  } catch { /* not mirrored yet */ }
  const origPath = path.join(ORIG_CACHE_DIR, crypto.createHash('sha256').update(url).digest('hex'));
  if (!fs.existsSync(origPath)) return null;
  let buf;
  try { buf = fs.readFileSync(origPath); } catch { return null; }
  if (buf.length < 100) return null;
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) return null;
    const out = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    if (!out || out.length < 64) return null;
    const { rel, abs } = mirrorPathsFor(url);
    if (COMMIT) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, abs);
    }
    return { rel, bytes: out.length };
  } catch { return null; }
}

async function main() {
  const { rows } = await pool.query(`
    SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, ma.original_url,
           ma.sort_order, ma.mirrored_at, p.status AS product_status, p.name AS product_name, v.code AS vendor_code
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE ${HOSTS.map((_, i) => `ma.url LIKE $${i + 1}`).join(' OR ')}
    ORDER BY ma.url`, HOSTS.map(h => `%${h}%`));
  console.log(`${rows.length} media rows on dead hosts (${COMMIT ? 'COMMIT' : 'dry-run'})`);

  // Classify each DISTINCT url once.
  const byUrl = new Map();
  for (const r of rows) (byUrl.get(r.url) || byUrl.set(r.url, []).get(r.url)).push(r);
  const urls = [...byUrl.keys()];
  const plan = new Map(); // url → {action, candidate?, rescue?}
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      if (await probe(url)) { plan.set(url, { action: 'alive' }); continue; }
      if (url.includes('digitalassets.daltile.com')) {
        const cand = scene7Candidate(url);
        if (cand && await probe(cand)) { plan.set(url, { action: 'remap', candidate: cand }); continue; }
      }
      const rescue = await rescueFromCache(url);
      if (rescue) { plan.set(url, { action: 'rescue', rescue }); continue; }
      plan.set(url, { action: 'delete' });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const counts = {};
  for (const { action } of plan.values()) counts[action] = (counts[action] || 0) + 1;
  console.log('distinct URLs:', urls.length, JSON.stringify(counts));

  // Backup everything we may touch.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(process.cwd(), 'data', `dead-image-hosts-backup-${stamp}.json`);
  if (COMMIT) fs.writeFileSync(backupPath, JSON.stringify({ generated: stamp, rows }, null, 1));

  let remapped = 0, rescued = 0, deleted = 0, skippedAlive = 0;
  for (const [url, p] of plan) {
    const affected = byUrl.get(url);
    if (p.action === 'alive') { skippedAlive += affected.length; continue; }
    if (p.action === 'remap') {
      // Self-host the scene7 copy right now; fall back to just repointing at
      // scene7 (nightly cron mirrors later) if the mirror write fails.
      const m = COMMIT ? await mirrorImage(p.candidate) : { rel: null };
      for (const row of affected) {
        if (COMMIT) {
          if (m && m.rel) {
            await pool.query(
              `UPDATE media_assets SET url = $2, original_url = $3, mirrored_at = CURRENT_TIMESTAMP, mirror_bytes = $4 WHERE id = $1`,
              [row.id, m.rel, p.candidate, m.bytes || null]);
          } else {
            await pool.query(
              `UPDATE media_assets SET url = $2, original_url = $2, mirrored_at = NULL WHERE id = $1`,
              [row.id, p.candidate]);
          }
        }
        remapped++;
      }
    } else if (p.action === 'rescue') {
      for (const row of affected) {
        if (COMMIT) {
          await pool.query(
            `UPDATE media_assets SET url = $2, original_url = COALESCE(original_url, $3), mirrored_at = CURRENT_TIMESTAMP, mirror_bytes = $4 WHERE id = $1`,
            [row.id, p.rescue.rel, url, p.rescue.bytes]);
        }
        rescued++;
      }
    } else { // delete
      for (const row of affected) {
        if (COMMIT) await pool.query('DELETE FROM media_assets WHERE id = $1', [row.id]);
        deleted++;
      }
    }
  }
  console.log(`rows → remapped ${remapped}, rescued ${rescued}, deleted ${deleted}, left-alone(alive) ${skippedAlive}`);
  if (COMMIT) console.log('backup:', backupPath);

  // Who is left with no image at all?
  const { rows: photoless } = await pool.query(`
    SELECT v.code, COUNT(DISTINCT p.id) AS products
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active' AND v.code IN ('DAL', 'ICON')
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        LEFT JOIN skus s ON s.id = ma.sku_id
        WHERE COALESCE(ma.product_id, s.product_id) = p.id AND ma.asset_type != 'spec_pdf')
    GROUP BY 1`);
  console.log('active products with NO media after this pass:', JSON.stringify(photoless));
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
