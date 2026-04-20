import {
  delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.metroflor.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Metroflor enrichment scraper for Tri-West.
 *
 * Fetches product data from metroflor.com Shopify JSON API (no browser needed).
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Shopify (FloorTitan theme) — uses /products.json endpoint.
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Metroflor';

  let errorCount = 0;
  let skusMatched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let specPdfsAdded = 0;
  let productsWithDesc = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Load all Metroflor SKUs from DB ──
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id, p.name AS product_name, p.description_long
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${skuResult.rows.length} ${brandPrefix} SKUs to enrich`);

    if (skuResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} SKUs found — run import-triwest-832 first`);
      return;
    }

    // ── Fetch ALL Shopify products via JSON API ──
    await appendLog(pool, job.id, `Fetching Shopify catalog from ${BASE_URL}/products.json...`);
    const shopifyProducts = await fetchAllShopifyProducts();
    await appendLog(pool, job.id, `Fetched ${shopifyProducts.length} Shopify products`);

    // ── Build SKU lookup from Shopify (normalized) ──
    const shopifyBySku = new Map();
    for (const p of shopifyProducts) {
      for (const v of (p.variants || [])) {
        if (v.sku) {
          const norm = v.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (norm) shopifyBySku.set(norm, p);
        }
      }
    }
    await appendLog(pool, job.id, `Built SKU lookup: ${shopifyBySku.size} Shopify variant SKUs`);

    // ── Per-SKU matching ──
    // Each DB SKU gets matched to a Shopify product individually.
    // Images are saved at the SKU level so each color gets its own images.
    const enrichedProducts = new Set(); // Track products we've already set description on
    let processed = 0;

    for (const sku of skuResult.rows) {
      processed++;
      try {
        const shopifyProduct = matchSkuToShopify(sku.vendor_sku, shopifyBySku);

        if (!shopifyProduct) {
          skusSkipped++;
          continue;
        }

        skusMatched++;
        const productData = extractProductData(shopifyProduct);

        // Update product description (once per product)
        if (productData.description && !enrichedProducts.has(sku.product_id) && !sku.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, sku.product_id]
          );
          enrichedProducts.add(sku.product_id);
          productsWithDesc++;
        }

        // Upsert images at SKU level (each color gets its own images)
        if (productData.images && productData.images.length > 0) {
          const sorted = preferProductShot(productData.images, sku.variant_name || '');
          for (let i = 0; i < Math.min(sorted.length, 4); i++) {
            const assetType = i === 0 ? 'primary' : (sorted[i].includes('room') || sorted[i].includes('scene') ? 'lifestyle' : 'alternate');
            await upsertMediaAsset(pool, {
              product_id: sku.product_id,
              sku_id: sku.sku_id,
              asset_type: assetType,
              url: sorted[i],
              original_url: sorted[i],
              sort_order: i,
            });
            imagesAdded++;
          }
        }

        // Upsert spec PDFs (product-level, once per product)
        if (productData.specPdfs && productData.specPdfs.length > 0 && !enrichedProducts.has(`pdf_${sku.product_id}`)) {
          for (let i = 0; i < productData.specPdfs.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: sku.product_id,
              sku_id: null,
              asset_type: 'spec_pdf',
              url: productData.specPdfs[i].url,
              original_url: productData.specPdfs[i].url,
              sort_order: i,
            });
            specPdfsAdded++;
          }
          enrichedProducts.add(`pdf_${sku.product_id}`);
        }

        // Upsert specs as SKU attributes
        if (productData.specs) {
          for (const [attrSlug, value] of Object.entries(productData.specs)) {
            if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
          }
        }
      } catch (err) {
        await logError(`SKU ${sku.vendor_sku}: ${err.message}`);
        skusSkipped++;
      }

      if (processed % 50 === 0) {
        await appendLog(pool, job.id, `Progress: ${processed}/${skuResult.rows.length} SKUs, ${skusMatched} matched, ${imagesAdded} images`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. SKUs: ${skuResult.rows.length}, Matched: ${skusMatched}, Skipped: ${skusSkipped}, ` +
      `Images: ${imagesAdded}, Descriptions: ${productsWithDesc}, Spec PDFs: ${specPdfsAdded}, Errors: ${errorCount}`,
      { products_found: skuResult.rows.length, products_updated: skusMatched }
    );

  } catch (err) {
    await appendLog(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}


// ─── Shopify JSON API Functions ─────────────────────────────────────────────

/**
 * Fetch all products from Shopify /products.json with pagination.
 * Returns flat array of all Shopify product objects.
 */
async function fetchAllShopifyProducts() {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/products.json?limit=250&page=${page}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      if (page === 1) throw new Error(`Shopify JSON API returned ${resp.status}`);
      break; // Later pages returning errors means we've likely exhausted products
    }

    const data = await resp.json();
    const batch = data.products || [];

    if (batch.length === 0) break;

    products.push(...batch);

    // If we got fewer than 250, we've reached the last page
    if (batch.length < 250) break;

    page++;
    // Small delay between pagination requests to be polite
    await delay(300);
  }

  return products;
}



/**
 * Match a single DB SKU to a Shopify product via vendor_sku normalization.
 *
 * Tri-West vendor_sku patterns for Metroflor:
 *   METDN123807     → strip MET       → dn123807      (Deja New)
 *   METDN123807ATX  → strip MET + ATX → dn123807      (Attraxion variant)
 *   METOTTDN123807  → strip MET + OTT → dn123807      (Over the Top variant)
 *   METINC20019PADCM→ strip MET + CM  → inc20019pad   (Inception w/ pad, click-match)
 *   METINC20051PBPAD→ strip MET       → inc20051pbpad (Inception paintbrush)
 *   METFA203        → strip MET       → fa203         (Inception Reserve)
 *   METCOS1283KO    → strip MET       → cos1283ko     (Cosmopolitan KnockOut)
 *   METCOS1283      → strip MET, +ko  → cos1283ko     (Cosmopolitan non-KO → try KO)
 *   MET87110KO      → strip MET       → 87110ko       (Studio Plus KnockOut)
 *   MET87110        → strip MET, +ko  → 87110ko       (Studio Plus non-KO → try KO)
 *   MET8873AB-CM    → strip MET       → 8873abcm      (Inception 200 AB)
 *   METCA301-12M    → strip MET       → ca30112m      (Provident)
 *
 * @param {string} vendorSku - DB vendor_sku (e.g. "METDN123807ATX")
 * @param {Map} shopifyBySku - Map<normalizedSku, shopifyProduct>
 * @returns {object|null} Shopify product or null
 */
function matchSkuToShopify(vendorSku, shopifyBySku) {
  if (!vendorSku) return null;

  const raw = vendorSku.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!raw) return null;

  // Direct match (unlikely but cheap)
  if (shopifyBySku.has(raw)) return shopifyBySku.get(raw);

  // Strip MET prefix
  const noMet = raw.replace(/^met/, '');
  if (!noMet) return null;
  if (shopifyBySku.has(noMet)) return shopifyBySku.get(noMet);

  // Strip ATX suffix (Attraxion magnetic system)
  const noAtx = noMet.replace(/atx$/, '');
  if (noAtx !== noMet && shopifyBySku.has(noAtx)) return shopifyBySku.get(noAtx);

  // Strip OTT prefix (Over the Top 5mm)
  const noOtt = noMet.replace(/^ott/, '');
  if (noOtt !== noMet && shopifyBySku.has(noOtt)) return shopifyBySku.get(noOtt);

  // Strip CM suffix (click-match variant — Shopify uses PAD without CM)
  const noCm = noMet.replace(/cm$/, '');
  if (noCm !== noMet && shopifyBySku.has(noCm)) return shopifyBySku.get(noCm);

  // Strip DLNP / DLWP / DL / WP suffixes (drop-lock/with-pad format variants)
  const noDl = noMet.replace(/(dlnp|dlwp|dl|wp)$/, '');
  if (noDl !== noMet && shopifyBySku.has(noDl)) return shopifyBySku.get(noDl);

  // Try appending KO suffix (Shopify KnockOut variants have KO, 832 sometimes doesn't)
  if (!noMet.endsWith('ko')) {
    const withKo = noMet + 'ko';
    if (shopifyBySku.has(withKo)) return shopifyBySku.get(withKo);
  }

  // Try appending ABCM suffix (Inception 200 AB-CM variants on Shopify)
  // DB has MET8873 or MET20019 patterns, Shopify has 8873abcm or inc20019pad
  // This is already covered by other rules above

  // Strip HAW/HAWIN prefix (Hawaii Inception → standard Inception)
  const noHaw = noMet.replace(/^haw(in)?/, 'inc');
  if (noHaw !== noMet && shopifyBySku.has(noHaw)) return shopifyBySku.get(noHaw);
  // Also try with pad suffix
  const noHawPad = noHaw + 'pad';
  if (noHaw !== noMet && shopifyBySku.has(noHawPad)) return shopifyBySku.get(noHawPad);

  return null;
}


// ─── Data Extraction from Shopify Product Objects ───────────────────────────

/**
 * Extract images, description, specs, and spec PDFs from a Shopify product object.
 * No browser needed — works entirely from the JSON data.
 */
function extractProductData(shopifyProduct) {
  // Extract images from Shopify product.images array
  const images = (shopifyProduct.images || [])
    .map(img => img.src)
    .filter(Boolean);

  // Extract description from body_html (strip HTML tags)
  const bodyHtml = shopifyProduct.body_html || '';
  const description = bodyHtml
    ? bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
    : null;

  // Parse specs from body_html
  const specs = parseMetroflorSpecs(bodyHtml);

  // Extract spec PDFs from body_html href links
  const specPdfs = extractPdfsFromHtml(bodyHtml);

  const hasData = images.length > 0 || description || (specs && Object.keys(specs).length > 0);

  return {
    images,
    description: description || null,
    specs: specs && Object.keys(specs).length > 0 ? specs : null,
    specPdfs,
  };
}

/**
 * Parse specs from Shopify product body_html.
 * Extracts: thickness, width/size, length, wear layer, finish, edge, material, construction, sqft/carton, warranty.
 */
function parseMetroflorSpecs(html) {
  if (!html) return {};
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ');
  const specs = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|material|species|size|dimensions?|construction|sqft|sq\s*ft|warranty|core|plank|format|surface)[:\s-]+(.+)/i);
    if (match) {
      const label = match[1].toLowerCase().trim();
      const value = match[2].trim();
      if (label.includes('thickness')) specs.thickness = value;
      if (label.includes('width') || label.includes('size') || label.includes('dimension') || label.includes('plank') || label.includes('format')) specs.size = value;
      if (label.includes('length')) specs.length = value;
      if (label.includes('wear')) specs.wear_layer = value;
      if (label.includes('finish') || label.includes('surface')) specs.finish = value;
      if (label.includes('edge')) specs.edge = value;
      if (label.includes('material') || label.includes('species')) specs.material = value;
      if (label.includes('construction') || label.includes('core')) specs.construction = value;
      if (label.includes('sqft') || label.includes('sq ft')) specs.sqft_per_carton = value;
      if (label.includes('warranty')) specs.warranty = value;
    }
  }

  // Also try "Label: Value" pattern in table-like structures (td/th pairs stripped to text)
  const kvPattern = /(?:^|\n)\s*([A-Za-z\s]+?)\s*:\s*(.+)/g;
  let kvMatch;
  while ((kvMatch = kvPattern.exec(text)) !== null) {
    const label = kvMatch[1].toLowerCase().trim();
    const value = kvMatch[2].trim();
    if (!value || value.length > 200) continue;
    if (label.includes('thickness') && !specs.thickness) specs.thickness = value;
    if ((label.includes('width') || label.includes('plank size') || label.includes('format')) && !specs.size) specs.size = value;
    if (label.includes('length') && !specs.length) specs.length = value;
    if (label.includes('wear layer') && !specs.wear_layer) specs.wear_layer = value;
    if ((label.includes('finish') || label.includes('surface')) && !specs.finish) specs.finish = value;
    if (label.includes('edge') && !specs.edge) specs.edge = value;
    if ((label.includes('core') || label.includes('construction')) && !specs.construction) specs.construction = value;
    if (label.includes('warranty') && !specs.warranty) specs.warranty = value;
    if ((label.includes('material') || label.includes('species')) && !specs.material) specs.material = value;
  }

  return specs;
}

/**
 * Extract PDF links from body_html.
 * Looks for href attributes ending in .pdf within the HTML string.
 * Returns array of { url, label } objects.
 */
function extractPdfsFromHtml(html) {
  if (!html) return [];

  const SPEC_KEYWORDS = [
    'spec', 'technical', 'install', 'maintenance', 'warranty',
    'care', 'data sheet', 'datasheet', 'guide', 'brochure',
  ];

  const pdfs = [];
  const seen = new Set();

  // Match href="...pdf" patterns in HTML
  const hrefPattern = /href=["']([^"']*\.pdf(?:\?[^"']*)?)["'][^>]*>([^<]*)</gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    let url = match[1].trim();
    const linkText = match[2].trim();

    // Make relative URLs absolute
    if (url && !url.startsWith('http')) {
      url = url.startsWith('/') ? `${BASE_URL}${url}` : `${BASE_URL}/${url}`;
    }

    const urlLower = url.toLowerCase();
    if (seen.has(urlLower)) continue;

    const label = linkText || url.split('/').pop().replace(/\.pdf.*$/i, '');
    const combined = (label + ' ' + urlLower).toLowerCase();

    // Only include if it looks like a spec/technical document
    if (SPEC_KEYWORDS.some(kw => combined.includes(kw))) {
      seen.add(urlLower);
      pdfs.push({ url, label });
    }
  }

  // Also match bare PDF URLs (not in href) — sometimes embedded as text
  const barePattern = /(?:https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?)/gi;
  while ((match = barePattern.exec(html)) !== null) {
    const url = match[0].trim();
    const urlLower = url.toLowerCase();
    if (seen.has(urlLower)) continue;

    const label = url.split('/').pop().replace(/\.pdf.*$/i, '');
    const combined = (label + ' ' + urlLower).toLowerCase();

    if (SPEC_KEYWORDS.some(kw => combined.includes(kw))) {
      seen.add(urlLower);
      pdfs.push({ url, label });
    }
  }

  return pdfs;
}


