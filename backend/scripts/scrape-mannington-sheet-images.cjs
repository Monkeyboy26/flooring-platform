#!/usr/bin/env node
/**
 * Mannington SHEET VINYL image scraper (DAM → local /uploads).
 *
 * Companion to scrape-mannington-dam.cjs for the sheet-vinyl SKUs onboarded
 * from the 11/06/2026 Rolls-Detail list (data/mannington-onboard-sheet-*.mjs).
 * Differences from the main DAM scraper, which cannot serve these SKUs:
 *   - Sheet DAM filenames key on STYLE+COLOR code (spr383-rs-verona-crema.tif)
 *     or legacy catalog #s — not our vendor_sku (current catalog #). Matching
 *     goes through data/mannington/mannington-pricelist-2026-11-06.json rolls[].
 *   - downloadOriginal is now session-gated (302 → login) and many files are
 *     TIFs, so we download WITH the session, convert via sharp to webp, store
 *     under /uploads/mannington-sheet/, and set mirrored_at so the mirror
 *     pipeline never re-fetches the gated original_url.
 *   - An image matches a COLOR → attached to every width SKU of that color.
 *
 * DAM folders crawled: Sheet Vinyl (1319: LVS 8070 + Resilient 8071),
 * Mannington on Main (20287: Towne Centre / Insights Plus / Glass Back / Hex /
 * Twill), Prime (23839).
 *
 * Usage (local first; prod bind mount is read-only → scp uploads, then run
 * with --no-download to only write DB rows):
 *   docker exec -e DB_HOST=db flooring-api node scripts/scrape-mannington-sheet-images.cjs [--dry-run] [--no-download] [--max=N]
 */
const { Pool } = require('pg');
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
const DRY_RUN = args.includes('--dry-run');
const NO_DOWNLOAD = args.includes('--no-download');
const MAX = (() => { const a = args.find(x => x.startsWith('--max=')); return a ? parseInt(a.slice(6), 10) : Infinity; })();

const DAM = 'https://manningtonprod.pimcoreclient.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd';
const ROLLS_JSON = path.join(__dirname, '..', 'data', 'mannington', 'mannington-pricelist-2026-11-06.json');
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'mannington-sheet');
const URL_PREFIX = '/uploads/mannington-sheet';
// folder pid → style codes whose bare numeric color codes may appear in filenames there
const ROOTS = [
  { pid: 1319, name: 'Sheet Vinyl', styles: ['LVS1', 'LVS2', 'LVS3', 'BM', 'JS', 'SPR'] },
  { pid: 20287, name: 'Mannington on Main', styles: ['TC', 'IP', 'IPGB'] },
  { pid: 23839, name: 'Prime', styles: ['SPR'] },
];
const SKIP_FOLDER_RE = /^(Displays?|Documents?|Icons?|Logos?|Discontinued|Social|Videos?|Shows|Reset Rubber)/i;
const TYPE_KEYWORDS = new Set(['rs', 'rsh', 'rsv', 'full', 'fullprop', 'angle', 'prop', 'swatch', 'lifestyle', 'editorial', 'social']);

let cookie = null;
async function auth() {
  const r = await fetch(`${DAM}/dam/login/login`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'mannington-public=Mannington+Public+Access', redirect: 'manual',
  });
  const c = (r.headers.getSetCookie?.() || []).find(x => x.startsWith('PHPSESSID='));
  if (!c) throw new Error('DAM auth failed');
  cookie = c.split(';')[0];
}
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
    if (r.url && r.url.includes('/login')) { await auth(); continue; }
    if (r.ok) return r;
    await new Promise(res => setTimeout(res, 1000 * (i + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

function parseList(html) {
  // links carry extra params (&page=1&o=0, &view=...) — don't anchor on the quote
  const folders = [];
  for (const m of html.matchAll(/<a href="\/dam\/asset\/list\?pid=(\d+)[^"]*">([\s\S]{0,600}?)<\/a>/g)) {
    const name = ((m[2].match(/alt="([^"]+)"/) || [, m[2].replace(/<[^>]+>/g, ' ').trim()])[1] || '').trim();
    if (name) folders.push({ pid: parseInt(m[1], 10), name });
  }
  const assets = [];
  for (const m of html.matchAll(/<a href="\/dam\/asset\/detail\?pid=\d+&(?:amp;)?id=(\d+)[^"]*">[\s\S]{0,400}?alt="([^"]+)"/g)) {
    assets.push({ id: parseInt(m[1], 10), filename: m[2] });
  }
  let maxPage = 1;
  for (const m of html.matchAll(/[?&](?:amp;)?page=(\d+)/g)) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  return { folders, assets, maxPage };
}

async function crawl(pid, name, styles, seen, out) {
  if (seen.has(pid)) return;
  seen.add(pid);
  if (SKIP_FOLDER_RE.test(name)) return;
  let page = 1, maxPage = 1;
  do {
    const r = await get(`${DAM}/dam/asset/list?pid=${pid}&page=${page}`);
    const { folders, assets, maxPage: mp } = parseList(await r.text());
    maxPage = mp;
    for (const a of assets) out.push({ ...a, folder: name, styles });
    if (page === 1) {
      for (const f of folders) {
        if (f.pid !== pid && !seen.has(f.pid)) await crawl(f.pid, f.name, styles, seen, out);
      }
    }
    page++;
  } while (page <= maxPage);
}

function classify(stem) {
  const tokens = stem.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[-_]+/);
  let type = tokens.find(t => TYPE_KEYWORDS.has(t)) || 'rs';
  return { tokens, type };
}
function assetTypeFor(type) {
  if (type === 'full' || type === 'fullprop') return 'primary';
  if (type === 'swatch') return 'swatch';
  if (type === 'angle' || type === 'prop') return 'alternate';
  if (type === 'social') return null;
  return 'lifestyle'; // rs/rsh/rsv/lifestyle/editorial/default
}

async function main() {
  const { rolls } = JSON.parse(fs.readFileSync(ROLLS_JSON, 'utf8'));
  // color-code formats vary per line: BM/TC/IP bare 4-digit, IPGB '6637GB',
  // SPR already prefixed ('SPR083'), JS 5-digit, LVS1/2/3 6-digit (130540…)
  const byStyleColor = new Map(); // normalized 'spr083'/'bm3842'/'ipgb6637' -> rows[]
  const byColorCode = new Map(); // bare numeric core -> rows[] (null if ambiguous across styles)
  const byCatalog = new Map();
  const slug = s => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const byNames = []; // {patToks, colToks, rows} for code-less files (Full-Hexx-Charm.jpg)
  const nameIndex = new Map(); // `${pattern}|${color}` dedupe
  for (const r of rolls) {
    const core = r.color_code.replace(/GB$/i, '');
    const k = r.color_code.toUpperCase().startsWith(r.style_code.toUpperCase())
      ? r.color_code.toLowerCase()
      : (r.style_code + core).toLowerCase();
    (byStyleColor.get(k) ?? byStyleColor.set(k, []).get(k)).push(r);
    if (/^\d+$/.test(core)) {
      const cur = byColorCode.get(core);
      if (cur === undefined) byColorCode.set(core, [r]);
      else if (cur && cur[0].style_code === r.style_code) cur.push(r);
      else byColorCode.set(core, null); // same bare code in two styles → ambiguous
    }
    byCatalog.set(r.catalog, r);
    const nk = `${slug(r.pattern)}|${slug(r.color)}`;
    if (!nameIndex.has(nk)) {
      nameIndex.set(nk, []);
      byNames.push({ patToks: slug(r.pattern).split(' '), colToks: slug(r.color).split(' '), rows: nameIndex.get(nk) });
    }
    nameIndex.get(nk).push(r);
  }
  const { rows: skus } = await pool.query(
    `SELECT s.id, s.vendor_sku, s.product_id FROM skus s JOIN products p ON p.id=s.product_id
      WHERE p.vendor_id=$1 AND s.sell_by='roll' AND s.status='active'`, [VENDOR_ID]);
  const skuByCatalog = new Map(skus.map(s => [s.vendor_sku, s]));
  console.log(`Sheet SKUs: ${skus.length}; style+color keys: ${byStyleColor.size}`);

  await auth();
  const assets = [], seen = new Set([60]); // 60 = global root breadcrumb — never climb out
  for (const root of ROOTS) await crawl(root.pid, root.name, root.styles, seen, assets);
  console.log(`DAM assets discovered: ${assets.length} (folders crawled: ${seen.size})`);

  // ---- public web sources (no session) ----
  // mannington.com index pages embed every color's typed image set as
  // TransformedImages/{stem}.jpeg (public CDN render of the DAM TIFs); the
  // Mannington-on-Main product-line pages (Towne Centre / Insight Plus /
  // Glass Back — none of which exist in the DAM) inline wp-content swatches
  // named {Pattern}_{Color}_{code}.jpg or {Pattern}-{Color}-Swatch.png.
  const WEB_PAGES = [
    { url: 'https://www.mannington.com/residential/products/resilient', styles: ['BM', 'JS'] },
    { url: 'https://www.mannington.com/residential/products/luxury-vinyl-sheet/platinum', styles: ['LVS1', 'LVS2', 'LVS3'] },
    { url: 'https://www.mannington.com/residential/products/luxury-vinyl-sheet/gold', styles: ['LVS1', 'LVS2', 'LVS3'] },
    { url: 'https://www.mannington.com/residential/products/luxury-vinyl-sheet/silver', styles: ['LVS1', 'LVS2', 'LVS3'] },
    { url: 'https://manningtononmain.com/product-line/towne-centre/', styles: ['TC'] },
    { url: 'https://manningtononmain.com/product-line/insight-plus/', styles: ['IP'] },
    { url: 'https://manningtononmain.com/product-line/insight-plus-glass-back/', styles: ['IPGB'] },
  ];
  const webSeen = new Set();
  for (const pg of WEB_PAGES) {
    let html = '';
    try {
      const r = await fetch(pg.url, { headers: { 'User-Agent': UA } });
      if (!r.ok) { console.warn(`  ! web source ${pg.url}: ${r.status}`); continue; }
      html = await r.text();
    } catch (e) { console.warn(`  ! web source ${pg.url}: ${e.message}`); continue; }
    const urls = new Set();
    for (const m of html.matchAll(/https?:\/\/manningtonprod\.pimcoreclient\.com\/TransformedImages\/([^"'¨\s]+?\.jpeg)/g)) {
      urls.add(['https://manningtonprod.pimcoreclient.com/TransformedImages/' + m[1], m[1]]);
    }
    for (const m of html.matchAll(/https?:\/\/manningtononmain\.com\/wp-content\/uploads\/[^"'\s]+?\.(?:jpe?g|png|webp)/g)) {
      const u = m[0];
      if (/-\d+x\d+\.(jpe?g|png|webp)$/.test(u)) continue; // skip wp thumbnails
      urls.add([u, u.split('/').pop()]);
    }
    let added = 0;
    for (const [u, fname] of urls) {
      const key = fname.toLowerCase();
      if (webSeen.has(key)) continue;
      webSeen.add(key);
      assets.push({ id: null, url: u, filename: fname, folder: pg.url, styles: pg.styles });
      added++;
    }
    console.log(`  web source ${pg.url}: +${added} images`);
  }
  console.log(`Total assets incl. web: ${assets.length}`);

  // match assets → color rows
  const matches = []; // {asset, rows, type}
  let unmatched = 0;
  const unmatchedSamples = [];
  for (const a of assets) {
    if (/\.(eps|ai|pdf|svg)$/i.test(a.filename)) continue; // sharp can't rasterize these
    const { tokens, type } = classify(a.filename);
    if (type === 'social') continue;
    let rows = null;
    for (const t of tokens) {
      let m = t.match(/^([a-z]{2,4})(\d{3,6})(gb)?$/); // spr383 / ip6637gb / lvs…
      if (m) {
        const key = ((m[3] ? 'ipgb' : m[1]) + m[2]).toLowerCase();
        if (byStyleColor.has(key)) { rows = byStyleColor.get(key); break; }
      }
      m = t.match(/^(\d{3,6})(gb)?$/); // bare code: 3842 / 130540 / 6637gb
      if (m) {
        if (m[2] && byStyleColor.has('ipgb' + m[1])) { rows = byStyleColor.get('ipgb' + m[1]); break; }
        if (!m[2] && byColorCode.get(m[1])) { rows = byColorCode.get(m[1]); break; }
        if (byCatalog.has(t)) {
          const row = byCatalog.get(t);
          rows = byStyleColor.get((row.style_code + row.color_code.replace(/GB$/i, '')).toLowerCase());
          break;
        }
        for (const st of (m[2] ? ['IPGB'] : a.styles)) { // folder style context
          const key = (st + m[1]).toLowerCase();
          if (byStyleColor.has(key)) { rows = byStyleColor.get(key); break; }
        }
        if (rows) break;
      }
    }
    if (!rows) { // name-keyed files (Full-Hexx-Charm.jpg, RS-Twill-Wool_render.jpg)
      const stem = a.filename.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/\(\d+\)/g, '');
      const words = new Set(stem.split(/[-_\s.]+/).filter(Boolean));
      let best = null;
      for (const n of byNames) {
        if (n.patToks.every(w => words.has(w)) && n.colToks.every(w => words.has(w))) {
          const score = n.patToks.length + n.colToks.length;
          if (!best || score > best.score) best = { rows: n.rows, score };
        }
      }
      if (best) rows = best.rows;
    }
    if (rows) matches.push({ asset: a, rows, type });
    else { unmatched++; if (unmatchedSamples.length < 15) unmatchedSamples.push(`${a.folder}/${a.filename}`); }
  }
  console.log(`Matched: ${matches.length}, unmatched: ${unmatched}`);
  if (unmatched) console.log('  unmatched samples:', unmatchedSamples.slice(0, 10).join(' | '));

  // Tier families share the DESIGN: LVS1/2/3 are Platinum/Gold/Silver wear
  // tiers of the same visual (Mannington's own files list all three codes:
  // 130261-100261-080261-rs-capri-marble), and IPGB is the glass-back build
  // of the same Insight Plus patterns. An image matched to any tier attaches
  // to every tier's SKUs of that pattern+color. Unrelated series (Benchmark
  // vs Prime reusing a pattern name) do NOT share.
  const shareGroup = st => /^LVS/.test(st) ? 'LVS' : (st === 'IPGB' ? 'IP' : st);
  const designKey = r => `${shareGroup(r.style_code)}|${slug(r.pattern)}|${slug(r.color)}`;
  const byDesign = new Map(); // designKey -> all rolls rows of that design
  for (const r of rolls) {
    const k = designKey(r);
    (byDesign.get(k) ?? byDesign.set(k, []).get(k)).push(r);
  }

  // group per design, pick assets (cap per type to keep PDPs sane)
  const byColor = new Map();
  for (const m of matches) {
    const family = byDesign.get(designKey(m.rows[0])) || m.rows;
    (byColor.get(designKey(m.rows[0])) ?? byColor.set(designKey(m.rows[0]), []).get(designKey(m.rows[0])))
      .push({ ...m, rows: family });
  }

  // Last-resort cross-series inherit: Mannington reuses designs across brands
  // (Prime = "Sobella Prime" dealer label of the LVS/Resilient designs —
  // retailers sell "Prime Deco Wrought Iron" with the same photography). A
  // design with NO images of its own borrows the matched set of a same
  // pattern+color design from any other series.
  const matchedByName = new Map();
  for (const [k, ms] of byColor) {
    const nk = `${slug(ms[0].rows[0].pattern)}|${slug(ms[0].rows[0].color)}`;
    if (!matchedByName.has(nk)) matchedByName.set(nk, ms);
  }
  let inherited = 0;
  for (const [dk, rows] of byDesign) {
    if (byColor.has(dk)) continue;
    const nk = `${slug(rows[0].pattern)}|${slug(rows[0].color)}`;
    const donor = matchedByName.get(nk);
    if (donor) {
      byColor.set(dk, donor.map(m => ({ ...m, rows })));
      inherited++;
    }
  }
  if (inherited) console.log(`Cross-series inherit: ${inherited} designs borrow same pattern+color images`);
  console.log(`Colors with images: ${byColor.size} of ${byStyleColor.size}`);
  if (DRY_RUN) {
    for (const [k, ms] of [...byColor].slice(0, 12)) {
      console.log(`  ${k}: ${ms.map(m => `${m.type}(${m.asset.filename.slice(0, 40)})`).join(', ')}`);
    }
    await pool.end();
    return;
  }

  let sharp = null;
  if (!NO_DOWNLOAD) {
    sharp = require('sharp');
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let processed = 0, inserted = 0, filesWritten = 0, promoted = 0, skippedExisting = 0;
  for (const [key, ms] of byColor) {
    if (processed >= MAX) break;
    processed++;
    // order: full first, then swatch, then rs; cap: 1 full, 1 swatch, 3 rs
    const caps = { primary: 1, swatch: 1, lifestyle: 3, alternate: 2 };
    const chosen = [];
    for (const m of ms.sort((a, b) => (a.type === 'full' ? -1 : 1) - (b.type === 'full' ? -1 : 1))) {
      const at = assetTypeFor(m.type);
      if (!at) continue;
      if (chosen.filter(c => c.at === at).length >= caps[at]) continue;
      chosen.push({ ...m, at });
    }
    // canonical file key: lowest style+color key in the design family, but
    // prefer a tier key whose file already exists from an earlier run
    const famKeys = [...new Set(ms[0].rows.map(r =>
      (r.color_code.toUpperCase().startsWith(r.style_code.toUpperCase())
        ? r.color_code : r.style_code + r.color_code.replace(/GB$/i, '')).toLowerCase()))].sort();
    const sortCounters = {};
    for (const c of chosen) {
      const n = (sortCounters[c.at] = (sortCounters[c.at] ?? -1) + 1);
      const suffix = `-${c.at}${n ? `-${n}` : ''}.webp`;
      const existingKey = famKeys.find(k => fs.existsSync(path.join(OUT_DIR, `${k}${suffix}`)));
      const fname = `${existingKey || famKeys[0]}${suffix}`;
      const localPath = path.join(OUT_DIR, fname);
      const url = `${URL_PREFIX}/${fname}`;
      const originalUrl = c.asset.url || `${DAM}/dam/asset/downloadOriginal?id=${c.asset.id}`;
      if (!NO_DOWNLOAD && !fs.existsSync(localPath)) {
        try {
          const resp = await get(originalUrl);
          const buf = Buffer.from(await resp.arrayBuffer());
          await sharp(buf).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 }).toFile(localPath);
          filesWritten++;
        } catch (e) {
          console.warn(`  ! download/convert failed ${c.asset.filename}: ${e.message}`);
          continue;
        }
      } else if (NO_DOWNLOAD && !fs.existsSync(localPath)) {
        skippedExisting++;
        continue; // file wasn't shipped — skip DB row rather than insert a 404
      }
      for (const row of c.rows) {
        const sku = skuByCatalog.get(row.catalog);
        if (!sku) continue;
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source, mirrored_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'scraper', now())
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, mirrored_at = now()`,
          [sku.product_id, sku.id, c.at, url, originalUrl, n]);
        inserted++;
      }
    }
  }

  // promote: any sheet SKU with no primary gets its swatch (color-true surface
  // shot) promoted; lifestyle stays lifestyle.
  const { rows: prom } = await pool.query(`
    UPDATE media_assets ma SET asset_type='primary', sort_order=0
     WHERE ma.id IN (
       SELECT DISTINCT ON (ma2.sku_id) ma2.id
         FROM media_assets ma2
         JOIN skus s ON s.id = ma2.sku_id AND s.sell_by='roll' AND s.status='active'
         JOIN products p ON p.id = s.product_id AND p.vendor_id = $1
        WHERE ma2.asset_type = 'swatch'
          AND NOT EXISTS (SELECT 1 FROM media_assets mp WHERE mp.sku_id = ma2.sku_id AND mp.asset_type = 'primary')
        ORDER BY ma2.sku_id, ma2.sort_order)
     RETURNING ma.id`, [VENDOR_ID]);
  promoted = prom.length;
  // room-scene-only SKUs: a lifestyle card beats an empty one
  const { rows: prom2 } = await pool.query(`
    UPDATE media_assets ma SET asset_type='primary', sort_order=0
     WHERE ma.id IN (
       SELECT DISTINCT ON (ma2.sku_id) ma2.id
         FROM media_assets ma2
         JOIN skus s ON s.id = ma2.sku_id AND s.sell_by='roll' AND s.status='active'
         JOIN products p ON p.id = s.product_id AND p.vendor_id = $1
        WHERE ma2.asset_type = 'lifestyle'
          AND NOT EXISTS (SELECT 1 FROM media_assets mp WHERE mp.sku_id = ma2.sku_id AND mp.asset_type = 'primary')
        ORDER BY ma2.sku_id, ma2.sort_order)
     RETURNING ma.id`, [VENDOR_ID]);
  promoted += prom2.length;

  const { rows: [stat] } = await pool.query(`
    SELECT count(DISTINCT s.id) FILTER (WHERE ma.sku_id IS NOT NULL) AS imaged,
           count(DISTINCT s.id) AS total
      FROM skus s JOIN products p ON p.id=s.product_id AND p.vendor_id=$1
      LEFT JOIN media_assets ma ON ma.sku_id = s.id
     WHERE s.sell_by='roll' AND s.status='active'`, [VENDOR_ID]);
  console.log(`Files written: ${filesWritten}, media rows upserted: ${inserted}, swatch→primary promoted: ${promoted}${NO_DOWNLOAD ? `, skipped-missing-files: ${skippedExisting}` : ''}`);
  console.log(`Sheet SKUs with images: ${stat.imaged}/${stat.total}`);
  await pool.end();
}

main().catch(async e => { console.error('FATAL:', e); try { await pool.end(); } catch {} process.exit(1); });
