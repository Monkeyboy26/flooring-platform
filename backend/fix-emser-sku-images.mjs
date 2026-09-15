#!/usr/bin/env node
/**
 * Emser per-SKU image matching fix.
 *
 * Problem: Emser CDN filenames embed the SKU code (`..._t06travsi1616aut_f1_large.jpg`,
 * `t06travsi1212oms_hr_large.jpg`), but many SKUs carry a same-color SIBLING's
 * image (e.g. the 12x12 mosaic showing the 16x16 field tile), and ~5.8K active
 * SKUs have no sku-level image at all (product-hero fallback = wrong variant).
 *
 * Fix strategy, per active EMS SKU missing an own-code image:
 *   1. Pool reuse: another media row in our DB already carries this SKU's code.
 *   2. CDN "hr" probe: https://<cdn>/userfiles/product/images/{ab}/{cd}/{ef}/{code}_hr_large.jpg
 *      (path shards = first 6 chars of the lowercased code, in pairs).
 *   3. Sibling template swap: take a same-series+same-color sibling's coded
 *      product-shot URL (…_f1_/_scan_f1_ style), substitute our code, HEAD-probe.
 * When an exact image is found: it becomes the SKU primary; existing sku-level
 * primary/alternate rows with a FOREIGN embedded code are removed (lifestyle
 * rows are kept — room scenes are ambient). Without an exact match the SKU is
 * left untouched (borrowed same-color image beats no image; never fabricate).
 *
 * Usage (from backend/):
 *   DB_PASSWORD=postgres node fix-emser-sku-images.mjs            # dry-run report
 *   DB_PASSWORD=postgres node fix-emser-sku-images.mjs --apply
 *   Optional: --limit 200 (cap SKUs processed), --concurrency 8
 * Reverse: delete media_assets WHERE source='fix-emser-sku-images' and restore
 * from the backup JSON written to backend/data/.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const APPLY = process.argv.includes('--apply');
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? parseInt(process.argv[i + 1], 10) : d; };
const LIMIT = argOf('--limit', Infinity);
const CONCURRENCY = argOf('--concurrency', 8);

const CDN = 'https://d3bauow4e98jr8.cloudfront.net/userfiles/product/images';
const CODE_RE = /(?:^|_|\/)([a-z]\d{2}[a-z0-9]{6,17})(?=_)/g;   // embedded sku codes in filenames
const OWN_CODE_RE = /^[a-z]\d{2}[a-z0-9]{6,17}$/;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function codesIn(url) {
  const out = [];
  const u = decodeURIComponent(String(url || '')).toLowerCase();
  const fname = u.split('/').pop() || '';
  for (const m of fname.matchAll(CODE_RE)) out.push(m[1]);
  return out;
}
function classifyUrl(url) {
  const f = (url.split('/').pop() || '').toLowerCase();
  if (/_scan_f\d/.test(f) || /_f1[_.]|_f1$/.test(f) || /_hr[_.]/.test(f)) return 'shot';
  if (/_f\d+/.test(f)) return 'alt';
  if (/room|_rs\d|_rs[_.]|vignette|expanse\d/.test(f)) return 'lifestyle';
  return 'other';
}
// series+color stem WITHOUT the 3-char channel prefix (I99WINTFR... and
// M05WINTFR... are the same line via different channels)
const stem = (code) => code.slice(3, 9);
// pattern/type suffix after the 4-digit size: '' = plain field tile,
// MOV = oval mosaic, BWH = basketweave honed, AUT = tumbled field, ...
function codeSuffix(code) {
  const m = code.match(/\d{4}([a-z0-9]*)$/);
  return m ? m[1] : null; // null = no size digits found (can't judge)
}
// A borrowed image is acceptable when only SIZE/FINISH/REVISION differ (same
// look); a different pattern suffix (BWH basketweave vs MOV oval) is
// misleading on a PDP. Normalize away revision (V2), pack (P24) and a trailing
// finish letter (H/P) before comparing.
function normSuffix(sfx) {
  let s = sfx;
  for (;;) {
    const n = s.replace(/(v\d|p\d+)$/, '');
    if (n === s) break;
    s = n;
  }
  if (s.length && /[hp]$/.test(s)) s = s.slice(0, -1);
  return s;
}
function patternMismatch(ownCode, imgCode) {
  const a = codeSuffix(ownCode), b = codeSuffix(imgCode);
  if (a == null || b == null) return false;
  return normSuffix(a) !== normSuffix(b);
}

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.status === 200;
  } catch { return false; }
}

// ── Load ─────────────────────────────────────────────────────────────────────

const { rows: skus } = await pool.query(`
  SELECT s.id sku_id, s.product_id, lower(s.vendor_sku) code, s.vendor_sku, s.variant_name, p.name pname
  FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
  WHERE v.code='EMS' AND s.status='active' AND p.status='active' AND s.vendor_sku IS NOT NULL
`);
const { rows: media } = await pool.query(`
  SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.sort_order, ma.url, ma.original_url
  FROM media_assets ma JOIN products p ON p.id=ma.product_id JOIN vendors v ON v.id=p.vendor_id
  WHERE v.code='EMS'
`);
console.log(`SKUs: ${skus.length}, media rows: ${media.length}`);

// pool of coded URLs across ALL EMS media (any product, any status)
const poolByCode = new Map();      // code -> Map(url -> class)
const mediaBySku = new Map();      // sku_id -> rows
for (const m of media) {
  const src = m.original_url || m.url;
  for (const c of codesIn(src)) {
    if (!poolByCode.has(c)) poolByCode.set(c, new Map());
    poolByCode.get(c).set(src, classifyUrl(src));
  }
  if (m.sku_id) {
    if (!mediaBySku.has(m.sku_id)) mediaBySku.set(m.sku_id, []);
    mediaBySku.get(m.sku_id).push(m);
  }
}
// sibling shot templates by series+color stem: url + the code it contains
const templatesByStem = new Map();
for (const [c, urls] of poolByCode) {
  for (const [u, cls] of urls) {
    if (cls !== 'shot') continue;
    const st = stem(c);
    if (!templatesByStem.has(st)) templatesByStem.set(st, []);
    templatesByStem.get(st).push({ url: u, code: c });
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

const plans = [];       // {sku, newPrimary, extraAlts, removeIds, via}
const counters = { ownAlready: 0, pooled: 0, hrProbe: 0, template: 0, wrongPatternRemoved: 0, noMatch: 0, badCode: 0 };
const probeCache = new Map();
async function probe(url) {
  if (!probeCache.has(url)) probeCache.set(url, await head(url));
  return probeCache.get(url);
}

let processed = 0;
const work = [];
for (const s of skus) {
  if (!OWN_CODE_RE.test(s.code)) { counters.badCode++; continue; }
  const rows = mediaBySku.get(s.sku_id) || [];
  const hasOwn = rows.some(r => codesIn(r.original_url || r.url).includes(s.code));
  if (hasOwn) { counters.ownAlready++; continue; }
  work.push(s);
}
console.log(`SKUs needing work: ${work.length} (own image already: ${counters.ownAlready}, non-code vendor_sku: ${counters.badCode})`);

async function planSku(s) {
  const rows = mediaBySku.get(s.sku_id) || [];
  // 1) pool
  const pooled = poolByCode.get(s.code);
  let newPrimary = null, via = null;
  const extraAlts = [];
  if (pooled) {
    const shots = [...pooled].filter(([, cls]) => cls === 'shot').map(([u]) => u);
    const alts = [...pooled].filter(([, cls]) => cls === 'alt').map(([u]) => u);
    if (shots.length) { newPrimary = shots[0]; extraAlts.push(...shots.slice(1), ...alts); via = 'pool'; }
  }
  // 2) hr probe
  if (!newPrimary) {
    const hrUrl = `${CDN}/${s.code.slice(0, 2)}/${s.code.slice(2, 4)}/${s.code.slice(4, 6)}/${s.code}_hr_large.jpg`;
    if (await probe(hrUrl)) { newPrimary = hrUrl; via = 'hr'; }
  }
  // 3) sibling template swap (same series+color stem only, channel-prefix agnostic)
  if (!newPrimary) {
    const tpls = templatesByStem.get(stem(s.code)) || [];
    for (const t of tpls.slice(0, 4)) {
      if (t.code === s.code) continue;
      const cand = t.url.replaceAll(t.code, s.code);
      if (cand !== t.url && await probe(encodeURI(decodeURIComponent(cand)))) { newPrimary = cand; via = 'template'; break; }
    }
  }

  if (newPrimary) {
    counters[via === 'pool' ? 'pooled' : via === 'hr' ? 'hrProbe' : 'template']++;
    // remove existing sku-level shots with FOREIGN codes (keep lifestyle + uncoded)
    const removeIds = rows.filter(r => {
      if (r.asset_type !== 'primary' && r.asset_type !== 'alternate') return false;
      const cs = codesIn(r.original_url || r.url);
      return cs.length > 0 && !cs.includes(s.code);
    }).map(r => r.id);
    plans.push({ sku: s, newPrimary, extraAlts: extraAlts.slice(0, 3), removeIds, via });
    return;
  }

  // No exact image anywhere. Borrowed SAME-pattern (size-only) images may stay;
  // wrong-PATTERN images (oval on a basketweave SKU) are worse than no image —
  // remove them so the PDP falls back to the product hero / placeholder.
  const wrongPattern = rows.filter(r => {
    const cs = codesIn(r.original_url || r.url);
    return cs.length > 0 && !cs.includes(s.code) && cs.every(c => patternMismatch(s.code, c));
  }).map(r => r.id);
  if (wrongPattern.length) {
    counters.wrongPatternRemoved++;
    plans.push({ sku: s, newPrimary: null, extraAlts: [], removeIds: wrongPattern, via: 'remove-only' });
  } else {
    counters.noMatch++;
  }
}

const queue = [...work.slice(0, LIMIT === Infinity ? work.length : LIMIT)];
async function worker() {
  for (;;) {
    const s = queue.shift();
    if (!s) return;
    await planSku(s);
    if (++processed % 500 === 0) console.log(`  planned ${processed}, found ${plans.length} (${JSON.stringify(counters)})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log('\nCounters:', counters);
console.log(`Plans: ${plans.length} SKUs get exact-code images; removals: ${plans.reduce((a, p) => a + p.removeIds.length, 0)} foreign-code rows`);
const byVia = {};
for (const p of plans) byVia[p.via] = (byVia[p.via] || 0) + 1;
console.log('by source:', byVia);
for (const p of plans.slice(0, 12)) console.log(`  ${p.sku.vendor_sku} | ${p.sku.pname} | ${p.sku.variant_name} | ${p.via} | ${decodeURIComponent(p.newPrimary).slice(-80)}`);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(DATA_DIR, `emser-sku-images-plan-${ts}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ counters, plans: plans.map(p => ({
  sku_id: p.sku.sku_id, vendor_sku: p.sku.vendor_sku, product: p.sku.pname, variant: p.sku.variant_name,
  via: p.via, newPrimary: p.newPrimary, extraAlts: p.extraAlts, removeIds: p.removeIds,
})) }, null, 1));
console.log(`Plan: ${reportPath}`);

// ── Apply ────────────────────────────────────────────────────────────────────

if (APPLY && plans.length) {
  const backupRows = [];
  for (const p of plans) {
    for (const id of p.removeIds) {
      const r = media.find(m => m.id === id);
      if (r) backupRows.push(r);
    }
  }
  const bpath = path.join(DATA_DIR, `emser-sku-images-backup-${ts}.json`);
  fs.writeFileSync(bpath, JSON.stringify(backupRows, null, 1));
  console.log(`Backup of removed rows: ${bpath}`);

  let removed = 0, inserted = 0, failed = 0;
  for (const p of plans) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (p.removeIds.length) {
        const r = await client.query(`DELETE FROM media_assets WHERE id = ANY($1)`, [p.removeIds]);
        removed += r.rowCount;
      }
      if (p.newPrimary) {
        // shift any surviving (uncoded) sku-level primary aside so sort 0 is free
        await client.query(`
          UPDATE media_assets SET asset_type='alternate',
            sort_order=(SELECT coalesce(max(sort_order),0)+1 FROM media_assets
                        WHERE sku_id=$1 AND asset_type='alternate')
          WHERE sku_id=$1 AND asset_type='primary'`, [p.sku.sku_id]);
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1,$2,'primary',$3,$3,0,'fix-emser-sku-images')
          ON CONFLICT DO NOTHING`, [p.sku.product_id, p.sku.sku_id, p.newPrimary]);
        let alt = 100; // high sort avoids unique (product,sku,type,sort) collisions with existing alternates
        for (const u of p.extraAlts) {
          await client.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1,$2,'alternate',$3,$3,$4,'fix-emser-sku-images')
            ON CONFLICT DO NOTHING`, [p.sku.product_id, p.sku.sku_id, u, alt++]);
        }
      }
      await client.query('COMMIT');
      inserted++;
    } catch (e) {
      await client.query('ROLLBACK');
      failed++;
      if (failed <= 10) console.error(`  FAIL ${p.sku.vendor_sku}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  console.log(`Applied: ${inserted} SKUs updated, ${removed} foreign-code rows removed, ${failed} failed.`);
}

await pool.end();
