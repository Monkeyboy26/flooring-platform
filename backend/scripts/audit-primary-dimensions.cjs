#!/usr/bin/env node
/**
 * audit-primary-dimensions.cjs
 *
 * Downloads primary image headers to check dimensions and aspect ratios.
 * Flags likely lifestyle/room-scene images based on:
 *   - Landscape aspect ratio > 1.4 (wide room scenes)
 *   - Very large images (> 2000px wide, often hero/banner shots)
 *   - Non-square non-portrait images that don't match typical product shot ratios
 *
 * Usage:
 *   node backend/scripts/audit-primary-dimensions.cjs --vendor "Emser Tile"
 *   node backend/scripts/audit-primary-dimensions.cjs --vendor "Daltile" --limit 500
 *   node backend/scripts/audit-primary-dimensions.cjs --all --limit 200
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const args = process.argv.slice(2);
const vendorArg = args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : null;
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 500;
const allVendors = args.includes('--all');
const CONCURRENCY = 20;

// Minimal JPEG/PNG dimension parser from first bytes
function getImageSize(buffer) {
  // PNG: width at bytes 16-19, height at 20-23
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }
  // JPEG: scan for SOF markers
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 10) {
      if (buffer[offset] !== 0xFF) { offset++; continue; }
      const marker = buffer[offset + 1];
      // SOF0, SOF1, SOF2 markers
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // WebP: RIFF header
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    // VP8 lossy
    if (buffer.toString('ascii', 12, 16) === 'VP8 ') {
      const width = buffer.readUInt16LE(26) & 0x3FFF;
      const height = buffer.readUInt16LE(28) & 0x3FFF;
      return { width, height };
    }
    // VP8L lossless
    if (buffer.toString('ascii', 12, 16) === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3FFF) + 1;
      const height = ((bits >> 14) & 0x3FFF) + 1;
      return { width, height };
    }
  }
  return null;
}

function fetchPartial(url, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('timeout')); }, 10000);
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(url, { headers: { 'Range': `bytes=0-${maxBytes}` } }, res => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout);
          resolve(fetchPartial(res.headers.location, maxBytes));
          res.destroy();
          return;
        }
        const chunks = [];
        let totalLen = 0;
        res.on('data', chunk => {
          chunks.push(chunk);
          totalLen += chunk.length;
          if (totalLen >= maxBytes) { res.destroy(); }
        });
        res.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
        res.on('error', err => { clearTimeout(timeout); reject(err); });
      });
      req.on('error', err => { clearTimeout(timeout); reject(err); });
    } catch (e) { clearTimeout(timeout); reject(e); }
  });
}

async function checkImage(img) {
  try {
    const buf = await fetchPartial(img.url);
    const size = getImageSize(buf);
    if (!size || !size.width || !size.height) return { ...img, status: 'unknown' };
    const ratio = size.width / size.height;
    return { ...img, width: size.width, height: size.height, ratio, status: 'ok' };
  } catch (e) {
    return { ...img, status: 'error', error: e.message };
  }
}

async function processInBatches(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    process.stdout.write(`\r  Checked ${results.length}/${items.length}`);
  }
  process.stdout.write('\n');
  return results;
}

async function main() {
  const client = await pool.connect();

  try {
    let vendorFilter = '';
    const params = [limitArg];

    if (vendorArg) {
      vendorFilter = `AND v.name = $2`;
      params.push(vendorArg);
    }

    const { rows } = await client.query(`
      SELECT ma.id as media_id, ma.url, p.name as pname, p.collection, v.name as vendor,
             ma.product_id, ma.sku_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE ma.asset_type = 'primary' AND ma.sort_order = 0 AND ma.sku_id IS NOT NULL
        ${vendorFilter}
      ORDER BY RANDOM()
      LIMIT $1
    `, params);

    console.log(`Checking ${rows.length} primary images${vendorArg ? ` for ${vendorArg}` : ''}...\n`);

    const results = await processInBatches(rows, checkImage, CONCURRENCY);

    // Categorize
    const landscape = results.filter(r => r.status === 'ok' && r.ratio > 1.4);
    const veryWide = results.filter(r => r.status === 'ok' && r.ratio > 1.8);
    const broken = results.filter(r => r.status === 'error');
    const unknown = results.filter(r => r.status === 'unknown');
    const normal = results.filter(r => r.status === 'ok' && r.ratio <= 1.4);

    console.log(`\nResults:`);
    console.log(`  Normal (ratio <= 1.4):     ${normal.length}`);
    console.log(`  Landscape (ratio > 1.4):   ${landscape.length}`);
    console.log(`  Very wide (ratio > 1.8):   ${veryWide.length}`);
    console.log(`  Broken/error:              ${broken.length}`);
    console.log(`  Unknown format:            ${unknown.length}`);

    if (landscape.length > 0) {
      // Group by vendor
      const byVendor = {};
      landscape.forEach(r => {
        byVendor[r.vendor] = (byVendor[r.vendor] || []);
        byVendor[r.vendor].push(r);
      });

      console.log(`\n=== LANDSCAPE SUSPECTS (ratio > 1.4) ===`);
      for (const [vendor, items] of Object.entries(byVendor).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\n  ${vendor}: ${items.length} suspects`);
        items.sort((a, b) => b.ratio - a.ratio).slice(0, 10).forEach(r => {
          console.log(`    ${r.ratio.toFixed(2)} (${r.width}x${r.height}) ${r.pname}/${r.collection}`);
          console.log(`      ${r.url.split('/').pop().substring(0, 70)}`);
        });
        if (items.length > 10) console.log(`    ... and ${items.length - 10} more`);
      }
    }

    if (veryWide.length > 0) {
      console.log(`\n=== VERY WIDE (ratio > 1.8) — high confidence lifestyle ===`);
      veryWide.sort((a, b) => b.ratio - a.ratio).forEach(r => {
        console.log(`  ${r.ratio.toFixed(2)} (${r.width}x${r.height}) [${r.vendor}] ${r.pname}/${r.collection}`);
        console.log(`    ID: ${r.media_id}`);
      });
    }

    if (broken.length > 0) {
      console.log(`\n=== BROKEN IMAGES ===`);
      broken.forEach(r => {
        console.log(`  [${r.vendor}] ${r.pname}/${r.collection}: ${r.error}`);
        console.log(`    ${r.url.substring(0, 80)}`);
      });
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
