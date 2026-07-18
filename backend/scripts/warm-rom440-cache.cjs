#!/usr/bin/env node
/**
 * Pre-warm the image proxy cache for all Hardware Resources (ROM440) local images.
 *
 * Directly reads source files and encodes with Sharp — bypasses the HTTP server
 * entirely to avoid resource contention. Writes cache files using the same
 * hash scheme as /api/img so they're served as HITs.
 *
 * Usage: node scripts/warm-rom440-cache.cjs [--concurrency=6]
 */

const { Pool } = require('pg');
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const args = process.argv.slice(2);
function parseFlag(prefix, def) {
  const a = args.find(x => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : def;
}

const CONCURRENCY = parseInt(parseFlag('--concurrency=', '6'), 10);
const WIDTHS = [200, 400, 600, 800];
const FMT = 'webp';
const QUALITY = 80;
const CACHE_DIR = path.join(process.cwd(), '_cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Must match server.js cache key: sha256(`${url}|${w}||${q}|${fmt}`)
function cacheKey(url, w) {
  return crypto.createHash('sha256').update(`${url}|${w}||${QUALITY}|${FMT}`).digest('hex');
}

async function main() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ma.url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ROM440'
      AND ma.url IS NOT NULL AND ma.url != ''
      AND ma.url LIKE '/uploads/%'
  `);

  // Build task list, skipping already-cached entries
  const tasks = [];
  let skipped = 0;
  for (const { url } of rows) {
    for (const w of WIDTHS) {
      const key = cacheKey(url, w);
      const cachePath = path.join(CACHE_DIR, `${key}.${FMT}`);
      if (fs.existsSync(cachePath)) {
        skipped++;
      } else {
        tasks.push({ url, w, cachePath });
      }
    }
  }

  const total = rows.length * WIDTHS.length;
  console.log(`ROM440 local images: ${rows.length}`);
  console.log(`Total cache entries needed: ${total}`);
  console.log(`Already cached: ${skipped}`);
  console.log(`To encode: ${tasks.length}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  if (tasks.length === 0) {
    console.log('Nothing to do — cache is fully warmed!');
    await pool.end();
    return;
  }

  let done = 0;
  let encoded = 0;
  let errors = 0;
  const start = Date.now();

  // Group tasks by source URL to read each file once
  const byUrl = new Map();
  for (const task of tasks) {
    if (!byUrl.has(task.url)) byUrl.set(task.url, []);
    byUrl.get(task.url).push(task);
  }
  const urlTasks = [...byUrl.entries()];

  async function processUrl(url, widthTasks) {
    const localPath = path.join(process.cwd(), url);
    let inputBuffer;
    try {
      inputBuffer = await fs.promises.readFile(localPath);
    } catch {
      errors += widthTasks.length;
      done += widthTasks.length;
      return;
    }

    for (const { w, cachePath } of widthTasks) {
      try {
        const outputBuffer = await sharp(inputBuffer)
          .resize({ width: w, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: QUALITY, smartSubsample: true })
          .toBuffer();

        if (outputBuffer.length > 500) {
          await fs.promises.writeFile(cachePath, outputBuffer);
          encoded++;
        }
      } catch {
        errors++;
      }
      done++;
      if (done % 500 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const rate = (done / (Date.now() - start) * 1000).toFixed(1);
        console.log(`  [${done}/${tasks.length}] ${encoded} encoded, ${errors} err — ${elapsed}s (${rate}/s)`);
      }
    }
  }

  // Process with bounded concurrency (per source URL)
  const executing = new Set();
  for (const [url, widthTasks] of urlTasks) {
    const p = processUrl(url, widthTasks).then(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s: ${encoded} newly cached, ${errors} errors, ${skipped} already cached`);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
