#!/usr/bin/env node
/**
 * Fix Color Wheel (and other solid-color ceramic) field-tile images.
 *
 * Color Wheel is solid-color wall tile: every size/finish of a color looks the
 * same flat color, so the ONLY things an image must get right are the color,
 * the finish, and — if shown as a tile — the size and bevel. The DB accumulated
 * poor matches from older imports: wrong-size renders (a 3x12 plank shown for a
 * 4x4 square) and bevel renders on plain tiles. For a solid color a clean SWATCH
 * is a fully accurate representation and never implies the wrong size/edge, so
 * that's the safe fallback.
 *
 * Rule per field-tile SKU (trims and real mosaics are left untouched):
 *   - keep the current image if it's already good (a swatch, or a render whose
 *     size AND bevel match the SKU);
 *   - otherwise use the map's own per-SKU image when it's good (usually already
 *     the right swatch), else the color's canonical plain swatch.
 *
 * --dry-run / backup JSON / --revert, tagged source='colorwheel-fix'.
 *
 * Usage:
 *   node backend/scripts/daltile-fix-colorwheel-images.cjs --dry-run
 *   node backend/scripts/daltile-fix-colorwheel-images.cjs
 *   node backend/scripts/daltile-fix-colorwheel-images.cjs --revert <backup.json>
 *   node backend/scripts/daltile-fix-colorwheel-images.cjs --collection "%color wheel%"
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const {
  skuIsTrim, isMosaicImage, isSwatchUrl, isDamTifUrl, normalizeMapUrl,
} = require('../scrapers/daltile-image-rank.cjs');
const { patternFromVendorSku } = require('../scrapers/daltile-mosaic-pattern.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const revertIdx = process.argv.indexOf('--revert');
const REVERT_FILE = revertIdx !== -1 ? process.argv[revertIdx + 1] : null;
const collIdx = process.argv.indexOf('--collection');
const COLLECTION = collIdx !== -1 ? process.argv[collIdx + 1] : '%color wheel%';
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── image / sku feature helpers ──
const isBevelUrl = (u) => /bevel/i.test(u || '');
const imgSize = (u) => { const m = (u || '').match(/DAL_[A-Z0-9]+_(\d+x\d+)/i); return m ? m[1].toLowerCase() : null; };
const skuSize = (vn, vs) => {
  let m = (vn || '').toLowerCase().match(/(\d+x\d+)/);
  if (m) return m[1];
  m = (vs || '').toUpperCase().match(/(?:RCT|SQU)(\d{2})(\d{2})/);
  return m ? `${+m[1]}x${+m[2]}` : null;
};
const skuBevel = (vn, vs) => /bevel/i.test(vn || '') || /BV/.test((vs || '').toUpperCase());

// A "good" image for a plain solid-color field SKU: not a mosaic render, and
// either a swatch (edge/size-neutral) or a render whose bevel and size match.
function imageGood(url, size, bevel) {
  if (!url) return false;
  if (isMosaicImage(url)) return false;
  if (isSwatchUrl(url)) return true;
  if (isBevelUrl(url) !== bevel) return false;
  const is = imgSize(url);
  if (is && size && is !== size) return false;
  return true;
}

// Daltile's product map lists swatch/render URLs that were never published to
// Scene7 (4x4/2x2 Classic swatches, size-specific SemiGloss/Accent swatches all
// 403). Only assign an image that actually resolves, so we never trade a working
// (if imperfect) image for a broken one. Cached per distinct URL.
const _liveCache = new Map();
async function urlLive(url) {
  if (!url) return false;
  if (_liveCache.has(url)) return _liveCache.get(url);
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}wid=64`, { signal: ctrl.signal });
    clearTimeout(t);
    ok = res.status === 200;
  } catch { ok = false; }
  _liveCache.set(url, ok);
  return ok;
}
async function firstLive(urls) {
  for (const u of urls) { if (u && await urlLive(u)) return u; }
  return null;
}

async function revert(file) {
  const changes = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Reverting ${changes.length} Color Wheel image changes...`);
  for (const c of changes) {
    await pool.query(
      `UPDATE media_assets SET url = $1, original_url = $1, source = $2 WHERE id = $3`,
      [c.old_url, c.old_source || 'scraper', c.ma_id]
    );
  }
  console.log(`Reverted ${changes.length} rows.`);
  await pool.end();
}

async function main() {
  if (REVERT_FILE) return revert(REVERT_FILE);

  console.log(`\nColor Wheel Image Fix${DRY_RUN ? ' (DRY RUN)' : ''}  [collection LIKE '${COLLECTION}']\n`);

  // Build coveoSku→image map and per-color-code candidate pool from the product map.
  const productMap = require(path.join(DATA_DIR, 'daltile-product-map.json'));
  const mapImg = new Map();
  const poolByCode = new Map();
  for (const series of Object.values(productMap.series)) {
    for (const product of Object.values(series.products || {})) {
      for (const sku of product.skus || []) {
        const cs = sku.coveoSku;
        if (!cs) continue;
        const img = sku.productImageUrl || '';
        if (!img) continue;
        mapImg.set(cs.toUpperCase(), img);
        if (isDamTifUrl(img)) continue;
        const code = cs.slice(0, 4).toUpperCase();
        const sizes = String(sku.size || '').toLowerCase().replace(/ /g, '').split(',');
        for (const sz of sizes) {
          if (!poolByCode.has(code)) poolByCode.set(code, []);
          poolByCode.get(code).push({ url: img, size: sz.trim(), bevel: isBevelUrl(img), mosaic: isMosaicImage(img), swatch: isSwatchUrl(img) });
        }
      }
    }
  }
  // Swatches for a color, ordered by how reliably Daltile publishes them:
  // 6x6 and 3x6 swatches resolve; 4x4/2x2 Classic swatches are the broken ones.
  const swatchCandidates = (code) => {
    const sw = (poolByCode.get(code) || []).filter((c) => c.swatch && !c.mosaic);
    const rank = (u) => {
      const s = imgSize(u) || '';
      if (s === '6x6') return 0;
      if (s === '3x6') return 1;
      if (s === '2x2' || s === '4x4') return 3;   // most likely broken → try last
      return 2;
    };
    sw.sort((a, b) => rank(a.url) - rank(b.url) || a.url.length - b.url.length);
    return [...new Set(sw.map((c) => c.url))];
  };
  const exactRenders = (code, size, bevel) =>
    (poolByCode.get(code) || [])
      .filter((c) => !c.swatch && !c.mosaic && c.size === size && c.bevel === bevel)
      .map((c) => c.url);
  const anyRenders = (code, bevel) =>
    (poolByCode.get(code) || [])
      .filter((c) => !c.swatch && !c.mosaic && c.bevel === bevel)
      .map((c) => c.url);

  const { rows } = await pool.query(`
    SELECT ma.id AS ma_id, ma.url AS current_url, ma.source AS old_source,
           s.id AS sku_id, s.vendor_sku, s.variant_name, p.collection
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active'
      AND ma.asset_type = 'primary' AND ma.sort_order = 0
      AND p.collection ILIKE $1
  `, [COLLECTION]);
  console.log(`Active SKUs in scope: ${rows.length}`);

  const changes = [];
  const stats = { keptGood: 0, trims: 0, mosaics: 0, noBetter: 0 };
  for (const row of rows) {
    const { vendor_sku: vs, variant_name: vn, current_url: cur } = row;
    if (skuIsTrim(vs)) { stats.trims++; continue; }
    const size = skuSize(vn, vs);
    const bevel = skuBevel(vn, vs);
    const code = vs.slice(0, 4).toUpperCase();

    // Genuine mosaic SKU: keep its (pattern-correct) image while it loads; only
    // when that image is a dead link fall back to a working color swatch so the
    // card isn't blank (the "2x2 Mosaic …" name still conveys the format).
    if (patternFromVendorSku(vs)) {
      if (await urlLive(cur)) { stats.mosaics++; continue; }
      const target = await firstLive(swatchCandidates(code).map(normalizeMapUrl));
      if (!target || target === cur) { stats.noBetter++; continue; }
      changes.push({
        ma_id: row.ma_id, sku_id: row.sku_id, vendor_sku: vs, collection: row.collection,
        old_url: cur, new_url: target, old_source: row.old_source,
        target_kind: `broken-mosaic→${isSwatchUrl(target) ? 'swatch' : 'render'}`,
      });
      continue;
    }

    const curOk = imageGood(cur, size, bevel);
    // If the current image is already good AND it actually loads, keep it.
    if (curOk && await urlLive(cur)) { stats.keptGood++; continue; }

    // Preference order (best → worst), all must resolve. For a solid color a
    // clean swatch beats a wrong-size render, but a working render beats a
    // broken swatch — so validate liveness down the list.
    const mi = normalizeMapUrl(mapImg.get(vs.toUpperCase()));
    const candidates = [
      ...exactRenders(code, size, bevel).map(normalizeMapUrl),   // right size + edge render
      ...(imageGood(mi, size, bevel) ? [mi] : []),               // map's own image if good
      ...swatchCandidates(code).map(normalizeMapUrl),            // color-accurate swatch (6x6/3x6 first)
      cur,                                                       // keep current if it loads
      ...anyRenders(code, bevel).map(normalizeMapUrl),           // any same-edge render of the color
    ].filter((u) => u && !isDamTifUrl(u));

    const target = await firstLive([...new Set(candidates)]);
    if (!target || target === cur) { stats.noBetter++; continue; }

    changes.push({
      ma_id: row.ma_id, sku_id: row.sku_id, vendor_sku: vs, collection: row.collection,
      old_url: cur, new_url: target, old_source: row.old_source,
      target_kind: isSwatchUrl(target) ? 'swatch' : 'render',
    });
  }

  const swatches = changes.filter((c) => c.target_kind === 'swatch').length;
  console.log(`\nPoor field-tile images to fix: ${changes.length}  (→swatch ${swatches}, →render ${changes.length - swatches})`);
  console.log(`Left as-is: ${stats.keptGood} already-good, ${stats.trims} trims, ${stats.mosaics} mosaics, ${stats.noBetter} no-better-option`);

  console.log('\n=== Examples (vendor_sku | old → new) ===');
  for (const c of changes.slice(0, 12)) {
    const short = (u) => (u && u.includes('/daltile/')) ? u.split('/daltile/').pop() : (u ? u.split('/').pop() : '(none)');
    console.log(`  ${c.vendor_sku}:  ${short(c.old_url)}  →  ${short(c.new_url)}`);
  }

  if (changes.length === 0) { console.log('\nNothing to fix.'); await pool.end(); return; }
  if (DRY_RUN) { console.log('\nDRY RUN — no changes written.'); await pool.end(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `daltile-colorwheel-image-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
  console.log(`\nBackup written: ${path.relative(process.cwd(), backupPath)}`);

  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        `UPDATE media_assets SET url = $1, original_url = $1, source = 'colorwheel-fix' WHERE id = $2`,
        [c.new_url, c.ma_id]
      );
      applied++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`Applied ${applied} Color Wheel image fixes.`);
  console.log(`Revert with: node backend/scripts/daltile-fix-colorwheel-images.cjs --revert ${path.relative(process.cwd(), backupPath)}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
