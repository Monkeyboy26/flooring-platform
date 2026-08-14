#!/usr/bin/env node
/**
 * Mirror Eurostone product images locally.
 *
 * The swatches live on i.ibb.co, which HOTLINK-PROTECTS: it serves an "image not found"
 * placeholder to non-browser User-Agents (e.g. the platform image proxy's 'Roma-ImageProxy/1.0'),
 * so /api/img can't fetch them. We download the bytes here with a browser-like UA + Referer and
 * host them under ./uploads/products/eurostone/, then point media_assets at /uploads/... paths
 * (served from disk by the proxy, no external fetch).
 *
 * Input:  backend/data/eurostone/images.json  (remote source URLs, keyed by product slug)
 * Output: files in ./uploads/products/eurostone/  +  backend/data/eurostone/images-local.json
 *
 * Usage: node backend/scripts/mirror-eurostone-images.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'eurostone');
const OUT_DIR = path.join(__dirname, '..', '..', 'uploads', 'products', 'eurostone');
const WEB_PREFIX = '/uploads/products/eurostone';

const images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://www.eurostonequartzcountertops.com/',
  'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
};

const extOf = (url) => {
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Reject imgbb's "not found" placeholder (small) — real slab shots are large.
async function download(url, dest, attempt = 0) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const resp = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!ct.startsWith('image/')) throw new Error('not an image: ' + ct);
    if (buf.length < 3000) throw new Error('too small (' + buf.length + 'b) — likely placeholder');
    fs.writeFileSync(dest, buf);
    return buf.length;
  } catch (e) {
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return download(url, dest, attempt + 1); }
    throw e;
  }
}

const local = {};
let ok = 0, fail = 0;
const fails = [];

for (const [slug, entry] of Object.entries(images)) {
  const urls = [entry.primary, ...(entry.gallery || [])].filter(Boolean);
  const savedPrimary = [];
  const savedGallery = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const file = `${slug}__${i}.${extOf(url)}`;
    const dest = path.join(OUT_DIR, file);
    try {
      const bytes = await download(url, dest);
      (i === 0 ? savedPrimary : savedGallery).push(`${WEB_PREFIX}/${file}`);
      ok++;
      process.stdout.write(`  ✓ ${file} (${Math.round(bytes/1024)}k)\n`);
    } catch (e) {
      fail++; fails.push(`${file}: ${e.message}`);
      process.stdout.write(`  ✗ ${file} — ${e.message}\n`);
    }
    await sleep(250); // be polite to imgbb
  }
  if (savedPrimary.length || savedGallery.length) {
    local[slug] = { primary: savedPrimary[0] || savedGallery.shift() || null, gallery: savedGallery };
  }
}

fs.writeFileSync(path.join(DATA_DIR, 'images-local.json'), JSON.stringify(local, null, 2));
console.log(`\nDownloaded ${ok} files, ${fail} failed. Wrote images-local.json (${Object.keys(local).length} products).`);
if (fails.length) console.log('Failures:\n' + fails.join('\n'));
