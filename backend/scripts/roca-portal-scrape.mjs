/**
 * Roca Marketing Portal — SKU-Level Image + PDF Extraction
 *
 * Strategy:
 *   1. Login to marketing-assets.rocatileusa.com
 *   2. GET files.display page=1 → extract all file IDs from fileview array
 *   3. GET file.display for each ID (1.5KB/req, 15 concurrent)
 *   4. Categorize: tile images, room scenes, PDFs
 *   5. Parse portal filenames → collection, color, face, size (cm)
 *   6. Match tile images to DB SKUs using cm→inch size conversion
 *   7. Save room scenes as lifestyle (product-level per collection)
 *   8. Save PDFs as spec_pdf (product-level per collection)
 *
 * Run from HOST (not Docker) due to Cloudflare SSL issues:
 *   node backend/scripts/roca-portal-scrape.mjs
 */
import pg from 'pg';
import { saveSkuImages, saveProductImages, upsertMediaAsset } from '../scrapers/base.js';

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

// ── Enhanced filename parser ──
// Extracts collection+color key, face (F1/F6), size (cm), and ambient flag.
//   ABACO_ARENA_F1_30X60         → { productKey: "ABACO_ARENA", face: "F1", size: "30X60", isAmb: false }
//   AMB_ALWAYS_VEINCUT_MOKA_60X120 → { productKey: "ALWAYS_VEINCUT_MOKA", face: null, size: "60X120", isAmb: true }
//   WESTON_BEIGE_MOSAICO         → { productKey: "WESTON_BEIGE_MOSAICO", face: null, size: null, isAmb: false }
//   MOSCATO SAND (6)             → { productKey: "MOSCATO_SAND", face: null, size: null, isAmb: false }
function parsePortalFilename(title) {
  let clean = title.trim();

  // Detect and strip AMB_ prefix (ambient/room scene)
  const isAmb = /^AMB[_\s]/i.test(clean);
  if (isAmb) clean = clean.replace(/^AMB[_\s]+/i, '');

  // Normalize spaces to underscores
  clean = clean.replace(/\s+/g, '_');

  // Remove trailing "(number)" like "(6)"
  clean = clean.replace(/_?\(\d+\)$/i, '');

  let face = null, size = null;

  // Try face + size: _F{n}_{WxH}
  const faceSize = clean.match(/_F(\d+)_(\d+X\d+)$/i);
  if (faceSize) {
    face = `F${faceSize[1]}`;
    size = faceSize[2].toUpperCase();
    clean = clean.substring(0, clean.length - faceSize[0].length);
  } else {
    // Try just face at end: _F{n}
    const faceOnly = clean.match(/_F(\d+)$/i);
    if (faceOnly) {
      face = `F${faceOnly[1]}`;
      clean = clean.substring(0, clean.length - faceOnly[0].length);
    }
    // Try just size at end: _WxH
    const sizeOnly = clean.match(/_(\d+X\d+)$/i);
    if (sizeOnly) {
      size = sizeOnly[1].toUpperCase();
      clean = clean.substring(0, clean.length - sizeOnly[0].length);
    }
  }

  return { productKey: clean, face, size, isAmb };
}

// ── cm→inch size conversion ──
// Portal filenames use cm (30X60), DB variant_names use inches (12X24).
function cmToInch(cm) {
  return Math.round(cm / 2.54);
}

// Parse a "WxH" string into sorted [smaller, larger] numeric pair
function parseDims(sizeStr) {
  const m = sizeStr.match(/^(\d+)X(\d+)$/i);
  if (!m) return null;
  const a = parseInt(m[1]), b = parseInt(m[2]);
  return [Math.min(a, b), Math.max(a, b)];
}

// Extract size dimensions from a SKU variant_name like "Arena 12X24"
// Handles inch marks: 12"X24", smart quotes, fractional sizes
function extractSizeFromVariant(variantName) {
  const cleaned = variantName.replace(/[\u201C\u201D\u201E\u201F""'']/g, '');
  const m = cleaned.match(/(\d+)\s*X\s*(\d+)\s*$/i);
  if (!m) return null;
  const a = parseInt(m[1]), b = parseInt(m[2]);
  return [Math.min(a, b), Math.max(a, b)];
}

// Check if a portal cm-size matches a DB inch-size
function sizesMatch(portalSize, dbDims) {
  if (!portalSize || !dbDims) return false;

  const portalDims = parseDims(portalSize);
  if (!portalDims) return false;

  // Direct match (if portal happens to use same format)
  if (portalDims[0] === dbDims[0] && portalDims[1] === dbDims[1]) return true;

  // Convert portal cm → inches and compare
  const inchW = cmToInch(portalDims[0]);
  const inchH = cmToInch(portalDims[1]);
  const sorted = [Math.min(inchW, inchH), Math.max(inchW, inchH)];
  return sorted[0] === dbDims[0] && sorted[1] === dbDims[1];
}

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Product matching: portal productKey → DB product ──
// Uses collection prefix + color name matching (same logic as before)
function matchProductKey(normImgKey, byCollection) {
  let bestMatch = null;
  let bestScore = 0;

  for (const [normCol, products] of byCollection) {
    if (!normImgKey.startsWith(normCol)) continue;
    const colorPart = normImgKey.substring(normCol.length);

    for (const prod of products) {
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

  return bestScore >= 70 ? bestMatch : null;
}

async function run() {
  const cookies = await login();
  console.log('Logged in\n');

  // ── Load vendor + products + SKUs ──
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  if (!vendorRes.rows.length) { console.error('ROCA vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  const dbSkus = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.variant_name, s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
    ORDER BY s.product_id
  `, [vendorId]);

  // byCollection: normCollectionName → Product[]
  const byCollection = new Map();
  for (const prod of dbProducts.rows) {
    const normCol = normalizeForMatch(prod.collection);
    if (!byCollection.has(normCol)) byCollection.set(normCol, []);
    byCollection.get(normCol).push(prod);
  }

  // skusByProduct: productId → Sku[]
  const skusByProduct = new Map();
  for (const sku of dbSkus.rows) {
    if (!skusByProduct.has(sku.product_id)) skusByProduct.set(sku.product_id, []);
    skusByProduct.get(sku.product_id).push(sku);
  }

  console.log(`Products: ${dbProducts.rowCount}, SKUs: ${dbSkus.rowCount}\n`);

  // ── Step 1: Get all file IDs ──
  console.log('=== Step 1: Getting all file IDs from portal ===');
  const listUrl = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1`;
  const listResp = await fetch(listUrl, {
    headers: { 'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
  });
  const listData = await listResp.json();
  const allFileIds = (listData.fileview || []).map(f => f.id);
  console.log(`Total file IDs: ${allFileIds.length}\n`);

  // ── Step 2: Fetch details + categorize ──
  console.log('=== Step 2: Fetching file details ===');
  const imgExts = new Set(['jpg', 'jpeg', 'png', 'webp']);
  const tileImages = [];
  const roomScenes = [];
  const pdfFiles = [];
  let fetched = 0, errors = 0;

  for (let i = 0; i < allFileIds.length; i += CONCURRENCY) {
    const batch = allFileIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(id => fetchFileDetail(cookies, id)));

    for (const file of results) {
      if (!file) { errors++; continue; }
      const ext = (file.ext || '').toLowerCase();
      const catName = (file.cattitle || file.catname || '').toUpperCase();
      const entry = {
        id: file.ID,
        title: file.post_title || file.title,
        ext,
        catname: catName,
        download: file.linkdownload,
      };

      if (ext === 'pdf') {
        pdfFiles.push(entry);
      } else if (imgExts.has(ext)) {
        if (catName === 'ROOM SCENES') roomScenes.push(entry);
        else if (catName === 'TILES') tileImages.push(entry);
      }
    }

    fetched += batch.length;
    if (fetched % 150 === 0 || fetched === allFileIds.length) {
      process.stdout.write(`  ${fetched}/${allFileIds.length} files (${tileImages.length} tiles, ${roomScenes.length} scenes, ${pdfFiles.length} PDFs, ${errors} errors)\n`);
    }
  }

  console.log(`\nTile images: ${tileImages.length}`);
  console.log(`Room scenes: ${roomScenes.length}`);
  console.log(`PDF files: ${pdfFiles.length}`);
  console.log(`Fetch errors: ${errors}`);

  // ── Step 3: Parse + group tile images by productKey → size ──
  console.log('\n=== Step 3: Grouping tile images by product + size ===');

  // tileGroups: normProductKey → { key, bySize: Map<sizeKey, ImageEntry[]> }
  const tileGroups = new Map();

  for (const img of tileImages) {
    const parsed = parsePortalFilename(img.title);
    const normKey = normalizeForMatch(parsed.productKey);
    if (!tileGroups.has(normKey)) {
      tileGroups.set(normKey, { key: parsed.productKey, bySize: new Map() });
    }

    const sizeKey = parsed.size || '_nosize_';
    const group = tileGroups.get(normKey);
    if (!group.bySize.has(sizeKey)) group.bySize.set(sizeKey, []);
    group.bySize.get(sizeKey).push({
      ...img,
      face: parsed.face,
      size: parsed.size,
      isAmb: parsed.isAmb,
    });
  }

  console.log(`Unique tile product keys: ${tileGroups.size}`);

  // ── Step 4: Match tile images → DB products + SKUs ──
  console.log('\n=== Step 4: Matching tile images to products + SKUs ===');

  let productsMatched = 0;
  let skuLevelSaves = 0;
  let productLevelFallbacks = 0;
  const matchedProductIds = new Set();

  for (const [normImgKey, groupData] of tileGroups) {
    const product = matchProductKey(normImgKey, byCollection);
    if (!product) continue;

    matchedProductIds.add(product.product_id);
    productsMatched++;

    const allSkus = skusByProduct.get(product.product_id) || [];
    const nonAccessorySkus = allSkus.filter(s => s.variant_type !== 'accessory');

    // Sort images within each size group: non-AMB F1 first, then non-AMB others, then AMB
    for (const [, imgs] of groupData.bySize) {
      imgs.sort((a, b) => {
        if (a.isAmb !== b.isAmb) return a.isAmb ? 1 : -1;
        const aF1 = a.face === 'F1' ? 0 : 1;
        const bF1 = b.face === 'F1' ? 0 : 1;
        return aF1 - bF1;
      });
    }

    if (nonAccessorySkus.length <= 1) {
      // Single non-accessory SKU (or none): collect all images, save to that SKU or product-level
      const allUrls = [];
      for (const [, imgs] of groupData.bySize) {
        for (const img of imgs) allUrls.push(img.download);
      }

      if (nonAccessorySkus.length === 1) {
        await saveSkuImages(pool, product.product_id, nonAccessorySkus[0].sku_id, allUrls, { maxImages: 6 });
        skuLevelSaves++;
      } else {
        await saveProductImages(pool, product.product_id, allUrls, { maxImages: 6 });
        productLevelFallbacks++;
      }
      continue;
    }

    // Multiple non-accessory SKUs: match by size
    // Pre-parse DB SKU sizes for comparison
    const skuDims = new Map(); // sku_id → [w, h] sorted
    for (const sku of nonAccessorySkus) {
      const dims = extractSizeFromVariant(sku.variant_name);
      if (dims) skuDims.set(sku.sku_id, dims);
    }

    let anySkuMatched = false;

    for (const [sizeKey, imgs] of groupData.bySize) {
      if (sizeKey === '_nosize_') continue;

      // Find matching SKU by converting portal cm size → DB inch size
      let matchedSku = null;
      for (const sku of nonAccessorySkus) {
        const dims = skuDims.get(sku.sku_id);
        if (sizesMatch(sizeKey, dims)) {
          matchedSku = sku;
          break;
        }
      }

      if (matchedSku) {
        const urls = imgs.map(i => i.download);
        await saveSkuImages(pool, product.product_id, matchedSku.sku_id, urls, { maxImages: 4 });
        skuLevelSaves++;
        anySkuMatched = true;
      }
    }

    if (!anySkuMatched) {
      // No size matched — fall back to product-level with best available images
      const allUrls = [];
      for (const [, imgs] of groupData.bySize) {
        for (const img of imgs) allUrls.push(img.download);
      }
      await saveProductImages(pool, product.product_id, allUrls, { maxImages: 6 });
      productLevelFallbacks++;
    } else {
      // Save unsized images as product-level alternates
      const noSizeImgs = groupData.bySize.get('_nosize_');
      if (noSizeImgs && noSizeImgs.length > 0) {
        for (let idx = 0; idx < Math.min(noSizeImgs.length, 2); idx++) {
          await upsertMediaAsset(pool, {
            product_id: product.product_id,
            sku_id: null,
            asset_type: 'alternate',
            url: noSizeImgs[idx].download,
            original_url: noSizeImgs[idx].download,
            sort_order: 10 + idx,
          });
        }
      }
    }
  }

  console.log(`Products matched: ${productsMatched}`);
  console.log(`SKU-level image saves: ${skuLevelSaves}`);
  console.log(`Product-level fallbacks: ${productLevelFallbacks}`);

  // ── Step 5: Room scenes → lifestyle per collection ──
  console.log('\n=== Step 5: Saving lifestyle images ===');
  let lifestyleSaved = 0;
  let lifestyleCollections = 0;

  // Group room scenes by best-matching collection
  const lifestyleByCollection = new Map(); // normCol → scene[]

  for (const scene of roomScenes) {
    const parsed = parsePortalFilename(scene.title);
    const normKey = normalizeForMatch(parsed.productKey);

    // Find longest matching collection prefix
    let bestCol = null, bestLen = 0;
    for (const [normCol] of byCollection) {
      if (normKey.startsWith(normCol) && normCol.length > bestLen) {
        bestCol = normCol;
        bestLen = normCol.length;
      }
    }

    if (bestCol && bestLen >= 3) {
      if (!lifestyleByCollection.has(bestCol)) lifestyleByCollection.set(bestCol, []);
      lifestyleByCollection.get(bestCol).push(scene);
    }
  }

  for (const [normCol, scenes] of lifestyleByCollection) {
    const products = byCollection.get(normCol);
    if (!products) continue;

    const capped = scenes.slice(0, 4); // Cap at 4 per collection
    lifestyleCollections++;

    for (const prod of products) {
      for (let i = 0; i < capped.length; i++) {
        await upsertMediaAsset(pool, {
          product_id: prod.product_id,
          sku_id: null,
          asset_type: 'lifestyle',
          url: capped[i].download,
          original_url: capped[i].download,
          sort_order: 20 + i,
        });
        lifestyleSaved++;
      }
    }
  }

  console.log(`Lifestyle images saved: ${lifestyleSaved} across ${lifestyleCollections} collections`);

  // ── Step 6: PDFs → spec_pdf per collection ──
  console.log('\n=== Step 6: Saving PDF spec sheets ===');
  let pdfSaved = 0;
  let pdfCollections = 0;

  // Group PDFs by best-matching collection
  const pdfByCollection = new Map(); // normCol → pdf[]

  for (const pdf of pdfFiles) {
    const normTitle = normalizeForMatch(pdf.title);

    // Find longest matching collection prefix
    let bestCol = null, bestLen = 0;
    for (const [normCol] of byCollection) {
      if (normTitle.includes(normCol) && normCol.length > bestLen && normCol.length >= 3) {
        bestCol = normCol;
        bestLen = normCol.length;
      }
    }

    if (bestCol) {
      if (!pdfByCollection.has(bestCol)) pdfByCollection.set(bestCol, []);
      pdfByCollection.get(bestCol).push(pdf);
    }
  }

  for (const [normCol, pdfs] of pdfByCollection) {
    const products = byCollection.get(normCol);
    if (!products) continue;

    pdfCollections++;
    const first = pdfs[0]; // One PDF per collection

    for (const prod of products) {
      await upsertMediaAsset(pool, {
        product_id: prod.product_id,
        sku_id: null,
        asset_type: 'spec_pdf',
        url: first.download,
        original_url: first.download,
        sort_order: 0,
      });
      pdfSaved++;
    }
  }

  console.log(`PDF spec sheets saved: ${pdfSaved} across ${pdfCollections} collections`);

  // ── Summary ──
  const totalProducts = dbProducts.rowCount;
  const existingImages = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
      AND asset_type IN ('primary', 'alternate')
  `, [vendorId]);
  const productsWithAnyImage = new Set(existingImages.rows.map(r => r.product_id));

  const stillMissing = dbProducts.rows.filter(p => !productsWithAnyImage.has(p.product_id));
  const missingByCol = new Map();
  for (const p of stillMissing) {
    if (!missingByCol.has(p.collection)) missingByCol.set(p.collection, []);
    missingByCol.get(p.collection).push(p.name);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total files processed: ${allFileIds.length}`);
  console.log(`  Tile images: ${tileImages.length}`);
  console.log(`  Room scenes: ${roomScenes.length}`);
  console.log(`  PDF files: ${pdfFiles.length}`);
  console.log(`  Fetch errors: ${errors}`);
  console.log(`Products matched from portal: ${productsMatched}`);
  console.log(`  SKU-level image saves: ${skuLevelSaves}`);
  console.log(`  Product-level fallbacks: ${productLevelFallbacks}`);
  console.log(`Lifestyle images: ${lifestyleSaved} (${lifestyleCollections} collections)`);
  console.log(`PDF spec sheets: ${pdfSaved} (${pdfCollections} collections)`);
  console.log(`Products with images: ${productsWithAnyImage.size}/${totalProducts} (${Math.round(productsWithAnyImage.size / totalProducts * 100)}%)`);

  if (stillMissing.length) {
    console.log(`\nStill missing images (${missingByCol.size} collections, ${stillMissing.length} products):`);
    for (const [col, names] of [...missingByCol].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (names.length <= 5) console.log(`  ${col}: ${names.join(', ')}`);
      else console.log(`  ${col}: ${names.length} products (${names.slice(0, 3).join(', ')}...)`);
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
