#!/usr/bin/env node
/**
 * Pre-warm the image proxy cache for all Mannington media_assets.
 *
 * Requests each image at common widths (400, 800) in webp format through
 * the /api/img proxy so the disk cache is populated before users hit the site.
 *
 * Usage: node scripts/warm-image-cache.cjs [--vendor=MANNINGTON] [--concurrency=6]
 */

const { Pool } = require('pg');

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

const VENDOR = parseFlag('--vendor=', 'MANNINGTON').toUpperCase();
const CONCURRENCY = parseInt(parseFlag('--concurrency=', '6'), 10);
const API_BASE = `http://localhost:${process.env.PORT || 3001}`;
const WIDTHS = [400, 800];

async function main() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ma.url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1 AND ma.url IS NOT NULL AND ma.url != ''
  `, [VENDOR]);

  console.log(`Warming cache for ${rows.length} images × ${WIDTHS.length} sizes = ${rows.length * WIDTHS.length} requests`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  const tasks = [];
  for (const { url } of rows) {
    for (const w of WIDTHS) {
      tasks.push({ url, w });
    }
  }

  let done = 0;
  let hits = 0;
  let misses = 0;
  let errors = 0;
  const start = Date.now();

  async function processTask({ url, w }) {
    const proxyUrl = `${API_BASE}/api/img?url=${encodeURIComponent(url)}&w=${w}`;
    try {
      const resp = await fetch(proxyUrl, {
        headers: { 'Accept': 'image/webp,image/avif,*/*' },
      });
      if (resp.ok) {
        const xcache = resp.headers.get('x-cache');
        if (xcache === 'HIT') hits++;
        else misses++;
        // Consume the body
        await resp.arrayBuffer();
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
    done++;
    if (done % 100 === 0 || done === tasks.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const rate = (done / (Date.now() - start) * 1000).toFixed(1);
      console.log(`  [${done}/${tasks.length}] ${hits} HIT, ${misses} MISS, ${errors} err — ${elapsed}s (${rate}/s)`);
    }
  }

  // Process with bounded concurrency
  const executing = new Set();
  for (const task of tasks) {
    const p = processTask(task).then(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s: ${hits} cached (HIT), ${misses} newly warmed (MISS), ${errors} errors`);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
