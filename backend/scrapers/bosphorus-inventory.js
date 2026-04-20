import {
  delay, upsertPricing, upsertInventorySnapshot, upsertPackaging,
  appendLog, addJobError, normalizeSize
} from './base.js';
import { bosphorusLogin, bosphorusLoginFromCookies, bosphorusFetch, BASE_URL } from './bosphorus-auth.js';

/**
 * Bosphorus Imports inventory scraper (authenticated).
 *
 * Logs into the Bosphorus dealer portal, then fetches product detail pages
 * to extract pricing, stock quantities, and warehouse data from the
 * authenticated variant_groups JavaScript object.
 *
 * When logged in, variant_groups includes:
 *   - Price: dealer cost per unit
 *   - StockStatus: 0=OOS, 2=in-stock
 *   - TotalStock: total available stock (sqft or units)
 *   - WarehouseQty: per-warehouse breakdown
 *   - SQFT: sqft per unit
 *   - SoldAs: 'box' | 'piece'
 *
 * Modes (set via source.config.mode):
 *   'inventory' (default): Update pricing + inventory for existing BOS-* SKUs
 *   'full': Also fetch packaging data from specs tables
 *
 * Requires:
 *   BOSPHORUS_USERNAME + BOSPHORUS_PASSWORD env vars (Puppeteer login)
 *   OR BOSPHORUS_COOKIES env var (pre-exported cookie string/file)
 */

const DEFAULT_DELAY_MS = 1000;
const MAX_PAGES = 10;

export async function run(pool, job, source) {
  const config = { delayMs: DEFAULT_DELAY_MS, ...(source.config || {}) };
  const isFullMode = config.mode === 'full';

  const stats = {
    found: 0, pricingUpdated: 0, inventoryUpdated: 0,
    packagingUpdated: 0, skipped: 0, errors: 0,
    noMatch: 0,
  };

  // ── Login ──
  let cookies;
  try {
    if (process.env.BOSPHORUS_COOKIES) {
      cookies = await bosphorusLoginFromCookies(pool, job.id);
    } else {
      cookies = await bosphorusLogin(pool, job.id);
    }
  } catch (err) {
    await addJobError(pool, job.id, `Login failed: ${err.message}`);
    throw err;
  }

  // ── Build internal_sku → sku_id lookup for existing Bosphorus SKUs ──
  const existingSkus = await pool.query(`SELECT id, internal_sku, vendor_sku FROM skus WHERE internal_sku LIKE 'bos-%' OR internal_sku LIKE 'BOS-%'`);
  const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku.toLowerCase(), r.id]));
  await appendLog(pool, job.id, `Found ${skuLookup.size} existing BOS-* SKUs in DB`);

  // Also build a vendor_sku lookup for matching by vendor SKU
  const vendorSkuLookup = new Map();
  for (const row of existingSkus.rows) {
    if (row.vendor_sku) {
      vendorSkuLookup.set(row.vendor_sku.toUpperCase(), row.id);
    }
  }

  // ── Phase 1: Collect product detail URLs ──
  await appendLog(pool, job.id, 'Phase 1: Collecting product URLs...');

  const productUrls = [];
  const seenSlugs = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const resp = await bosphorusFetch(`/products?page=${page}`, cookies);
      const html = await resp.text();

      const links = extractProductLinks(html);
      if (links.length === 0) break;

      for (const link of links) {
        const slug = link.replace(/.*\/product-detail\//, '');
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        productUrls.push(link.startsWith('http') ? link : `${BASE_URL}${link}`);
      }

      const nextPagePattern = new RegExp(`page=${page + 1}`);
      if (!nextPagePattern.test(html)) break;

      await delay(config.delayMs);
    } catch (err) {
      await addJobError(pool, job.id, `Listing page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }
  }

  stats.found = productUrls.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${productUrls.length} product pages`, {
    products_found: stats.found,
  });

  // ── Phase 2: Fetch detail pages and update inventory/pricing ──
  await appendLog(pool, job.id, 'Phase 2: Fetching detail pages and updating inventory...');

  for (let i = 0; i < productUrls.length; i++) {
    const url = productUrls[i];

    try {
      const resp = await bosphorusFetch(url, cookies, {
        signal: AbortSignal.timeout(30000),
      });
      const html = await resp.text();

      const data = parseDetailForInventory(html);
      if (!data || !data.name) {
        stats.skipped++;
        continue;
      }

      // Process each variant
      for (const variant of data.variants) {
        try {
          // Build the internal SKU that the catalog scraper would have created
          const sizeNorm = normalizeSize(variant.size);
          const internalSku = buildInternalSku(data.name, variant.color, sizeNorm, variant.finish);
          const internalSkuLower = internalSku.toLowerCase();

          // Try to find matching SKU
          let skuId = skuLookup.get(internalSkuLower);

          // Fallback: try vendor SKU match
          if (!skuId && variant.vendorSku) {
            skuId = vendorSkuLookup.get(variant.vendorSku.toUpperCase());
          }

          if (!skuId) {
            stats.noMatch++;
            continue;
          }

          // Update pricing
          if (variant.price > 0) {
            const sellBy = determineSellBy(variant.size, variant.sizeLabel);
            await upsertPricing(pool, skuId, {
              cost: variant.netPrice || variant.price,
              retail_price: variant.listPrice || 0,
              price_basis: sellBy === 'sqft' ? 'per_sqft' : 'per_unit',
            });
            stats.pricingUpdated++;
          }

          // Update inventory — prefer WarehouseQty if available, fall back to TotalStock
          const stockQty = variant.warehouseQty
            ? parseFloat(variant.warehouseQty)
            : (parseFloat(variant.totalStock) || 0);
          await upsertInventorySnapshot(pool, skuId, 'Bosphorus-Anaheim', {
            qty_on_hand_sqft: stockQty || 0,
            qty_in_transit_sqft: 0,
          });
          stats.inventoryUpdated++;

          // Update packaging if in full mode and specs available
          if (isFullMode) {
            const sqftPerBox = data.specs?.sqftPerBox || variant.sqft || null;
            if (sqftPerBox || data.specs?.piecesPerBox) {
              await upsertPackaging(pool, skuId, {
                sqft_per_box: sqftPerBox,
                pieces_per_box: data.specs?.piecesPerBox || null,
                weight_per_box_lbs: data.specs?.boxWeight || null,
                boxes_per_pallet: data.specs?.palletCount || null,
                sqft_per_pallet: data.specs?.sqftPerPallet || null,
                weight_per_pallet_lbs: data.specs?.palletWeight || null,
              });
              stats.packagingUpdated++;
            }
          }
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id,
              `${data.name} / ${variant.color} ${variant.size}: ${err.message}`
            );
          }
        }
      }
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `${url}: ${err.message}`);
      }
    }

    if ((i + 1) % 10 === 0 || i === productUrls.length - 1) {
      await appendLog(pool, job.id,
        `Progress: ${i + 1}/${productUrls.length}, ` +
        `Pricing: ${stats.pricingUpdated}, Inventory: ${stats.inventoryUpdated}, ` +
        `No match: ${stats.noMatch}, Errors: ${stats.errors}`
      );
    }

    await delay(config.delayMs);
  }

  await appendLog(pool, job.id,
    `Inventory scrape complete. Products: ${stats.found}, ` +
    `Pricing updated: ${stats.pricingUpdated}, Inventory updated: ${stats.inventoryUpdated}, ` +
    `Packaging: ${stats.packagingUpdated}, No match: ${stats.noMatch}, ` +
    `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
    { products_found: stats.found }
  );
}

// ─── Listing page parser ──────────────────────────────────────────────────────

function extractProductLinks(html) {
  const links = [];
  const seen = new Set();
  const regex = /href="([^"]*\/product-detail\/[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }
  return links;
}

// ─── Detail page parser (inventory-focused) ──────────────────────────────────

function parseDetailForInventory(html) {
  const result = {
    name: null,
    variants: [],
    specs: {},
  };

  // ── Product name from JSON-LD ──
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const tag of jsonLdMatch) {
      try {
        const content = tag.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(content);
        if (data['@type'] === 'ProductGroup' || data['@type'] === 'Product') {
          result.name = data.name || null;
        }
      } catch {}
    }
  }

  if (!result.name) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1Match) result.name = stripTags(h1Match[1]).trim();
  }

  // ── Parse color/size/finish select options ──
  const colors = parseSelectOptions(html, 'Color');
  const sizes = parseSelectOptions(html, 'Size');
  const finishes = parseSelectOptions(html, 'Finish');

  const colorById = new Map(colors.map(c => [c.id, c.text]));
  const sizeById = new Map(sizes.map(s => [s.id, s.text]));
  const finishById = new Map(finishes.map(f => [f.id, f.text]));

  // ── Parse variant_groups ──
  const variantMatch = html.match(/variant_groups\s*=\s*(\{[\s\S]*?\});/);
  if (variantMatch) {
    try {
      const variantObj = JSON.parse(variantMatch[1]);
      for (const [key, val] of Object.entries(variantObj)) {
        const ids = key.split('-');
        const colorId = ids[0] || null;
        const sizeId = ids[1] || null;
        const finishId = ids[2] || null;

        const color = colorById.get(colorId) || extractField(val.record_variants_name, 'color');
        const size = sizeById.get(sizeId) || extractField(val.record_variants_name, 'size');
        const sizeLabel = sizeById.get(sizeId) || '';
        const finish = finishById.get(finishId) || extractField(val.record_variants_name, 'finish');

        // Price: net dealer price (top-level). PriceData has list/net breakdown.
        const dealerPrice = parseFloat(val.Price) || 0;
        const listPrice = val.PriceData ? (parseFloat(val.PriceData.price) || 0) : 0;
        const netPrice = val.PriceData ? (parseFloat(val.PriceData.net_price) || dealerPrice) : dealerPrice;

        result.variants.push({
          color: color || 'Default',
          size: size || '',
          sizeLabel,
          finish: finish || null,
          vendorSku: null,
          price: dealerPrice,
          listPrice,
          netPrice,
          stockStatus: parseInt(val.StockStatus, 10),
          totalStock: val.TotalStock || '0',
          sqft: val.SQFT ? parseFloat(val.SQFT) : null,
          warehouseQty: val.WarehouseQty || null,
          minQuantity: val.MinQuantity ? parseInt(val.MinQuantity, 10) : null,
          soldAs: val.SoldAs || 'box',
        });
      }
    } catch {}
  }

  // ── Parse specs for packaging data ──
  const specsRegex = /<tr[^>]*>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<\/tr>/gi;
  let specMatch;
  while ((specMatch = specsRegex.exec(html)) !== null) {
    const label = stripTags(specMatch[1]).trim().toLowerCase();
    const value = stripTags(specMatch[2]).trim();
    if (!value) continue;

    if (label.includes('box weight')) result.specs.boxWeight = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('sq ft per box') || label.includes('sqft per box')) result.specs.sqftPerBox = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('box count') || label.includes('pieces per box')) result.specs.piecesPerBox = parseInt(value) || null;
    else if (label.includes('pallet weight')) result.specs.palletWeight = parseFloat(value.replace(/[^0-9.,]/g, '').replace(',', '')) || null;
    else if (label.includes('sq ft per pallet') || label.includes('sqft per pallet')) result.specs.sqftPerPallet = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('pallet count') || label.includes('boxes per pallet')) result.specs.palletCount = parseInt(value) || null;
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseSelectOptions(html, attributeName) {
  const options = [];

  // New site layout (Sep 2025+): swatch labels instead of <select> dropdowns
  const swatchSectionRegex = new RegExp(
    `(?:<strong>|<label[^>]*>)[^<]*${attributeName}[^<]*(?:</strong>|</label>)([\\s\\S]*?)(?=<strong>|<label[^>]*>[^<]*(?:Color|Size|Finish)[^<]*</label>|$)`,
    'i'
  );
  const sectionMatch = html.match(swatchSectionRegex);

  if (sectionMatch) {
    const sectionHtml = sectionMatch[1];
    const labelRegex = /<label[^>]*data-product-attribute-value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g;
    let lMatch;
    while ((lMatch = labelRegex.exec(sectionHtml)) !== null) {
      const id = lMatch[1];
      const inner = lMatch[2];
      const nameMatch = inner.match(/<p[^>]*class="variant-name-value"[^>]*>([^<]+)<\/p>/)
        || inner.match(/<span[^>]*class="form-option-expanded"[^>]*>([^<]+)<\/span>/)
        || inner.match(/<span[^>]*>([^<]+)<\/span>/);
      const text = nameMatch ? nameMatch[1].trim() : stripTags(inner).trim();
      if (text && !options.find(o => o.id === id)) {
        options.push({ id, text });
      }
    }
  }

  // Legacy fallback: <select> dropdowns (pre-Sep 2025)
  if (options.length === 0) {
    const selectRegex = new RegExp(
      `<label[^>]*>[^<]*${attributeName}[^<]*<\\/label>[\\s\\S]*?<select[^>]*>([\\s\\S]*?)<\\/select>`,
      'i'
    );
    const selectMatch = html.match(selectRegex);
    if (selectMatch) {
      const selectHtml = selectMatch[1];
      const optionRegex = /data-product-attribute-value="(\d+)"[^>]*>([^<]+)</g;
      let optMatch;
      while ((optMatch = optionRegex.exec(selectHtml)) !== null) {
        options.push({ id: optMatch[1], text: optMatch[2].trim() });
      }
    }
  }

  return options;
}

function extractField(variantName, field) {
  if (!variantName) return null;
  const clean = variantName.replace(/\\"/g, '"');

  if (field === 'size') {
    const sizeMatch = clean.match(/(\d+(?:\.?\d*)?"?\s*x\s*\d+(?:\.?\d*)?"?)/i);
    return sizeMatch ? sizeMatch[1].trim() : null;
  }
  if (field === 'color') {
    const parts = clean.split(/\d+(?:\.?\d*)?"?\s*x\s*\d+/i);
    return parts[0] ? parts[0].trim() : null;
  }
  if (field === 'finish') {
    const sizeIdx = clean.search(/\d+(?:\.?\d*)?"?\s*x\s*\d+/i);
    if (sizeIdx < 0) return null;
    const afterSize = clean.slice(sizeIdx).replace(/\d+(?:\.?\d*)?"?\s*x\s*\d+(?:\.?\d*)?"?/i, '').trim();
    const finishPart = afterSize
      .replace(/\b(Porcelain|Surface|Bullnose|Mosaic|Mosaics)\b/gi, '')
      .trim();
    return finishPart || null;
  }
  return null;
}

function buildInternalSku(collection, color, size, finish) {
  const parts = ['BOS', slugify(collection), slugify(color)];
  if (size) parts.push(slugify(size));
  if (finish) parts.push(slugify(finish));
  return parts.join('-');
}

function determineSellBy(size, sizeLabel) {
  const label = (sizeLabel || '').toLowerCase();
  if (label.includes('mosaic') || label.includes('bullnose') || label.includes('surface')) {
    return 'unit';
  }

  const normalized = normalizeSize(size);
  if (!normalized) return 'sqft';

  const match = normalized.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!match) return 'sqft';

  const dim1 = parseFloat(match[1]);
  const dim2 = parseFloat(match[2]);
  const maxDim = Math.max(dim1, dim2);
  const minDim = Math.min(dim1, dim2);

  if (maxDim <= 4) return 'unit';
  if (minDim <= 3 && maxDim >= 12) return 'unit';

  return 'sqft';
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripTags(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
