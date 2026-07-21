#!/usr/bin/env node
/**
 * Replace DEAD Daltile primary images across the whole catalog.
 *
 * Daltile's product map lists Scene7/DAM URLs that were never published (4x4 /
 * 2x2 Classic swatches, size-specific SemiGloss/Accent swatches, some 2x2_Msc
 * mosaics, stale DAM TIFs) — the importer writes them blind, so those SKUs show
 * a blank card. This finds every active SKU whose primary image does NOT resolve
 * and swaps in a working alternative, preferring (all liveness-checked):
 *   own color swatch → same-size+bevel color render → 6x6/3x6 swatch →
 *   any same-edge render → the SKU's own alternate/lifestyle media.
 * Mosaic SKUs whose mosaic render is dead fall back to a live color swatch.
 * A SKU with no live candidate is left as-is and logged. Working images are
 * never touched — this only repairs broken ones.
 *
 * --dry-run / backup JSON / --revert, tagged source='broken-image-fix'.
 *
 * Usage:
 *   node backend/scripts/daltile-fix-broken-images.cjs --dry-run
 *   node backend/scripts/daltile-fix-broken-images.cjs
 *   node backend/scripts/daltile-fix-broken-images.cjs --revert <backup.json>
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
const CONCURRENCY = 24;
const DATA_DIR = path.join(__dirname, '..', 'data');

const isBevelUrl = (u) => /bevel/i.test(u || '');
// Generic sample-board images are bare codes (S1212J, P43F9, A4200) with no
// color/size tokens — Daltile reuses ONE across many colors, so they're not
// color-accurate. Real product images are descriptive (DAL_<code>_<size>_<Color>).
const isGenericSampleUrl = (u) => /^[A-Z0-9]{3,9}$/.test((u || '').split('?')[0].split('/').pop() || '');
const imgSize = (u) => { const m = (u || '').match(/DAL_[A-Z0-9]+_(\d+x\d+)/i); return m ? m[1].toLowerCase() : null; };
const skuSize = (vn, vs) => {
  let m = (vn || '').toLowerCase().match(/(\d+x\d+)/); if (m) return m[1];
  m = (vs || '').toUpperCase().match(/(?:RCT|SQU)(\d{2})(\d{2})/); return m ? `${+m[1]}x${+m[2]}` : null;
};
const skuBevel = (vn, vs) => /bevel/i.test(vn || '') || /BV/.test((vs || '').toUpperCase());

// ── Scene7 liveness (a URL resolves iff GET ?wid=64 → 200) ──
const _live = new Map();
async function checkOne(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const sep = url.includes('?') ? '&' : '?';
    // encodeURI so raw spaces (e.g. "Hex 4in", "Arabesque Mosaic") don't fail
    // the request and get mis-flagged as broken.
    const res = await fetch(`${encodeURI(url)}${sep}wid=64`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status === 200;
  } catch { return false; }
}
async function validateAll(urls) {
  const todo = [...new Set(urls)].filter((u) => u && !_live.has(u));
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(checkOne));
    batch.forEach((u, j) => _live.set(u, results[j]));
  }
}
const firstLive = (urls) => urls.find((u) => u && _live.get(u)) || null;

async function revert(file) {
  const changes = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Reverting ${changes.length} image changes...`);
  for (const c of changes) {
    await pool.query(`UPDATE media_assets SET url = $1, original_url = $1, source = $2 WHERE id = $3`,
      [c.old_url, c.old_source || 'scraper', c.ma_id]);
  }
  console.log(`Reverted ${changes.length} rows.`);
  await pool.end();
}

async function main() {
  if (REVERT_FILE) return revert(REVERT_FILE);
  console.log(`\nDaltile Broken-Image Repair${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Map: coveoSku → own alternates; per-color-code candidate pool.
  const productMap = require(path.join(DATA_DIR, 'daltile-product-map.json'));
  const ownAlt = new Map();      // coveoSku → [swatchUrl, roomSceneUrl]
  const poolByCode = new Map();  // code → [{url,size,bevel,mosaic,swatch}]
  const ownSwatch = new Map();   // coveoSku → swatchUrl (product-like)
  const ownRoom = new Map();     // coveoSku → roomSceneUrl (scene-like, last resort)
  for (const series of Object.values(productMap.series)) {
    for (const bucket of [series.products, series.accessories]) {
      for (const product of Object.values(bucket || {})) {
        for (const sku of product.skus || []) {
          const cs = sku.coveoSku; if (!cs) continue;
          ownAlt.set(cs.toUpperCase(), [sku.swatchUrl, sku.roomSceneUrl].filter(Boolean).map(normalizeMapUrl));
          if (sku.swatchUrl) ownSwatch.set(cs.toUpperCase(), normalizeMapUrl(sku.swatchUrl));
          if (sku.roomSceneUrl) ownRoom.set(cs.toUpperCase(), normalizeMapUrl(sku.roomSceneUrl));
          const code = cs.slice(0, 4).toUpperCase();
          for (const img of [sku.productImageUrl, sku.swatchUrl].filter(Boolean)) {
            if (isDamTifUrl(img)) continue;
            const sizes = String(sku.size || '').toLowerCase().replace(/ /g, '').split(',');
            for (const sz of sizes) {
              if (!poolByCode.has(code)) poolByCode.set(code, []);
              poolByCode.get(code).push({ url: normalizeMapUrl(img), size: sz.trim(), bevel: isBevelUrl(img), mosaic: isMosaicImage(img), swatch: isSwatchUrl(img) });
            }
          }
        }
      }
    }
  }
  const swatchCands = (code) => {
    const sw = (poolByCode.get(code) || []).filter((c) => c.swatch && !c.mosaic);
    const rank = (u) => { const s = imgSize(u); return s === '6x6' ? 0 : s === '3x6' ? 1 : (s === '2x2' || s === '4x4') ? 3 : 2; };
    sw.sort((a, b) => rank(a.url) - rank(b.url) || a.url.length - b.url.length);
    return [...new Set(sw.map((c) => c.url))];
  };
  const exactRenders = (code, size, bevel) => (poolByCode.get(code) || [])
    .filter((c) => !c.swatch && !c.mosaic && c.size === size && c.bevel === bevel).map((c) => c.url);
  const anyRenders = (code, bevel) => (poolByCode.get(code) || [])
    .filter((c) => !c.swatch && !c.mosaic && c.bevel === bevel).map((c) => c.url);
  const anyNonMosaic = (code) => (poolByCode.get(code) || []).filter((c) => !c.mosaic).map((c) => c.url);

  // DB: current primaries + each SKU's own other live-candidate media.
  const primaries = (await pool.query(`
    SELECT ma.id AS ma_id, ma.url AS current_url, ma.source AS old_source,
           s.id AS sku_id, s.vendor_sku, s.variant_name, p.collection
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active'
      AND ma.asset_type = 'primary' AND ma.sort_order = 0
  `)).rows;
  const ownProduct = new Map();  // sku_id → [swatch/alternate urls]
  const ownScene = new Map();    // sku_id → [lifestyle urls]
  for (const r of (await pool.query(`
    SELECT ma.sku_id, ma.url, ma.asset_type FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active' AND ma.asset_type <> 'primary' AND ma.sku_id IS NOT NULL
  `)).rows) {
    const bag = r.asset_type === 'lifestyle' ? ownScene : ownProduct;
    if (!bag.has(r.sku_id)) bag.set(r.sku_id, []);
    bag.get(r.sku_id).push(r.url);
  }
  console.log(`Active primaries: ${primaries.length}. Checking which resolve…`);

  // 1) validate every current primary; 2) build candidates for the broken ones.
  await validateAll(primaries.map((r) => r.current_url));
  const brokenRows = primaries.filter((r) => !_live.get(r.current_url));
  console.log(`Broken primaries: ${brokenRows.length}`);

  const candMap = new Map();  // ma_id → ordered candidate urls
  const sceneByMa = new Map();  // ma_id → Set of scene-like urls
  const allCands = [];
  for (const row of brokenRows) {
    const { vendor_sku: vs, variant_name: vn, sku_id } = row;
    const code = vs.slice(0, 4).toUpperCase();
    const size = skuSize(vn, vs), bevel = skuBevel(vn, vs);
    const mosaicSku = !!patternFromVendorSku(vs);
    const key = vs.toUpperCase();
    // Product-like images (swatch / product render) first; a shared series ROOM
    // SCENE is only a last resort so we don't collapse a series onto one photo.
    const productLike = mosaicSku
      ? [ownSwatch.get(key), ...swatchCands(code), ...anyNonMosaic(code), ...(ownProduct.get(sku_id) || [])]
      : [ownSwatch.get(key), ...exactRenders(code, size, bevel), ...swatchCands(code), ...anyRenders(code, bevel), ...(ownProduct.get(sku_id) || [])];
    const sceneLike = [...(ownScene.get(sku_id) || []), ownRoom.get(key)];
    let c = [...productLike, ...sceneLike];
    c = [...new Set(c.filter((u) => u && u !== row.current_url && !isDamTifUrl(u) && !isGenericSampleUrl(u)))];
    candMap.set(row.ma_id, c);
    sceneByMa.set(row.ma_id, new Set(sceneLike.filter(Boolean)));
    allCands.push(...c);
  }
  console.log(`Validating ${new Set(allCands).size} candidate URLs…`);
  await validateAll(allCands);

  const changes = [];
  const stats = { noLive: 0, byKind: {}, sceneFallback: 0 };
  for (const row of brokenRows) {
    const target = firstLive(candMap.get(row.ma_id));
    if (!target) { stats.noLive++; continue; }
    const isScene = sceneByMa.get(row.ma_id).has(target);
    const kind = isScene ? 'room-scene' : (isSwatchUrl(target) ? 'swatch' : 'render');
    if (isScene) stats.sceneFallback++;
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    changes.push({
      ma_id: row.ma_id, sku_id: row.sku_id, vendor_sku: row.vendor_sku, collection: row.collection,
      old_url: row.current_url, new_url: target, old_source: row.old_source, target_kind: kind,
    });
  }

  console.log(`\nRepairable: ${changes.length}  (${JSON.stringify(stats.byKind)})`);
  console.log(`  of which room-scene fallbacks (series-shared photo): ${stats.sceneFallback}`);
  console.log(`No live candidate (left as-is): ${stats.noLive}`);
  console.log('\n=== Examples (vendor_sku | collection | old → new) ===');
  for (const c of changes.slice(0, 15)) {
    const sh = (u) => (u && u.includes('/daltile/')) ? u.split('/daltile/').pop() : (u ? u.split('/').pop() : '(none)');
    console.log(`  ${c.vendor_sku} [${c.collection}]\n     ${sh(c.old_url)}  →  ${sh(c.new_url)}`);
  }

  if (changes.length === 0) { console.log('\nNothing to repair.'); await pool.end(); return; }
  if (DRY_RUN) {
    const rp = path.join(DATA_DIR, 'daltile-broken-image-dryrun.json');
    fs.writeFileSync(rp, JSON.stringify(changes, null, 2));
    console.log(`\nDRY RUN — no changes written. Report: ${path.relative(process.cwd(), rp)}`);
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `daltile-broken-image-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
  console.log(`\nBackup written: ${path.relative(process.cwd(), backupPath)}`);

  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(`UPDATE media_assets SET url = $1, original_url = $1, source = 'broken-image-fix' WHERE id = $2`, [c.new_url, c.ma_id]);
      applied++;
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  console.log(`Applied ${applied} broken-image repairs.`);
  console.log(`Revert with: node backend/scripts/daltile-fix-broken-images.cjs --revert ${path.relative(process.cwd(), backupPath)}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
