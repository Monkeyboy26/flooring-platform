// Attach product images for BCS countertop products from bestcheerstone.com
// product pages (URLs extracted from the 9/2/2026 price list PDF hyperlinks,
// bcs-urls.json). WooCommerce pages: gallery full-res lives in
// data-large_image attrs; featured fallback is .wp-post-image data-src.
// Product-level assets (sku_id NULL): first image primary, rest alternate.
// External URLs go in url+original_url (mirror cron localizes later).
// Shower panels are skipped — the PDF links them all to one category page.
//
//   docker exec -e DB_HOST=db flooring-api node data/bcs/bcs-fetch-images-2026-11-09.mjs [--apply]
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertMediaAsset } from '../../scrapers/base.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const APPLY = process.argv.includes('--apply');
const urlsBySection = JSON.parse(fs.readFileSync(path.join(__dirname, 'bcs-urls.json'), 'utf8'));

const NAME_FIX = {
  'CALA. TAJ': 'Calacatta Taj',
  'ELEGANT BRWON': 'Elegant Brown',
  'EVEREST CREEK GOL': 'Everest Creek Gold',
  'EVEREST CREEK GOL D': 'Everest Creek Gold',
  'NEW COLONIAL CREA': 'New Colonial Cream',
  'NEW COLONIAL CREA M': 'New Colonial Cream',
};
function titleCase(name) {
  return name.split(/\s+/).map(w =>
    w === 'SMC' ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function fixName(n) {
  let x = NAME_FIX[n] || n;
  x = x.replace(/-Premium$/i, ' PREMIUM');
  return titleCase(x);
}

// name -> url across the four countertop sections (per-product links only)
const urlByName = new Map();
for (const sec of ['quartz_prefab', 'quartz_slab', 'stone_prefab', 'stone_slab']) {
  for (const [rawName, url] of Object.entries(urlsBySection[sec] || {})) {
    if (!/\/product\//.test(url)) continue;
    const name = fixName(rawName.trim());
    if (!urlByName.has(name)) urlByName.set(name, url);
  }
}

// Selection grades with no page of their own — use the base stone's page
// (same material, representative photo; Kian can replace per-lot shots later).
const GRADE_FALLBACK = {
  'Cristallo Premium': 'Cristallo',
  'Naica Premium': 'Naica',
  'Taj Mahal Premium': 'Taj Mahal',
  'Namib Fantasy Classic': 'Namib Fantasy',
  'Namib Fantasy Crystal': 'Namib Fantasy',
  'Namib Fantasy Select': 'Namib Fantasy',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const JUNK = /logo|banner|image-unavailable|placeholder/i;

function extractImages(html) {
  const out = [];
  for (const m of html.matchAll(/data-large_image="([^"]+)"/g)) out.push(m[1]);
  if (!out.length) {
    const feat = html.match(/wp-post-image[^>]*data-src="([^"]+)"/) || html.match(/data-src="([^"]+)"[^>]*wp-post-image/);
    if (feat) out.push(feat[1]);
  }
  return [...new Set(out)].filter(u => !JUNK.test(u));
}

async function main() {
  const { rows: prods } = await pool.query(`
    SELECT p.id, p.name, c.slug AS cat,
           (SELECT count(*) FROM media_assets m WHERE m.product_id = p.id) AS assets
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'BCS' AND c.slug <> 'shower-panels'
    ORDER BY p.name`);

  let hit = 0, miss = [], already = 0, attached = 0, fetchFail = [];
  for (const p of prods) {
    if (Number(p.assets) > 0) { already++; continue; }
    const url = (GRADE_FALLBACK[p.name] && urlByName.get(GRADE_FALLBACK[p.name])) ||
      urlByName.get(p.name) ||
      `https://bestcheerstone.com/product/${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    let html;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) { fetchFail.push(`${p.name}: HTTP ${res.status} ${url}`); continue; }
      html = await res.text();
    } catch (e) {
      fetchFail.push(`${p.name}: ${e.message}`);
      continue;
    }
    const imgs = extractImages(html);
    if (!imgs.length) { miss.push(`${p.name}: no gallery images at ${url}`); continue; }
    hit++;
    console.log(`${p.name}: ${imgs.length} image(s) — ${imgs[0]}`);
    if (APPLY) {
      for (let i = 0; i < imgs.length; i++) {
        await upsertMediaAsset(pool, {
          product_id: p.id, sku_id: null,
          asset_type: i === 0 ? 'primary' : 'alternate',
          url: imgs[i], original_url: imgs[i], sort_order: i,
        });
        attached++;
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\nProducts with images found: ${hit}/${prods.length} (${already} already had assets)`);
  if (APPLY) console.log(`Assets attached: ${attached}`);
  if (miss.length) { console.log(`\nNo images (${miss.length}):`); miss.forEach(m => console.log('  ' + m)); }
  if (fetchFail.length) { console.log(`\nFetch failures (${fetchFail.length}):`); fetchFail.forEach(m => console.log('  ' + m)); }
  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to attach.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
