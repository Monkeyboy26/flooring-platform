#!/usr/bin/env node
/**
 * Stage Tile World product photos into the nginx-served uploads dir.
 *
 * Reads backend/data/tileworld/images-src.json (local /uploads/tileworld/<file>.jpg
 * -> remote tileworldusa.com thumbnail URL, produced by build-tileworld-catalog.js),
 * downloads each unique remote image once, resizes to <=1200px wide JPEG, and writes
 * it to uploads/tileworld/<file>.jpg. The importer references the local paths.
 *
 * Usage: node scripts/stage-tileworld-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'tileworld');
const UPLOADS = path.join(__dirname, '..', '..', 'uploads', 'tileworld');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

fs.mkdirSync(UPLOADS, { recursive: true });
const srcMap = JSON.parse(fs.readFileSync(path.join(DIR, 'images-src.json'), 'utf8'));

const remoteCache = new Map();   // remote url -> Buffer
async function fetchRemote(url) {
  if (remoteCache.has(url)) return remoteCache.get(url);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  remoteCache.set(url, buf);
  return buf;
}

const entries = Object.entries(srcMap);
let ok = 0, skip = 0, fail = 0;
const failures = [];

for (const [localPath, remoteUrl] of entries) {
  const file = path.basename(localPath);
  const dest = path.join(UPLOADS, file);
  if (fs.existsSync(dest) && !process.env.FORCE) { skip++; continue; }
  try {
    const buf = await fetchRemote(remoteUrl);
    await sharp(buf).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(dest);
    ok++;
    if (ok % 25 === 0) console.log(`  ...${ok} staged`);
  } catch (e) {
    fail++; failures.push(`${file}  <-  ${remoteUrl}  (${e.message})`);
  }
}

console.log(`\nStaged ${ok} images -> uploads/tileworld/  (skipped ${skip} existing, ${fail} failed)`);
if (failures.length) { console.log('Failures:'); failures.slice(0, 20).forEach((f) => console.log('  ' + f)); }
