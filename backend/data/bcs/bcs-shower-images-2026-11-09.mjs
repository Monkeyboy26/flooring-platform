// Attach images for BCS shower panel products from the single category page
// https://bestcheerstone.com/bathroom/shower-wall-panels/ (the price list PDF
// links every panel there — no per-product pages). Page structure: each tile
// is an <img> immediately FOLLOWED by an <h#> title like
// "ALASKA MARBLE COMPOSITE" / "BIANCO SWAN SPC" / "GREY SUBWAY TILE SMC".
// Match: strip the trailing MARBLE COMPOSITE/SPC/SMC qualifier, title-case,
// map to our "{Color} Shower Panel" products (SMC-prefixed for SMC tiles).
// "Image-Unavailable" placeholders are skipped. Idempotent: products that
// already have assets are skipped.
//
//   docker exec -e DB_HOST=db flooring-api node data/bcs/bcs-shower-images-2026-11-09.mjs [--apply]
import pg from 'pg';
import { upsertMediaAsset } from '../../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const APPLY = process.argv.includes('--apply');
const PAGE = 'https://bestcheerstone.com/bathroom/shower-wall-panels/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function titleCase(s) {
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

async function main() {
  const res = await fetch(PAGE, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${PAGE}`);
  const html = await res.text();

  // (position, kind, value) stream: panel tile = IMG then its heading.
  const events = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gs)) {
    const txt = m[2].replace(/<[^>]+>/g, '').trim();
    if (txt) events.push([m.index, 'H', txt]);
  }
  for (const m of html.matchAll(/<img[^>]+src="(https:\/\/bestcheerstone\.com\/wp-content\/uploads\/[^"?]+?)(?:-\d+x\d+)?\.(jpg|jpeg|png|webp)"/g)) {
    events.push([m.index, 'IMG', `${m[1]}.${m[2]}`]);
  }
  events.sort((a, b) => a[0] - b[0]);

  // img -> next heading = that panel's title
  const byColor = new Map(); // "Alaska" -> image url
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i][1] !== 'IMG' || events[i + 1][1] !== 'H') continue;
    const img = events[i][2];
    const h = events[i + 1][2].toUpperCase();
    const m = h.match(/^(.+?)\s+(MARBLE COMPOSITE|SPC|SMC)$/);
    if (!m) continue;
    if (/image-unavailable|logo|placeholder/i.test(img)) continue;
    let color = titleCase(m[1].trim());
    if (m[2] === 'SMC') color = `SMC ${color}`; // our naming: SMC Grey Subway Tile
    if (!byColor.has(color)) byColor.set(color, img);
  }
  console.log(`Panel tiles with real images on page: ${byColor.size}`);

  const { rows: prods } = await pool.query(`
    SELECT p.id, p.name,
           (SELECT count(*) FROM media_assets m WHERE m.product_id = p.id) AS assets
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    JOIN categories c ON c.id = p.category_id
    WHERE v.code='BCS' AND c.slug='shower-panels' ORDER BY p.name`);

  let hit = 0, already = 0;
  const miss = [];
  for (const p of prods) {
    if (Number(p.assets) > 0) { already++; continue; }
    const color = p.name.replace(/ Shower Panel$/, '');
    const img = byColor.get(color);
    if (!img) { miss.push(p.name); continue; }
    hit++;
    console.log(`${p.name}: ${img}`);
    if (APPLY) {
      await upsertMediaAsset(pool, {
        product_id: p.id, sku_id: null, asset_type: 'primary',
        url: img, original_url: img, sort_order: 0,
      });
    }
  }
  console.log(`\nMatched: ${hit}/${prods.length} (${already} already had assets)`);
  if (miss.length) console.log(`No image on vendor page (${miss.length}): ${miss.join(', ')}`);
  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to attach.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
