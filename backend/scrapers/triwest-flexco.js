import {
  launchBrowser, delay, appendLog, addJobError,
  upsertMediaAsset, upsertSkuAttribute, resolveImageExtension, downloadImage
} from './base.js';

const BASE_URL = 'https://flexcofloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Flexco product line page definitions.
 * Each entry maps a URL on flexcofloors.com to regex patterns that match DB product names.
 */
const PRODUCT_LINE_PAGES = [
  // Wall Base
  { slug: 'vinyl-wall-base', url: '/vinyl-wall-base/', patterns: [/vinyl\s*wall\s*base/i, /\brwb\b/i] },
  { slug: 'base-sculptures', url: '/base-sculptures/', patterns: [/base\s*sculpt/i] },
  { slug: 'wallflowers', url: '/wallflowers/', patterns: [/wallflower/i] },
  { slug: 'base-2000', url: '/base-2000/', patterns: [/base\s*2000/i] },
  { slug: 'health-design', url: '/health-design-wall-base/', patterns: [/health\s*design/i] },
  // Rubber Flooring
  { slug: 'flextones', url: '/flextones/', patterns: [/flextone/i] },
  { slug: 'spextones', url: '/spextones/', patterns: [/spextone/i] },
  { slug: 'evolving-styles', url: '/evolving-styles-creative-elements/', patterns: [/evolving\s*style/i, /creative\s*element/i] },
  { slug: 'flextuft', url: '/flextuft/', patterns: [/flextuft/i] },
  { slug: 'prime-sports', url: '/prime-sports/', patterns: [/prime\s*sport/i] },
  { slug: 'enviroflex', url: '/enviroflex/', patterns: [/enviroflex/i] },
  // Vinyl Flooring
  { slug: 'crosswire', url: '/crosswire/', patterns: [/crosswire/i] },
  { slug: 'delane', url: '/delane-solid-vinyl-tile/', patterns: [/delane/i] },
  { slug: 'geodesy', url: '/geodesy-solid-vinyl-tile/', patterns: [/geodesy/i] },
  { slug: 'natural-elements', url: '/natural-elements-vinyl-tile/', patterns: [/natural\s*element/i] },
  // Specialty
  { slug: 'repel', url: '/repel/', patterns: [/repel/i] },
  { slug: 'esd', url: '/esd-static-control-flooring/', patterns: [/\besd\b/i, /static\s*control/i] },
  { slug: 'imo-rubber', url: '/imo-rubber-flooring/', patterns: [/\bimo\b/i] },
  // Stair Treads
  { slug: 'rubber-stair-treads', url: '/distinct-designs-rubber-stair-treads-vc/', patterns: [/rubber.*stair|stair.*tread/i] },
  { slug: 'vinyl-stair-treads', url: '/vinyl-stair-treads/', patterns: [/vinyl.*stair/i] },
  // Accessories / Profiles
  { slug: 'rubber-profiles', url: '/rubber-profiles/', patterns: [/rubber\s*profile/i] },
  { slug: 'transitions', url: '/transitions/', patterns: [/transition/i] },
];

/**
 * Flexco enrichment scraper for Tri-West.
 *
 * Phase 1: Crawl ~25 product line pages on flexcofloors.com to build a catalog
 *          of { productLine → { description, colors: Map<code, {name, imageUrl}>, specs } }
 * Phase 2: Match existing DB products/SKUs against the catalog by product line name
 *          and color code, then enrich with images, descriptions, and attributes.
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;

  let browser = null;
  let errorCount = 0;
  let totalProducts = 0;
  let totalEnriched = 0;
  let totalSkipped = 0;
  let totalImagesAdded = 0;
  let totalAttributesSet = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ── Load existing Flexco products from DB ──
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long,
             s.id AS sku_id, s.variant_name, s.vendor_sku
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.collection ILIKE '%flexco%'
      ORDER BY p.id
    `);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, 'No Flexco products found in DB — run import-triwest-832 first');
      return;
    }

    // Group by product_id
    const productMap = new Map();
    for (const row of prodResult.rows) {
      if (!productMap.has(row.product_id)) {
        productMap.set(row.product_id, {
          product_id: row.product_id,
          name: row.name,
          collection: row.collection,
          description_long: row.description_long,
          skus: [],
        });
      }
      productMap.get(row.product_id).skus.push({
        sku_id: row.sku_id,
        variant_name: row.variant_name,
        vendor_sku: row.vendor_sku,
      });
    }

    totalProducts = productMap.size;
    await appendLog(pool, job.id,
      `Found ${totalProducts} Flexco products (${prodResult.rows.length} SKUs)`);

    // Check which products already have a primary image
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.collection ILIKE '%flexco%' AND ma.asset_type = 'primary'
    `);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

    // ── Phase 1: Build website catalog ──
    await appendLog(pool, job.id, 'Phase 1: Crawling flexcofloors.com product line pages...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    const catalog = await buildCatalog(page, pool, job, delayMs);

    let totalCatalogColors = 0;
    for (const [, entry] of catalog) {
      totalCatalogColors += entry.colors.size;
    }
    await appendLog(pool, job.id,
      `Catalog built: ${catalog.size} product lines, ${totalCatalogColors} total colors`);

    await browser.close().catch(() => {});
    browser = null;

    // ── Phase 2: Match DB products & Enrich ──
    await appendLog(pool, job.id, `Phase 2: Matching ${totalProducts} products against catalog...`);

    const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
    let processed = 0;

    for (const [, product] of productMap) {
      processed++;

      // Match product to a product line
      const matchedLine = matchProductLine(product.name, catalog);

      if (!matchedLine) {
        totalSkipped++;
        continue;
      }

      const lineData = catalog.get(matchedLine);
      let productEnriched = false;

      // Enrich description (COALESCE — only if NULL)
      if (lineData.description && !product.description_long) {
        try {
          await pool.query(`
            UPDATE products SET
              description_short = COALESCE(products.description_short, $2),
              description_long = COALESCE(products.description_long, $3),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [product.product_id,
              lineData.description.slice(0, 255),
              lineData.description]);
          productEnriched = true;
        } catch (err) {
          await logError(`Description update for "${product.name}": ${err.message}`);
        }
      }

      // Process each SKU
      for (const sku of product.skus) {
        // Extract color code from variant_name (e.g., "Blush 500" → "500")
        const colorCode = extractColorCode(sku.variant_name);
        const colorMatch = colorCode ? lineData.colors.get(colorCode) : null;

        // Fallback: fuzzy match variant_name against color names
        const fallbackMatch = !colorMatch ? fuzzyMatchColor(sku.variant_name, lineData.colors) : null;
        const matchedColor = colorMatch || fallbackMatch;

        // Save image for this SKU's product (product-level, not SKU-level)
        if (matchedColor && matchedColor.imageUrl && !alreadyHaveImages.has(product.product_id)) {
          try {
            const ext = resolveImageExtension(matchedColor.imageUrl);
            const filename = `primary${ext}`;
            const destPath = `${UPLOADS_BASE}/products/${product.product_id}/${filename}`;
            const localUrl = `/uploads/products/${product.product_id}/${filename}`;

            const downloaded = await downloadImage(matchedColor.imageUrl, destPath);
            if (downloaded) {
              await upsertMediaAsset(pool, {
                product_id: product.product_id,
                sku_id: null,
                asset_type: 'primary',
                url: localUrl,
                original_url: matchedColor.imageUrl,
                sort_order: 0,
              });
              totalImagesAdded++;
              alreadyHaveImages.add(product.product_id);
              productEnriched = true;
            }
          } catch (err) {
            await logError(`Image download for "${product.name}" / "${sku.variant_name}": ${err.message}`);
          }
        }

        // Upsert spec attributes from the product line
        if (lineData.specs) {
          for (const [attrSlug, value] of Object.entries(lineData.specs)) {
            try {
              await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
              totalAttributesSet++;
              productEnriched = true;
            } catch { /* non-fatal */ }
          }
        }
      }

      if (productEnriched) totalEnriched++;
      else totalSkipped++;

      // Log progress every 100 products
      if (processed % 100 === 0) {
        await appendLog(pool, job.id,
          `Progress: ${processed}/${totalProducts} (${totalEnriched} enriched, ${totalImagesAdded} images, ${totalAttributesSet} attrs)`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Products: ${totalProducts}, Enriched: ${totalEnriched}, Skipped: ${totalSkipped}, Images: ${totalImagesAdded}, Attributes: ${totalAttributesSet}, Errors: ${errorCount}`,
      { products_found: totalProducts, products_updated: totalEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Phase 1: Crawl all known Flexco product line pages.
 * Returns Map<slug, { name, description, colors: Map<code, {colorName, imageUrl}>, specs }>
 */
async function buildCatalog(page, pool, job, delayMs) {
  const catalog = new Map();

  for (const line of PRODUCT_LINE_PAGES) {
    try {
      const url = BASE_URL + line.url;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);

      // Scroll down to trigger lazy loading
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500);

      const data = await page.evaluate(() => {
        const result = {
          name: '',
          description: '',
          colors: [],
          specs: {},
        };

        // Product line name from first heading
        const h1 = document.querySelector('h1, .et_pb_module_header');
        if (h1) result.name = h1.textContent.trim();

        // Description from main content paragraphs (skip nav/footer junk)
        const JUNK = ['newsletter', 'subscribe', 'cookie', 'privacy', 'copyright',
          'contact us', 'follow us', 'all rights reserved', 'download', 'request'];
        const paragraphs = document.querySelectorAll('.et_pb_text_inner p, .entry-content p, main p, article p');
        const descParts = [];
        for (const p of paragraphs) {
          if (p.closest('footer, header, nav, .et_pb_menu, .et_pb_footer_content')) continue;
          const text = p.textContent.trim();
          if (text.length < 20) continue;
          const lower = text.toLowerCase();
          if (JUNK.some(j => lower.includes(j))) continue;
          descParts.push(text);
          if (descParts.length >= 3) break;
        }
        result.description = descParts.join('\n\n');

        // Color gallery: Divi gallery module items
        const items = document.querySelectorAll('.et_pb_gallery_item');
        for (const item of items) {
          const a = item.querySelector('a');
          const img = item.querySelector('img');
          const title = item.querySelector('.et_pb_gallery_title, h3');
          const fullUrl = a?.href || img?.src || '';
          const colorText = title?.textContent?.trim() || img?.alt?.trim() || '';

          if (!fullUrl || !colorText) continue;

          // Parse "Blush 500" → { name: "Blush", code: "500" }
          const codeMatch = colorText.match(/^(.+?)\s+(\d{2,4})$/);
          // Strip WordPress thumbnail suffix (-400x284 etc.) from image URL
          const cleanUrl = fullUrl.replace(/-\d+x\d+(\.\w+)$/, '$1');

          result.colors.push({
            colorName: colorText,
            colorCode: codeMatch ? codeMatch[2] : '',
            imageUrl: cleanUrl.startsWith('http') ? cleanUrl : '',
          });
        }

        // Fallback: if no Divi gallery, try regular image galleries
        if (result.colors.length === 0) {
          const imgs = document.querySelectorAll('.et_pb_image img, .gallery-item img, .wp-block-gallery img');
          for (const img of imgs) {
            const src = img.src || img.dataset?.src || '';
            const alt = (img.alt || '').trim();
            if (!src || !alt) continue;
            if (src.includes('logo') || src.includes('icon')) continue;
            const codeMatch = alt.match(/^(.+?)\s+(\d{2,4})$/);
            const cleanUrl = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
            result.colors.push({
              colorName: alt,
              colorCode: codeMatch ? codeMatch[2] : '',
              imageUrl: cleanUrl.startsWith('http') ? cleanUrl : '',
            });
          }
        }

        // Spec tables — look for dt/dd, tables, or labeled spans
        const SPEC_MAP = {
          'gauge': 'gauge',
          'height': 'height',
          'heights': 'height',
          'length': 'length',
          'format': 'format',
          'thickness': 'thickness',
          'wear layer': 'wear_layer',
          'material': 'material',
          'finish': 'finish',
          'application': 'application',
          'installation': 'installation_method',
        };

        // Try dt/dd pairs
        for (const dt of document.querySelectorAll('dt, th')) {
          const label = dt.textContent.trim().toLowerCase();
          const slug = SPEC_MAP[label];
          if (!slug) continue;
          const dd = dt.tagName === 'DT' ? dt.nextElementSibling : dt.closest('tr')?.querySelector('td');
          if (dd) {
            const val = dd.textContent.trim();
            if (val && val.length < 200) result.specs[slug] = val;
          }
        }

        // Try table rows
        for (const row of document.querySelectorAll('table tr')) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 2) {
            const label = cells[0].textContent.trim().toLowerCase();
            const slug = SPEC_MAP[label];
            if (slug && !result.specs[slug]) {
              const val = cells[1].textContent.trim();
              if (val && val.length < 200) result.specs[slug] = val;
            }
          }
        }

        return result;
      });

      // Build color map keyed by code
      const colorMap = new Map();
      for (const color of data.colors) {
        if (color.colorCode && color.imageUrl) {
          colorMap.set(color.colorCode, {
            colorName: color.colorName,
            imageUrl: color.imageUrl,
          });
        }
        // Also store by full name (lowercased) for fuzzy fallback
        if (color.colorName && color.imageUrl) {
          const nameKey = color.colorName.toLowerCase().replace(/\s+\d{2,4}$/, '').trim();
          if (nameKey && !colorMap.has('name:' + nameKey)) {
            colorMap.set('name:' + nameKey, {
              colorName: color.colorName,
              imageUrl: color.imageUrl,
            });
          }
        }
      }

      catalog.set(line.slug, {
        name: data.name || line.slug,
        description: data.description || '',
        colors: colorMap,
        specs: data.specs || {},
      });

      const colorCount = data.colors.filter(c => c.imageUrl).length;
      if (colorCount > 0) {
        await appendLog(pool, job.id, `  ${line.slug}: ${colorCount} colors found`);
      } else {
        await appendLog(pool, job.id, `  ${line.slug}: no gallery colors found`);
      }

    } catch (err) {
      await appendLog(pool, job.id, `  Warning: failed to load ${line.slug}: ${err.message}`);
    }

    await delay(delayMs);
  }

  return catalog;
}

/**
 * Match a DB product name to a product line in the catalog.
 * DB product names look like "Wall Base Rr401", "Flextones Rr415".
 * Returns the matched product line slug or null.
 */
function matchProductLine(productName, catalog) {
  if (!productName) return null;

  for (const line of PRODUCT_LINE_PAGES) {
    for (const pattern of line.patterns) {
      if (pattern.test(productName)) {
        return line.slug;
      }
    }
  }

  // Fallback: try matching against the catalog entry names
  const nameLower = productName.toLowerCase();
  for (const [slug, entry] of catalog) {
    if (entry.name && nameLower.includes(entry.name.toLowerCase())) {
      return slug;
    }
  }

  return null;
}

/**
 * Extract the color code from a variant_name.
 * "Blush 500" → "500", "Cappuccino 065" → "065"
 * Returns the code string or null if no trailing digits found.
 */
function extractColorCode(variantName) {
  if (!variantName) return null;
  const match = variantName.match(/\b(\d{2,4})$/);
  return match ? match[1] : null;
}

/**
 * Fuzzy-match a variant name against the color map.
 * Tries matching the name portion (without trailing code) against color name keys.
 * Returns the matched color entry or null.
 */
function fuzzyMatchColor(variantName, colorMap) {
  if (!variantName) return null;

  // Strip trailing code: "Blush 500" → "blush"
  const nameOnly = variantName.replace(/\s+\d{2,4}$/, '').trim().toLowerCase();
  if (!nameOnly) return null;

  // Try direct name lookup
  const directMatch = colorMap.get('name:' + nameOnly);
  if (directMatch) return directMatch;

  // Try partial match against all name: keys
  for (const [key, entry] of colorMap) {
    if (!key.startsWith('name:')) continue;
    const colorName = key.slice(5);
    if (colorName.includes(nameOnly) || nameOnly.includes(colorName)) {
      return entry;
    }
  }

  return null;
}
