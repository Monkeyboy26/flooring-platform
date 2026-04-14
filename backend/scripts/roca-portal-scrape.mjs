/**
 * Roca Marketing Portal — Full Image Extraction & DB Matching
 *
 * Strategy:
 *   1. Login to marketing-assets.rocatileusa.com
 *   2. GET files.display page=1 → extract all 8,385 file IDs from fileview array
 *   3. GET file.display for each ID (1.5KB/req, 20 concurrent)
 *   4. Filter to images, group by product (collection+color)
 *   5. Match to DB products and save download URLs to media_assets
 *
 * Run from HOST (not Docker) due to Cloudflare SSL issues:
 *   node backend/scripts/roca-portal-scrape.mjs
 */
import pg from 'pg';

const BASE = 'https://marketing-assets.rocatileusa.com';
const CONCURRENCY = 15;

const pool = new pg.Pool({
  host: 'localhost', port: 5432, database: 'flooring_pim',
  user: 'postgres', password: 'postgres',
});

// ── Auth ──
async function login() {
  const r1 = await fetch(BASE, { redirect: 'follow' });
  const cookies1 = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  let cookieStr = cookies1.map(c => c.split(';')[0]).join('; ');
  const html = await r1.text();
  const csrfMatch = html.match(/name="CSRFToken-wppb"\s+(?:id="[^"]*"\s+)?value="([^"]*)"/);
  const wppbLogin = html.match(/name="wppb_login"\s+value="([^"]*)"/);
  const wpRef = html.match(/name="_wp_http_referer"\s+value="([^"]*)"/);
  const body = new URLSearchParams({
    log: 'RomaFlooring', pwd: 'Iluvlions910!', rememberme: 'forever',
    'wp-submit': 'Log In', redirect_to: BASE + '/',
    wppb_login: wppbLogin ? wppbLogin[1] : 'true',
    wppb_form_location: 'page', wppb_request_url: BASE + '/',
    'CSRFToken-wppb': csrfMatch ? csrfMatch[1] : '',
    '_wp_http_referer': wpRef ? wpRef[1] : '/',
    wppb_redirect_check: 'true',
  });
  const r2 = await fetch(BASE + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr },
    body: body.toString(), redirect: 'manual',
  });
  for (const c of (r2.headers.getSetCookie ? r2.headers.getSetCookie() : []))
    cookieStr += '; ' + c.split(';')[0];
  const loc = r2.headers.get('location');
  if (loc) {
    const r3 = await fetch(loc, { headers: { Cookie: cookieStr }, redirect: 'follow' });
    for (const c of (r3.headers.getSetCookie ? r3.headers.getSetCookie() : []))
      cookieStr += '; ' + c.split(';')[0];
  }
  return cookieStr;
}

// ── Fetch file detail ──
async function fetchFileDetail(cookies, id) {
  const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=file.display&id=${id}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(url, {
      headers: { 'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.file || null;
  } catch { return null; }
}

// ── Parse filename to extract collection + color identity ──
function parseProductKey(title) {
  // Patterns seen:
  //   ALWAYS_VEINCUT_MOKA_F1_60X120   → ALWAYS_VEINCUT_MOKA
  //   ABACO_ARENA_F1_30X60            → ABACO_ARENA
  //   WESTON_BEIGE_MOSAICO            → WESTON_BEIGE_MOSAICO
  //   MOSCATO SAND (6)                → MOSCATO SAND
  //   ALASKA WHITE F6                 → ALASKA WHITE
  //   ROCA SELECT_ROC048B0025_LM NUAGE MC 160X160 R (1) → complex

  // Remove face and size suffix: _F{n}_{WxH} or _F{n} at end
  let clean = title
    .replace(/_F\d+_\d+X\d+$/i, '')      // COLLECTION_COLOR_F1_60X120
    .replace(/ F\d+$/i, '')               // COLLECTION COLOR F6
    .replace(/\s*\(\d+\)\s*$/i, '')       // COLLECTION COLOR (6)
    .replace(/_\d+X\d+$/i, '')            // leftover size suffix
    .trim();
  return clean;
}

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function run() {
  const cookies = await login();
  console.log('Logged in\n');

  // Get vendor and products
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  if (!vendorRes.rows.length) { console.error('ROCA vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.id) as sku_ids
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which already have images
  const existingImages = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  const needsImages = dbProducts.rows.filter(r => !alreadyHasImage.has(r.product_id));
  console.log(`Total products: ${dbProducts.rowCount}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${needsImages.length}\n`);

  if (!needsImages.length) { console.log('All products have images!'); await pool.end(); return; }

  // Group by collection
  const byCollection = new Map();
  for (const prod of needsImages) {
    const normCol = normalizeForMatch(prod.collection);
    if (!byCollection.has(normCol)) byCollection.set(normCol, []);
    byCollection.get(normCol).push(prod);
  }

  // ── Step 1: Get all file IDs ──
  console.log('=== Step 1: Getting all file IDs from portal ===');
  const listUrl = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1`;
  const listResp = await fetch(listUrl, {
    headers: { 'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
  });
  const listData = await listResp.json();
  const allFileIds = (listData.fileview || []).map(f => f.id);
  console.log(`Total file IDs: ${allFileIds.length}\n`);

  // ── Step 2: Fetch details for each file ──
  console.log('=== Step 2: Fetching file details ===');
  const imgExts = new Set(['jpg', 'jpeg', 'png', 'webp']);
  const allImages = [];     // tile images
  const roomScenes = [];    // lifestyle images
  let fetched = 0;
  let errors = 0;

  for (let i = 0; i < allFileIds.length; i += CONCURRENCY) {
    const batch = allFileIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(id => fetchFileDetail(cookies, id)));

    for (const file of results) {
      if (!file) { errors++; continue; }
      if (!imgExts.has(file.ext?.toLowerCase())) continue;

      const catName = (file.cattitle || file.catname || '').toUpperCase();
      const entry = {
        id: file.ID,
        title: file.post_title || file.title,
        ext: file.ext,
        catname: catName,
        download: file.linkdownload,
      };

      if (catName === 'ROOM SCENES') roomScenes.push(entry);
      else if (catName === 'TILES') allImages.push(entry);
      // Skip ARCHICAD, REVIT, TEXTURES, etc.
    }

    fetched += batch.length;
    if (fetched % 150 === 0 || fetched === allFileIds.length) {
      process.stdout.write(`  ${fetched}/${allFileIds.length} files processed (${allImages.length} tile images, ${roomScenes.length} scenes, ${errors} errors)\n`);
    }
  }

  console.log(`\nTile images: ${allImages.length}`);
  console.log(`Room scenes: ${roomScenes.length}`);
  console.log(`Fetch errors: ${errors}`);

  // ── Step 3: Group by product ──
  console.log('\n=== Step 3: Grouping by product ===');
  const byProduct = new Map();

  for (const img of allImages) {
    const key = parseProductKey(img.title);
    const normKey = normalizeForMatch(key);
    if (!byProduct.has(normKey)) byProduct.set(normKey, { key, files: [] });
    byProduct.get(normKey).files.push(img);
  }
  console.log(`Unique tile products in portal: ${byProduct.size}`);

  // Pick best image per product (prefer F1, then largest size, then first)
  function sizeScore(title) {
    const m = title.match(/(\d+)X(\d+)/i);
    return m ? parseInt(m[1]) * parseInt(m[2]) : 0;
  }

  const bestImages = new Map();
  for (const [normKey, data] of byProduct) {
    const sorted = data.files.sort((a, b) => {
      // Prefer F1
      const aF1 = /[_\s]F1[_\s.]/i.test(a.title) ? 0 : 1;
      const bF1 = /[_\s]F1[_\s.]/i.test(b.title) ? 0 : 1;
      if (aF1 !== bF1) return aF1 - bF1;
      // Then by size descending
      return sizeScore(b.title) - sizeScore(a.title);
    });
    bestImages.set(normKey, { download: sorted[0].download, title: sorted[0].title, key: data.key });
  }

  // ── Step 4: Match to DB products ──
  console.log('\n=== Step 4: Matching to DB products ===');
  let matched = 0;
  let totalSaved = 0;
  const matchedProductIds = new Set();

  for (const [normImgKey, imgData] of bestImages) {
    let bestMatch = null;
    let bestScore = 0;

    for (const [normCol, products] of byCollection) {
      if (!normImgKey.startsWith(normCol)) continue;
      const colorPart = normImgKey.substring(normCol.length);

      for (const prod of products) {
        if (matchedProductIds.has(prod.product_id)) continue;
        const normProd = normalizeForMatch(prod.name);

        let score = 0;
        if (normProd === colorPart) score = 100;
        else if (colorPart.includes(normProd) && normProd.length >= 3) score = 80;
        else if (normProd.includes(colorPart) && colorPart.length >= 3) score = 70;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = prod;
        }
      }
    }

    if (bestMatch && bestScore >= 70) {
      matchedProductIds.add(bestMatch.product_id);
      matched++;

      for (const skuId of bestMatch.sku_ids) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'primary', $3, $3, 0)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [bestMatch.product_id, skuId, imgData.download]);
        totalSaved++;
      }
    }
  }

  console.log(`Products matched from portal: ${matched}`);
  console.log(`Images saved: ${totalSaved}`);

  // Also save room scenes as lifestyle images
  let lifestyleSaved = 0;
  for (const scene of roomScenes) {
    const cleanTitle = scene.title.replace(/^AMB[_\s]*/i, '').replace(/\s*\d+X\d+.*$/i, '').trim();
    const normScene = normalizeForMatch(cleanTitle);

    for (const [normCol, products] of byCollection) {
      if (!normScene.startsWith(normCol)) continue;
      const colorPart = normScene.substring(normCol.length);

      for (const prod of products) {
        if (!matchedProductIds.has(prod.product_id)) continue;
        const normProd = normalizeForMatch(prod.name);
        if (colorPart === normProd || (colorPart.includes(normProd) && normProd.length >= 3)) {
          for (const skuId of prod.sku_ids) {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, $2, 'lifestyle', $3, $3, 1)
              ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [prod.product_id, skuId, scene.download]);
            lifestyleSaved++;
          }
          break;
        }
      }
    }
  }
  console.log(`Lifestyle images saved: ${lifestyleSaved}`);

  // Summary
  const totalWithImages = alreadyHasImage.size + matchedProductIds.size;
  const stillMissing = dbProducts.rows.filter(p => !alreadyHasImage.has(p.product_id) && !matchedProductIds.has(p.product_id));
  console.log(`\n=== Summary ===`);
  console.log(`Products with images (website): ${alreadyHasImage.size}`);
  console.log(`Products with images (portal): ${matched}`);
  console.log(`Total with images: ${totalWithImages}/${dbProducts.rowCount}`);
  console.log(`Still missing: ${stillMissing.length}`);

  if (stillMissing.length) {
    const missingByCol = new Map();
    for (const p of stillMissing) {
      if (!missingByCol.has(p.collection)) missingByCol.set(p.collection, []);
      missingByCol.get(p.collection).push(p.name);
    }
    console.log(`\nMissing by collection (${missingByCol.size} collections):`);
    for (const [col, names] of [...missingByCol].sort((a,b) => a[0].localeCompare(b[0]))) {
      if (names.length <= 5) console.log(`  ${col}: ${names.join(', ')}`);
      else console.log(`  ${col}: ${names.length} products`);
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
