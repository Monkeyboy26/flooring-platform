import {
  delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, normalizeTriwestName, fuzzyMatch
} from './base.js';

const BASE_URL = 'https://www.bravadahardwood.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Bravada enrichment scraper for Tri-West.
 *
 * Scrapes bravadahardwood.com for product images, specs, and PDFs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 *
 * Site structure:
 *   /store                  — Barcelona products (Squarespace commerce page)
 *   /{collection}           — Other collections (Contempo, D'Vine, Symphony, etc.)
 *   /store/{slug}           — Barcelona product detail pages
 *   /{collection}-products/{slug} or /{collection}-grade/{slug} — Other detail pages
 *   /resources              — Per-collection spec PDFs
 *
 * Image strategy per SKU:
 *   - Each SKU gets images from its OWN detail page only (no sharing)
 *   - Product photo (plank close-up, swatch, thumbnail) → primary
 *   - Room scene / lifestyle photo → lifestyle
 *   - Listing thumbnail from collection page → lifestyle (fallback)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */

// ── Collection definitions ──────────────────────────────────────────────────
const COLLECTIONS = [
  { name: 'Contempo',  slug: 'contempo',  species: 'European White Oak', pdfUrl: `${BASE_URL}/s/Contempo-Install-Warranty-Care.pdf` },
  { name: "D'Vine",    slug: 'dvine',     species: 'French White Oak',   pdfUrl: `${BASE_URL}/s/DVine-Installation-Warranty-Maintenance-English-1.pdf` },
  { name: 'Symphony',  slug: 'symphony',  species: 'French White Oak',   pdfUrl: `${BASE_URL}/s/Symphony-Installation-Warranty-Maintenance-English-1.pdf` },
  { name: 'Barcelona', slug: 'store',     species: 'European Walnut',    pdfUrl: `${BASE_URL}/s/Barcelona-Install-Warranty-Care.pdf`, isStore: true },
  { name: 'Branché',   slug: 'branche',   species: 'French White Oak',   pdfUrl: `${BASE_URL}/s/Branche-Installation-Warranty-Maintenance-English.pdf` },
  { name: 'Regalia',   slug: 'regalia',   species: 'European Oak',       pdfUrl: `${BASE_URL}/s/Regalia-Collection-Engineered-Hardwood-Flooring.pdf` },
];

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// ── Parse Barcelona store page via Squarespace JSON API ─────────────────────
// Fetches /store?format=json which returns all products with titles, URLs,
// and image arrays. Each product has unique images (no sharing).
async function fetchStoreProducts() {
  const resp = await fetch(`${BASE_URL}/store?format=json`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for store JSON API`);
  const data = await resp.json();

  const products = [];
  for (const item of (data.items || [])) {
    const title = item.title || '';
    const titleParts = title.match(/^(.+?)\s*-\s*(\S+)$/);
    const colorName = titleParts ? titleParts[1].trim() : title;
    const skuCode = titleParts ? titleParts[2].trim() : '';
    const path = item.fullUrl || `/store/${item.urlId}`;

    // Extract ALL image CDN URLs from the product's gallery items
    const imageUrls = [];
    for (const galleryItem of (item.items || [])) {
      if (galleryItem.assetUrl) {
        imageUrls.push(galleryItem.assetUrl);
      }
    }

    products.push({
      path,
      slug: item.urlId || '',
      colorName,
      skuCode,
      listingImg: imageUrls[0] || '', // First image is the listing thumbnail
      imageUrls, // All images from the gallery
      url: `${BASE_URL}${path}`,
      hasDetailImages: true, // Images come from JSON, no need to visit detail page
    });
  }
  return products;
}

// ── Parse collection page (non-Barcelona) ───────────────────────────────────
// Extracts product links and listing images from collection pages.
function parseCollectionPage(html, collectionSlug) {
  const products = [];
  const linkPattern = /href="(\/(?:[a-z'-]+-(?:products|grade)|store)\/([^"]+))"/gi;
  const seen = new Set();
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const path = match[1];
    const slug = match[2];
    if (seen.has(path)) continue;
    seen.add(path);

    // Find associated alt text (usually "ColorName - SKU")
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const imgPattern = new RegExp(`href="${escapedPath}"[^>]*>\\s*(?:<[^>]*>\\s*)*<img[^>]+alt="([^"]*)"`, 'i');
    const imgMatch = imgPattern.exec(html);
    const alt = imgMatch ? imgMatch[1] : '';

    // Extract listing image URL (the <img> near this <a>)
    const imgSrcPattern = new RegExp(`href="${escapedPath}"[^>]*>\\s*(?:<[^>]*>\\s*)*<img[^>]+(?:data-src|src)="(https://images\\.squarespace-cdn\\.com/content/[^"]+)"`, 'i');
    const imgSrcMatch = imgSrcPattern.exec(html);
    const listingImg = imgSrcMatch ? imgSrcMatch[1].split('?')[0] : '';

    const altParts = alt.match(/^(.+?)\s*-\s*(\S+)$/);
    let colorName = altParts ? altParts[1].trim() : slug.replace(/-[a-z]*\d+$/i, '').replace(/-/g, ' ');
    let skuCode = altParts ? altParts[2].trim() : '';

    // Fallback: extract SKU code from URL slug (e.g., "opus-95300" → "95300", "ambry-cnam001" → "CNAM001")
    if (!skuCode) {
      const slugMatch = slug.match(/[-_]([a-z]*\d{3,5})(?:[-_]|$)/i);
      if (slugMatch) skuCode = slugMatch[1].toUpperCase();
      // Also try to extract color name from alt text (e.g., "OPUS 95300.jpg" → "Opus")
      const altFallback = alt.replace(/\.\w+$/, '').match(/^([a-z]+)\s+\d+$/i);
      if (altFallback) colorName = altFallback[1].charAt(0).toUpperCase() + altFallback[1].slice(1).toLowerCase();
    }

    products.push({
      path,
      slug,
      colorName,
      skuCode,
      listingImg,
      url: `${BASE_URL}${path}`,
    });
  }
  return products;
}

// ── Parse product detail page ───────────────────────────────────────────────
function parseProductPage(html, colorName) {
  const data = { images: [], specs: {}, description: null };

  // Extract specs
  const specPattern = /<(?:strong|b)>([^<]+)<\/(?:strong|b)>\s*(?:&nbsp;)?\s*([^<]+)/gi;
  let specMatch;
  while ((specMatch = specPattern.exec(html)) !== null) {
    const label = specMatch[1].trim().toUpperCase();
    const value = specMatch[2].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (!value || value.length > 200) continue;

    if (label.includes('SIZE'))                   data.specs.thickness = value;
    else if (label.includes('SPECIES'))           data.specs.material = value;
    else if (label.includes('GRADE'))             data.specs.grade = value;
    else if (label.includes('WEAR LAYER'))        data.specs.wear_layer = value;
    else if (label.includes('FINISH'))            data.specs.finish = value;
    else if (label.includes('CONSTRUCTION'))      data.specs.construction = value;
    else if (label.includes('SQ FT'))             data.specs.sqft_per_carton = value;
    else if (label.includes('WARRANTY'))          data.specs.warranty = value;
  }

  // Extract images — trim to before "Related Products"
  const relatedIdx = html.indexOf('Related Products');
  const productHtml = relatedIdx > 0 ? html.substring(0, relatedIdx) : html;

  const imgPattern = /https:\/\/images\.squarespace-cdn\.com\/content\/v1\/[0-9a-f-]+\/[0-9A-Z-]+\/([^"'\s&?]+)/gi;
  const rawImgs = new Set();
  let imgMatch;
  while ((imgMatch = imgPattern.exec(productHtml)) !== null) {
    const fullUrl = imgMatch[0];
    const filename = decodeURIComponent(imgMatch[1] || fullUrl.split('/').pop()).toLowerCase();
    if (filename.includes('logo') || filename.includes('banner') || filename.includes('header')
        || filename.includes('footer') || filename.includes('collections')
        || filename.includes('favicon') || filename.endsWith('.ico')) continue;
    rawImgs.add(fullUrl);
  }

  // Classify images: product photo vs room scene
  const colorLower = colorName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const productShots = [];
  const lifestyleShots = [];

  for (const url of rawImgs) {
    const filename = decodeURIComponent(url.split('/').pop()).toLowerCase();
    const fileNoExt = filename.replace(/\.\w+$/, '');

    // Strip color name to see residue
    const residue = fileNoExt.replace(colorLower, '').replace(/[^a-z0-9]/g, '');

    // Product shot indicators
    const isSwatchOrThumb = /swatch|thumbnail|plank|sample|close/i.test(filename);
    const isNumberedPrefix = /^\d+-/.test(filename);
    const isJustColor = residue.length === 0 || /^copy$/.test(residue);
    const isShortColorName = fileNoExt.length <= 15 && !/\d/.test(fileNoExt) && !/[_+]/.test(fileNoExt);

    // Room scene indicators
    const hasRoomKeyword = /room|scene|lifestyle|installed|back\b/i.test(filename);

    if (isSwatchOrThumb && !hasRoomKeyword) {
      productShots.push(url + '?format=1500w');
    } else if (hasRoomKeyword) {
      lifestyleShots.push(url + '?format=1500w');
    } else if (isNumberedPrefix || isJustColor || isShortColorName) {
      productShots.push(url + '?format=1500w');
    } else {
      lifestyleShots.push(url + '?format=1500w');
    }
  }

  data.images = { productShots, lifestyleShots };

  // Build description
  const titleMatch = html.match(/<h1[^>]*>([^<]+)/i);
  if (titleMatch) {
    const species = data.specs.material || '';
    data.description = `${titleMatch[1].trim()} ${species} Engineered Hardwood by Bravada.`.replace(/\s+/g, ' ');
  }

  return data;
}

// ── Main run function ───────────────────────────────────────────────────────
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 1500;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Bravada';

  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let pdfsAdded = 0;
  let specsAdded = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Load existing Bravada products & SKUs from DB ──
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name,
             s.variant_type, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} products found — run import-triwest-832 first`);
      return;
    }

    // Build lookup: product_id → product row
    const productById = new Map();
    for (const row of prodResult.rows) {
      productById.set(row.product_id, row);
    }

    // ── Scrape all collection pages to build site product catalog ──
    // Key: skuCode → site product info
    const siteProductsBySkuCode = new Map();

    await appendLog(pool, job.id, `Scraping ${COLLECTIONS.length} collection pages...`);

    for (const coll of COLLECTIONS) {
      try {
        let products;
        if (coll.isStore) {
          // Barcelona: use Squarespace JSON API (returns images directly)
          products = await fetchStoreProducts();
        } else {
          const html = await fetchHtml(`${BASE_URL}/${coll.slug}`);
          products = parseCollectionPage(html, coll.slug);
        }

        for (const p of products) {
          const sp = { ...p, collectionName: coll.name, species: coll.species, pdfUrl: coll.pdfUrl };
          if (sp.skuCode) {
            siteProductsBySkuCode.set(sp.skuCode.toUpperCase(), sp);
          }
        }
        await appendLog(pool, job.id, `  ${coll.name}: ${products.length} products found`);
        await delay(500);
      } catch (err) {
        await logError(`Failed to scrape ${coll.name} collection page: ${err.message}`);
      }
    }

    await appendLog(pool, job.id, `Site catalog: ${siteProductsBySkuCode.size} products indexed by SKU code`);

    // ── Clear old images for all Bravada SKUs (we'll replace with per-SKU) ──
    const allProductIds = prodResult.rows.map(r => r.product_id);
    await pool.query(`
      DELETE FROM media_assets
      WHERE product_id = ANY($1) AND asset_type IN ('primary', 'alternate', 'lifestyle')
    `, [allProductIds]);

    // ── Match & enrich per-SKU ──
    let matched = 0;
    let unmatched = 0;
    const fetchedPages = new Map(); // url → parseProductPage result
    const pdfSaved = new Set();
    const specsSaved = new Set();

    for (const sku of skuResult.rows) {
      // Skip accessories
      if (sku.variant_type === 'accessory') {
        skusSkipped++;
        continue;
      }

      const product = productById.get(sku.product_id);
      if (!product) { skusSkipped++; continue; }

      // Extract the raw SKU code by stripping "BRA" prefix from vendor_sku
      // e.g., BRABCEW001 → BCEW001, BRABCEWHB001 → BCEWHB001, BRA14751 → 14751
      const rawSkuCode = (sku.vendor_sku || '').replace(/^BRA/i, '').toUpperCase();

      // ── Match by EXACT SKU code ──
      let siteProduct = siteProductsBySkuCode.get(rawSkuCode);

      // Fallback: try numeric-only match (D'Vine uses 5-digit codes like 14751)
      if (!siteProduct && /^\d+$/.test(rawSkuCode)) {
        // Try with common prefix patterns
        for (const [code, sp] of siteProductsBySkuCode) {
          if (code === rawSkuCode || code.endsWith(rawSkuCode)) {
            siteProduct = sp;
            break;
          }
        }
      }

      // Fallback: try extracting SKU from URL slug (some Contempo slugs: "ambry-cnam001")
      if (!siteProduct) {
        for (const [code, sp] of siteProductsBySkuCode) {
          if (sp.slug && sp.slug.toUpperCase().includes(rawSkuCode)) {
            siteProduct = sp;
            break;
          }
        }
      }

      if (!siteProduct) {
        unmatched++;
        skusSkipped++;
        continue;
      }

      matched++;

      // ── Get images for this SKU ──
      try {
        let productShots = [];
        let lifestyleShots = [];

        if (siteProduct.hasDetailImages && siteProduct.imageUrls) {
          // Barcelona: images already extracted from JSON API — classify them
          for (const url of siteProduct.imageUrls) {
            const filename = decodeURIComponent(url.split('/').pop()).toLowerCase();
            const hasRoomKeyword = /room|scene|lifestyle|installed|back\b/i.test(filename);
            const isThumb = /swatch|thumbnail|plank|sample|close/i.test(filename);
            const isShortName = filename.replace(/\.\w+$/, '').length <= 15 && !/\d/.test(filename) && !/[_+]/.test(filename);

            if (hasRoomKeyword && !isThumb) {
              lifestyleShots.push(url + '?format=1500w');
            } else {
              productShots.push(url + '?format=1500w');
            }
          }
        } else {
          // Other collections: fetch detail page and parse images
          let productData = fetchedPages.get(siteProduct.url);
          if (!productData) {
            const html = await fetchHtml(siteProduct.url);
            productData = parseProductPage(html, siteProduct.colorName);
            fetchedPages.set(siteProduct.url, productData);
            await delay(delayMs);
          }
          productShots = productData.images.productShots;
          lifestyleShots = productData.images.lifestyleShots;
        }

        // ── Save images per-SKU ──
        let sortOrder = 0;

        // Primary: product shots
        for (const url of productShots) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type: sortOrder === 0 ? 'primary' : 'alternate',
            url,
            original_url: url,
            sort_order: sortOrder++,
          });
          imagesAdded++;
        }

        // Lifestyle: room scenes
        for (const url of lifestyleShots) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            asset_type: 'lifestyle',
            url,
            original_url: url,
            sort_order: sortOrder++,
          });
          imagesAdded++;
        }

        // Lifestyle fallback: listing image from collection page
        if (siteProduct.listingImg && !siteProduct.hasDetailImages) {
          const listingUrl = siteProduct.listingImg + '?format=1500w';
          const alreadySaved = [...productShots, ...lifestyleShots].some(u => u.includes(siteProduct.listingImg));
          if (!alreadySaved) {
            await upsertMediaAsset(pool, {
              product_id: sku.product_id,
              sku_id: sku.sku_id,
              asset_type: 'lifestyle',
              url: listingUrl,
              original_url: listingUrl,
              sort_order: sortOrder++,
            });
            imagesAdded++;
          }
        }

        // If no product shot found, promote first lifestyle to primary
        if (productShots.length === 0 && lifestyleShots.length > 0) {
          await pool.query(`
            UPDATE media_assets SET asset_type = 'primary'
            WHERE sku_id = $1 AND asset_type = 'lifestyle' AND sort_order = (
              SELECT MIN(sort_order) FROM media_assets WHERE sku_id = $1 AND asset_type = 'lifestyle'
            )
          `, [sku.sku_id]);
        }

        // ── Save spec PDF (once per product) ──
        if (siteProduct.pdfUrl && !pdfSaved.has(sku.product_id)) {
          await upsertMediaAsset(pool, {
            product_id: sku.product_id,
            sku_id: null,
            asset_type: 'spec_pdf',
            url: siteProduct.pdfUrl,
            original_url: siteProduct.pdfUrl,
            sort_order: 0,
          });
          pdfsAdded++;
          pdfSaved.add(sku.product_id);
        }

        // ── Save specs as SKU attributes ──
        // For Barcelona (JSON source), fetch detail page for specs if not already cached
        let productData = fetchedPages.get(siteProduct.url);
        if (!productData && !specsSaved.has(sku.sku_id)) {
          try {
            const html = await fetchHtml(siteProduct.url);
            productData = parseProductPage(html, siteProduct.colorName);
            fetchedPages.set(siteProduct.url, productData);
            await delay(delayMs);
          } catch { /* specs fetch failed, continue */ }
        }
        if (productData && Object.keys(productData.specs).length > 0 && !specsSaved.has(sku.sku_id)) {
          for (const [attrSlug, value] of Object.entries(productData.specs)) {
            if (value) {
              await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
              specsAdded++;
            }
          }
          specsSaved.add(sku.sku_id);
        }

        skusEnriched++;

      } catch (err) {
        await logError(`${product.collection} / ${sku.variant_name}: ${err.message}`);
        skusSkipped++;
      }

      if (matched % 20 === 0) {
        await appendLog(pool, job.id, `Progress: ${matched} SKUs matched, ${imagesAdded} images, ${specsAdded} specs`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Matched: ${matched}, Unmatched: ${unmatched}, SKUs enriched: ${skusEnriched}, ` +
      `Skipped: ${skusSkipped}, Images: ${imagesAdded}, PDFs: ${pdfsAdded}, Specs: ${specsAdded}, Errors: ${errorCount}`,
      { products_found: siteProductsBySkuCode.size, products_updated: matched }
    );

  } catch (err) {
    await logError(`Fatal: ${err.message}`);
    throw err;
  }
}
