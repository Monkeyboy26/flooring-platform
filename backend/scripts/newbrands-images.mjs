/**
 * Image pass for the Big D tier-1 gap-fill brands (2026-07-27).
 * Pulls product photos from MANUFACTURER sites (all verified fetchable
 * server-side — the store CDNs' parent sites were rate-limiting the browser):
 *   Taylor → tayloradhesives.com product pages (og:image)
 *   UZIN   → us.uzin.com product-guide category crawl (og:image)
 *   Boards/QUIKRETE/sound → known page URL attempts, og:image, skip on failure
 * Applies as product-level primary where the product has no image.
 *
 * Run: docker exec flooring-api node scripts/newbrands-images.mjs [--dry]
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const dry = process.argv.includes('--dry');
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } };

async function html(url) {
  try {
    const r = await fetch(url, { ...UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}
function ogImage(t, base) {
  if (!t) return null;
  const m = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(t)
    || /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/.exec(t);
  let u = m?.[1] || null;
  if (u && u.startsWith('/')) u = base + u;
  // skip obvious logos/placeholders
  if (u && /logo|placeholder|social|og-default/i.test(u)) return null;
  return u;
}

const found = new Map(); // productNamePattern(regex) → imageUrl

// ── Taylor ───────────────────────────────────────────────────────────────────
const TAYLOR = {
  'Taylor Dynamic': 'dynamic', 'Taylor Pinnacle': 'pinnacle', 'Taylor Resolute': 'resolute-rt',
  'Taylor Timberline': 'timberline', 'Taylor Alpine': 'alpine', 'Taylor Finale': 'finale',
  'Taylor 900': '900', 'Taylor Agile': 'agile',
};
for (const [pat, slug] of Object.entries(TAYLOR)) {
  const t = await html(`https://www.tayloradhesives.com/en/home/products/${slug}.html`);
  if (!t) continue;
  // the product packshot is the page-local jcr_content image (logos live under /content/dam/.../logo)
  const m = new RegExp(`(?:src|data-src)="(/content/taylor-adhesives/[^"]*/products/${slug}/_jcr_content[^"]*\\.(?:png|jpg|jpeg)[^"]*)"`, 'i').exec(t);
  if (m) found.set(pat, 'https://www.tayloradhesives.com' + m[1]);
}

// ── UZIN ─────────────────────────────────────────────────────────────────────
const UZIN_CATS = [
  'primers-moisture-vapor-retarders/primers', 'primers-moisture-vapor-retarders/moisture-vapor-retarders',
  'leveling-compounds/leveling-compounds-/-cementitious', 'leveling-compounds/patch-/-repair-/-smoothing-compounds',
  'adhesives/floor-covering-adhesives', 'tile-stone-installation-systems/waterproofing-membranes',
  'tile-stone-installation-systems/thinset-mortars', 'tile-stone-installation-systems/grout-sealant-caulk',
];
const uzinLinks = new Set();
for (const cat of UZIN_CATS) {
  const t = await html('https://us.uzin.com/products/product-guide/' + encodeURI(cat));
  if (!t) continue;
  for (const m of t.matchAll(/href="(https:\/\/us\.uzin\.com\/detail\/product\/\d+\/[a-z0-9-]+|\/detail\/product\/\d+\/[a-z0-9-]+)"/gi)) {
    uzinLinks.add(m[1].replace('https://us.uzin.com', ''));
  }
}
console.log('uzin detail links:', uzinLinks.size);
const uzinProducts = await pool.query(`
  SELECT p.id, p.name FROM products p JOIN brands b ON b.id=p.brand_id WHERE b.code='UZIN'`);
for (const link of uzinLinks) {
  // slug like 'uzin-nc-886' or 'nc-884-cg' → "NC 886"
  const slug = link.split('/').pop().replace(/^uzin-/, '').replace(/-/g, ' ').toUpperCase();
  const target = uzinProducts.rows.find(p => p.name.toUpperCase().includes(slug))
    || uzinProducts.rows.find(p => slug.startsWith(p.name.toUpperCase().replace(/^UZIN /, '').split(' ').slice(0, 2).join(' ')));
  if (!target || found.has(target.name)) continue;
  const t = await html('https://us.uzin.com' + link);
  let img = ogImage(t, 'https://us.uzin.com');
  if (!img && t) {
    const m = /(?:src|data-src)="(\/fileadmin\/[^"]*\.(?:png|jpg|jpeg|webp)[^"]*)"/i.exec(t);
    if (m && !/logo|icon/i.test(m[1])) img = 'https://us.uzin.com' + m[1];
  }
  if (img) found.set(target.name, img);
  await new Promise(r => setTimeout(r, 250));
}

// ── Known-URL attempts for the rest ──────────────────────────────────────────
const ATTEMPTS = [
  ['HardieBacker Cement Board', ['https://www.jameshardie.com/products/backer-board', 'https://www.jameshardie.com/products/hardie-backer-board', 'https://www.jameshardie.com/product-catalog/exterior/hardie-backer-board']],
  ['PermaBase Cement Board', ['https://permabase.com/products/permabase-original/', 'https://www.permabase.com/products/permabase-cement-board/', 'https://permabase.com/']],
  ['Fiberock Aqua-Tough', ['https://www.usg.com/content/usgcom/en/products/panels/usg-fiberock-panels/fiberock-brand-aqua-tough-tile-backerboard.html', 'https://www.usg.com/content/usgcom/en/products/panels/usg-fiberock-panels.html']],
  ['QUIKRETE Deck Mud', ['https://www.quikrete.com/productlines/FloorMud.asp', 'https://www.quikrete.com/productlines/floormud.asp', 'https://www.quikrete.com/productlines/SandTopping-Mix.asp']],
  ['QUIKRETE Wall Float', ['https://www.quikrete.com/productlines/WallFloat.asp', 'https://www.quikrete.com/productlines/wallfloat.asp']],
  ['Pliteq GenieMat', ['https://pliteq.com/products/geniemat-rst/', 'https://pliteq.com/product/geniemat-rst/', 'https://pliteq.com/geniemat/']],
  ['Roberts Black Jack', ['https://www.robertsconsolidated.com/product/70-025-black-jack-2-in-1-premium-underlayment/', 'https://www.robertsconsolidated.com/?s=black+jack']],
  ['Centaur SR', ['https://centaurfloorsystems.com/products/sound-reduction/', 'https://centaurfloorsystems.com/']],
  ['Sponge Cushion', ['https://spongecushion.com/products/', 'https://spongecushion.com/']],
];
for (const [pat, urls] of ATTEMPTS) {
  for (const u of urls) {
    const t = await html(u);
    const base = new URL(u).origin;
    const img = ogImage(t, base);
    if (img) { found.set(pat, img); break; }
  }
}

console.log('images found:', found.size);
for (const [k, v] of found) console.log('  ', k.slice(0, 50), '→', v.slice(0, 80));

// ── Apply ────────────────────────────────────────────────────────────────────
if (!dry) {
  const prods = await pool.query(`
    SELECT p.id, p.name FROM products p JOIN brands b ON b.id=p.brand_id
    WHERE b.code IN ('WFTAYLOR','UZIN','JAMESHAR','NATGYP','USG','GEORGIAP','BOTTINI','QUIKRETE','CENTAUR','PLITEQ','ROBERTSF','SPONGECU')`);
  let applied = 0;
  for (const p of prods.rows) {
    let img = null;
    for (const [pat, u] of found) {
      if (p.name.toUpperCase().startsWith(pat.toUpperCase()) || p.name.toUpperCase().includes(pat.toUpperCase())) { img = u; break; }
    }
    if (!img) continue;
    const has = await pool.query(`SELECT 1 FROM media_assets WHERE product_id=$1 AND asset_type='primary' LIMIT 1`, [p.id]);
    if (has.rows.length) continue;
    await pool.query(`INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                      VALUES ($1, NULL, 'primary', $2, $2, 0)`, [p.id, img]);
    applied++;
  }
  console.log('applied to products:', applied);
}
await pool.end();
