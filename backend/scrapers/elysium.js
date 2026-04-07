import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertInventorySnapshot,
  appendLog, addJobError, upsertMediaAsset,
  buildVariantName, preferProductShot
} from './base.js';
import { elysiumLogin, elysiumFetch, BASE_URL } from './elysium-auth.js';

const DEFAULT_CONFIG = {
  categories: [
    { name: 'Mosaic', type: 'Mosaic' },
    { name: 'Porcelain Tile', type: 'Porcelain+Tile' },
    { name: 'SPC Vinyl', type: 'SPC+Vinyl' },
    { name: 'Marble Slab', type: 'Marble+Slab' },
    { name: 'Thin Porcelain Slab 6mm', type: 'Thin+Porcelain+Slab+6mm' },
    // Quartz, Quartzite, Granite excluded — Elysium does not stock these slabs in CA
    { name: 'Ceramic Tile', type: 'Ceramic+Tile' },
    { name: 'Marble Tile', type: 'Marble+Tile' },
  ],
  delayMs: 1500,
};

// Map from the <h5 class="blue"> text on detail pages → PIM category slug.
const DETAIL_CATEGORY_MAP = {
  'Mosaic':         'mosaic-tile',
  'Porcelain Tile': 'porcelain-tile',
  'SPC':            'lvp-plank',
  'SPC Vinyl':      'lvp-plank',
  'Marble Slab':    'marble-countertops',
  'Slab':           'porcelain-slabs',
  'Quartz':         'quartz-countertops',
  'Quartzite':      'quartzite-countertops',
  'Granite':        'granite-countertops',
  'Ceramic Tile':   'ceramic-tile',
  'Marble Tile':    'natural-stone',
  'Ceramic':        'ceramic-tile',
};

// Fallback from listing page category → PIM slug
const LISTING_CATEGORY_MAP = {
  'Mosaic':                  'mosaic-tile',
  'Porcelain Tile':          'porcelain-tile',
  'SPC Vinyl':               'lvp-plank',
  'Marble Slab':             'marble-countertops',
  'Thin Porcelain Slab 6mm': 'porcelain-slabs',
  'Ceramic Tile':            'ceramic-tile',
  'Marble Tile':             'natural-stone',
};

// Max gallery images per SKU (primary + lifestyle + 6 alternate)
const MAX_GALLERY_IMAGES = 8;

// Regex to split product name from trailing size (e.g., "Aether Blue 11.50 x 12")
const SIZE_SUFFIX_RE = /^(.+?)\s+(\d+\.?\d*\s*x\s*\d+\.?\d*(?:\s*x\s*\d+\.?\d*)?)$/i;

// Known finish / shape / form words that may appear as suffix in Elysium baseName.
// Includes finishes, trim types, mosaic shapes, Italian finish terms, and surface treatments.
const SUFFIX_WORDS = [
  // English finishes
  'Matte', 'Polished', 'Honed', 'Glossy', 'Gloss', 'Satin', 'Textured', 'Natural',
  'Lappato', 'Brushed', 'Tumbled', 'Grip', 'Soft', 'Structured', 'Lux', 'Frosted',
  // Italian finishes
  'Lucido', 'Levigato', 'Naturale', 'Lapado',
  // Surface treatments
  'Saw-Cut',
  // Trim / shape / form
  'Bullnose', 'Mosaic', 'Mosaico', 'Hexagon', 'Chevron', 'Tangram',
];
const SUFFIX_RE = new RegExp(`\\s+(${SUFFIX_WORDS.join('|')})\\s*$`, 'i');

/**
 * Strip collection prefix and trailing finish/shape words from an Elysium baseName.
 * Handles multiple trailing words (e.g., "Matte Bullnose").
 * "4EVER Havana Matte" with collection "4ever" → { colorName: "Havana", finish: "Matte" }
 * "AN Dolomite Supreme Matte Bullnose" with collection "AN Dolomite" → { colorName: "Supreme", finish: "Matte Bullnose" }
 */
function splitElysiumName(baseName, collection) {
  let name = baseName;

  // Strip collection prefix (case-insensitive)
  if (collection) {
    const re = new RegExp(`^${escapeRegex(collection)}\\s+`, 'i');
    name = name.replace(re, '');
  }

  // Extract trailing finish/shape words (loop to strip multiple, e.g., "Matte Bullnose")
  const suffixes = [];
  let m;
  while ((m = name.match(SUFFIX_RE)) !== null) {
    suffixes.unshift(m[1]);
    name = name.slice(0, name.length - m[0].length).trim();
  }

  const finish = suffixes.length > 0 ? suffixes.join(' ') : null;
  return { colorName: name || baseName, finish };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Elysium Tile catalog scraper.
 *
 * Server-rendered PHP site — uses fetch, no Puppeteer.
 * Each variant on Elysium has its own page with its own images and item code.
 *
 * Modes (set via source.config.mode):
 *   'full'      — (default) Full catalog scrape: products, SKUs, images, specs, packaging, pricing, inventory
 *   'inventory' — Lightweight pass: fetches detail pages, updates only inventory_snapshots + pricing for existing SKUs
 *
 * Flow (both modes):
 *   1. List product URLs from category pages
 *   2. Fetch detail pages
 *   3. Full mode: upsert products/SKUs/images/specs/packaging/pricing/inventory + activate
 *      Inventory mode: update inventory_snapshots + pricing for existing ELY- SKUs only
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  const isInventoryMode = config.mode === 'inventory';

  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, skipped: 0, errors: 0,
    inventoryUpdated: 0, pricingUpdated: 0,
  };

  if (!isInventoryMode) {
    // Ensure all required attributes exist (idempotent)
    const requiredAttrs = [
      { name: 'Edge', slug: 'edge', display_order: 11 },
      { name: 'Look', slug: 'look', display_order: 12 },
      { name: 'Water Absorption', slug: 'water_absorption', display_order: 13 },
      { name: 'DCOF', slug: 'dcof', display_order: 14 },
    ];
    for (const attr of requiredAttrs) {
      await pool.query(`
        INSERT INTO attributes (name, slug, display_order)
        VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING
      `, [attr.name, attr.slug, attr.display_order]);
    }
  }

  // Build slug → category_id lookup (only needed for full mode)
  const categoryLookup = new Map();
  if (!isInventoryMode) {
    try {
      const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
      for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
    } catch {}
  }

  const touchedProductIds = [];

  await appendLog(pool, job.id, `Mode: ${isInventoryMode ? 'INVENTORY' : 'FULL'}`);

  // Login
  const cookies = await elysiumLogin(pool, job.id);

  // ── Phase 1: Collect product entries from listing pages ──

  const allEntries = [];
  const seenUrls = new Set();

  for (const cat of config.categories) {
    await appendLog(pool, job.id, `Scraping category: ${cat.name}`);

    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const listUrl = `/category?type=${cat.type}&order_by=name&page=${page}`;
        const resp = await elysiumFetch(listUrl, cookies);
        const html = await resp.text();

        const cardEntries = parseListingPage(html, cat.name);

        for (const entry of cardEntries) {
          if (seenUrls.has(entry.url)) continue;
          seenUrls.add(entry.url);
          allEntries.push(entry);
        }

        const nextPageRegex = new RegExp(`page=(${page + 1})`, 'g');
        hasMore = nextPageRegex.test(html) && cardEntries.length > 0;
        page++;

        await delay(config.delayMs);
      }

      await appendLog(pool, job.id, `Category ${cat.name}: ${allEntries.length} total entries`);
    } catch (err) {
      await appendLog(pool, job.id, `ERROR scraping category ${cat.name}: ${err.message}`);
      await addJobError(pool, job.id, `Category ${cat.name}: ${err.message}`);
      stats.errors++;
    }
  }

  stats.found = allEntries.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${allEntries.length} product entries`, {
    products_found: stats.found
  });

  // ── Phase 2: Fetch detail pages ──
  // Inventory mode can batch more aggressively (5 concurrent vs 3)

  const batchSize = isInventoryMode ? 5 : 3;
  await appendLog(pool, job.id, `Phase 2: Fetching detail pages (batch size ${batchSize})...`);

  const detailCache = new Map(); // url → detailData | null
  let fetchIdx = 0;

  for (let batchStart = 0; batchStart < allEntries.length; batchStart += batchSize) {
    const batch = allEntries.slice(batchStart, batchStart + batchSize);

    const batchPromises = batch.map(async (entry) => {
      try {
        const resp = await elysiumFetch(entry.url, cookies, {
          signal: AbortSignal.timeout(30000)
        });
        const html = await resp.text();

        if (!html.includes('product-title')) {
          detailCache.set(entry.url, null);
          return;
        }

        // Discontinued check — only in product content area, not nav
        const productTitleIdx = html.indexOf('product-title');
        if (productTitleIdx > 0) {
          const productInfoEnd = html.indexOf('<form action="/cart.php"');
          const productArea = productInfoEnd > productTitleIdx
            ? html.substring(productTitleIdx, productInfoEnd)
            : html.substring(productTitleIdx, productTitleIdx + 2000);
          if (/>\s*Discontinued\s*<\/(?:h[1-6]|div|span|p)/i.test(productArea) ||
              /Discontinued on \d{4}/i.test(productArea) ||
              /class="[^"]*discontinued/i.test(productArea)) {
            detailCache.set(entry.url, 'discontinued');
            return;
          }
        }

        detailCache.set(entry.url, parseDetailPage(html));
      } catch (err) {
        detailCache.set(entry.url, null);
      }
    });

    await Promise.all(batchPromises);
    fetchIdx += batch.length;

    if (fetchIdx % 150 < batchSize || fetchIdx === allEntries.length) {
      await appendLog(pool, job.id, `Fetch progress: ${fetchIdx}/${allEntries.length} pages`);
    }

    await delay(isInventoryMode ? Math.floor(config.delayMs * 0.7) : config.delayMs);
  }

  const fetchedCount = [...detailCache.values()].filter(v => v && v !== 'discontinued').length;
  const discontinuedCount = [...detailCache.values()].filter(v => v === 'discontinued').length;
  await appendLog(pool, job.id, `Fetched ${fetchedCount} detail pages, ${discontinuedCount} discontinued, ${detailCache.size - fetchedCount - discontinuedCount} empty`);

  // ── Phase 3 ──

  if (isInventoryMode) {
    // ── Inventory mode: update existing SKUs only ──
    await appendLog(pool, job.id, 'Phase 3: Updating inventory + pricing for existing SKUs...');

    // Build internal_sku → sku_id lookup for all Elysium SKUs
    const existingSkus = await pool.query(`SELECT id, internal_sku FROM skus WHERE internal_sku LIKE 'ELY-%'`);
    const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku, r.id]));
    await appendLog(pool, job.id, `Found ${skuLookup.size} existing ELY- SKUs in DB`);

    let processIdx = 0;
    for (const entry of allEntries) {
      const detail = detailCache.get(entry.url);
      if (!detail || detail === 'discontinued') {
        if (detail === 'discontinued') stats.skipped++;
        continue;
      }

      try {
        const itemCode = detail.itemCode || entry.itemCode;
        const internalSku = itemCode
          ? `ELY-${itemCode}`
          : `ELY-${entry.fullName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25)}`;

        const skuId = skuLookup.get(internalSku);
        if (!skuId) continue; // not yet in DB, skip

        // Update inventory
        if (detail.inventory.caSqft != null) {
          await upsertInventorySnapshot(pool, skuId, 'CA', {
            qty_on_hand_sqft: detail.inventory.caSqft,
            qty_in_transit_sqft: detail.inventory.caInTransitSqft || 0,
          });
          stats.inventoryUpdated++;
        }

        // Update pricing (Elysium "retail" = our cost; apply 2x markup for storefront)
        if (detail.pricing.retailPerSqft) {
          const elyCost = detail.pricing.retailPerSqft;
          await upsertPricing(pool, skuId, {
            cost: elyCost,
            retail_price: Math.round(elyCost * 2 * 100) / 100,
            price_basis: 'per_sqft',
          });
          stats.pricingUpdated++;
        }
      } catch (err) {
        stats.errors++;
      }

      processIdx++;
      if (processIdx % 200 === 0) {
        await appendLog(pool, job.id, `Inventory progress: ${processIdx}/${allEntries.length} entries, ${stats.inventoryUpdated} inventory updated`);
      }
    }

    await appendLog(pool, job.id,
      `Inventory scrape complete. Entries: ${stats.found}, ` +
      `Inventory updated: ${stats.inventoryUpdated}, Pricing updated: ${stats.pricingUpdated}, ` +
      `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
      { products_found: stats.found }
    );
  } else {
    // ── Full mode: upsert products + SKUs ──
    await appendLog(pool, job.id, 'Phase 3: Upserting products and SKUs...');

    // Group entries by baseName → one product per group
    const productGroups = new Map();
    for (const entry of allEntries) {
      if (!productGroups.has(entry.baseName)) {
        productGroups.set(entry.baseName, { entries: [], listingCategory: entry.listingCategory });
      }
      productGroups.get(entry.baseName).entries.push(entry);
    }

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products`);

    let groupIdx = 0;
    const groupEntries = Array.from(productGroups.entries());

    for (const [baseName, group] of groupEntries) {
      try {
        // Collect detail data for all entries in this group
        const variantData = []; // { entry, detail }
        for (const entry of group.entries) {
          const detail = detailCache.get(entry.url);
          if (detail && detail !== 'discontinued') {
            variantData.push({ entry, detail });
          } else if (detail === 'discontinued') {
            stats.skipped++;
          }
        }

        if (variantData.length === 0) continue;

        // Product-level data from first variant with content
        const firstDetail = variantData[0].detail;

        // Resolve category from detail page h5.blue, fallback to listing category
        const detailCatSlug = firstDetail.detailCategory
          ? DETAIL_CATEGORY_MAP[firstDetail.detailCategory]
          : null;
        const listingCatSlug = LISTING_CATEGORY_MAP[group.listingCategory];
        const categorySlug = detailCatSlug || listingCatSlug || null;
        const categoryId = categorySlug ? (categoryLookup.get(categorySlug) || null) : null;

        // Merge descriptions — use longest across variants
        let bestDescription = firstDetail.description || '';
        for (const { detail } of variantData) {
          if (detail.description && detail.description.length > bestDescription.length) {
            bestDescription = detail.description;
          }
        }

        // Split baseName: strip collection prefix + trailing finish
        const collectionForProduct = firstDetail.collection || '';
        const { colorName: productColorName, finish: extractedFinish } = splitElysiumName(baseName, collectionForProduct);

        // Upsert product — name is color only (e.g., "Havana"), collection is series (e.g., "4ever")
        const product = await upsertProduct(pool, {
          vendor_id,
          name: productColorName,
          collection: collectionForProduct,
          category_id: categoryId,
          description_short: bestDescription ? bestDescription.slice(0, 255) : null,
          description_long: bestDescription || null,
        });

        if (product.is_new) stats.created++;
        else stats.updated++;
        touchedProductIds.push(product.id);

        // Product-level primary image: collect from ALL variants, pick best product shot
        const allColorUrls = [];
        const seenBases = new Set();
        for (const { detail: d } of variantData) {
          for (const img of d.galleryImages) {
            const imgUrl = img.url1000 || img.url750;
            const fullUrl = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
            const base = fullUrl.split('?')[0];
            if (!seenBases.has(base)) { seenBases.add(base); allColorUrls.push(fullUrl); }
          }
        }
        const sortedUrls = preferProductShot(allColorUrls, productColorName);
        if (sortedUrls.length > 0) {
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: 'primary',
            url: sortedUrls[0],
            original_url: sortedUrls[0],
            sort_order: 0,
          });
          stats.imagesSet++;
        }

        // Catalog PDF (product-level, from first variant that has one)
        for (const { detail } of variantData) {
          if (detail.catalogPdf) {
            const pdfUrl = detail.catalogPdf.startsWith('http')
              ? detail.catalogPdf
              : `${BASE_URL}${detail.catalogPdf}`;
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: null,
              asset_type: 'spec_pdf',
              url: pdfUrl,
              original_url: pdfUrl,
              sort_order: 99,
            });
            break; // one PDF per product is enough
          }
        }

        // Upsert each variant as its own SKU with its own images
        for (let vi = 0; vi < variantData.length; vi++) {
          const { entry, detail } = variantData[vi];

          const itemCode = detail.itemCode || entry.itemCode;
          const vendorSku = itemCode || entry.fullName;
          const internalSku = itemCode
            ? `ELY-${itemCode}`
            : `ELY-${entry.fullName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25)}`;

          // Build variant name: size + finish (from name or detail page)
          const variantFinish = extractedFinish || detail.finish || null;
          const variantName = buildVariantName(entry.size, variantFinish);

          // Determine sell_by from detail page, default to 'sqft'
          const sellBy = detail.soldBy || 'sqft';

          const sku = await upsertSku(pool, {
            product_id: product.id,
            vendor_sku: vendorSku,
            internal_sku: internalSku,
            variant_name: variantName,
            sell_by: sellBy,
          });
          if (sku.is_new) stats.skusCreated++;

          // ── Packaging ──
          if (detail.packaging && Object.keys(detail.packaging).length > 0) {
            const pkg = detail.packaging;
            await upsertPackaging(pool, sku.id, {
              sqft_per_box: pkg.sqftPerBox || null,
              pieces_per_box: pkg.piecesPerBox || null,
              weight_per_box_lbs: pkg.weightPerBox || null,
              boxes_per_pallet: pkg.boxesPerPallet || null,
              sqft_per_pallet: pkg.sqftPerPallet || null,
              weight_per_pallet_lbs: pkg.weightPerPallet || null,
            });
          }

          // ── Pricing (Elysium "retail" = our cost; apply 2x markup) ──
          if (detail.pricing.retailPerSqft) {
            const elyCost = detail.pricing.retailPerSqft;
            await upsertPricing(pool, sku.id, {
              cost: elyCost,
              retail_price: Math.round(elyCost * 2 * 100) / 100,
              price_basis: sellBy === 'unit' ? 'per_unit' : 'per_sqft',
            });
          }

          // ── Inventory (CA warehouse) ──
          if (detail.inventory.caSqft != null) {
            await upsertInventorySnapshot(pool, sku.id, 'CA', {
              qty_on_hand_sqft: detail.inventory.caSqft,
              qty_in_transit_sqft: detail.inventory.caInTransitSqft || 0,
            });
          }

          // ── SKU attributes (expanded) ──
          if (entry.size) await upsertSkuAttribute(pool, sku.id, 'size', entry.size);
          if (detail.specs.colors) await upsertSkuAttribute(pool, sku.id, 'color', detail.specs.colors);
          if (detail.specs.type) await upsertSkuAttribute(pool, sku.id, 'material', detail.specs.type);
          if (detail.finish) await upsertSkuAttribute(pool, sku.id, 'finish', detail.finish);
          if (detail.specs.thickness) await upsertSkuAttribute(pool, sku.id, 'thickness', detail.specs.thickness);
          if (detail.specs.countryOfOrigin) await upsertSkuAttribute(pool, sku.id, 'country', detail.specs.countryOfOrigin);
          if (detail.specs.edge) await upsertSkuAttribute(pool, sku.id, 'edge', detail.specs.edge);
          if (detail.specs.look) await upsertSkuAttribute(pool, sku.id, 'look', detail.specs.look);
          if (detail.technicalSpecs.application) await upsertSkuAttribute(pool, sku.id, 'application', detail.technicalSpecs.application);
          if (detail.technicalSpecs.peiRating) await upsertSkuAttribute(pool, sku.id, 'pei_rating', detail.technicalSpecs.peiRating);
          if (detail.technicalSpecs.shadeVariation) await upsertSkuAttribute(pool, sku.id, 'shade_variation', detail.technicalSpecs.shadeVariation);
          if (detail.technicalSpecs.waterAbsorption) await upsertSkuAttribute(pool, sku.id, 'water_absorption', detail.technicalSpecs.waterAbsorption);
          if (detail.technicalSpecs.dcof) await upsertSkuAttribute(pool, sku.id, 'dcof', detail.technicalSpecs.dcof);

          // ── Per-variant images: stored with sku_id (capped at MAX_GALLERY_IMAGES) ──
          const gallery = detail.galleryImages;
          if (gallery.length > 0) {
            // Use sort_order offset per variant so they don't collide on the
            // (product_id, asset_type, sort_order) unique constraint.
            const sortBase = vi * 100;

            // Sort images so product shots come first
            const varUrls = gallery.map(img => {
              const u = img.url1000 || img.url750;
              return u.startsWith('http') ? u : `${BASE_URL}${u}`;
            });
            const sortedVarUrls = preferProductShot(varUrls, productColorName);

            for (let gi = 0; gi < sortedVarUrls.length; gi++) {
              const fullUrl = sortedVarUrls[gi];
              const assetType = gi === 0 ? 'primary' : 'alternate';

              await upsertMediaAsset(pool, {
                product_id: product.id,
                sku_id: sku.id,
                asset_type: assetType,
                url: fullUrl,
                original_url: fullUrl,
                sort_order: sortBase + gi,
              });
              stats.imagesSet++;
            }
          } else if (entry.thumbUrl) {
            // Fallback: upgrade listing thumbnail to /1000/
            const fallbackUrl = entry.thumbUrl.replace('/200/200_', '/1000/1000_');
            const absUrl = fallbackUrl.startsWith('http') ? fallbackUrl : `${BASE_URL}${fallbackUrl}`;
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: sku.id,
              asset_type: 'primary',
              url: absUrl,
              original_url: absUrl,
              sort_order: vi * 100,
            });
            stats.imagesSet++;
          }
        }
      } catch (err) {
        await appendLog(pool, job.id, `ERROR ${baseName}: ${err.message}`);
        await addJobError(pool, job.id, `Product ${baseName}: ${err.message}`);
        stats.errors++;
      }

      groupIdx++;
      if (groupIdx % 100 === 0 || groupIdx === groupEntries.length) {
        await appendLog(pool, job.id, `Upsert progress: ${groupIdx}/${groupEntries.length} products`, {
          products_found: stats.found,
          products_created: stats.created,
          products_updated: stats.updated,
          skus_created: stats.skusCreated,
        });
      }
    }

    // ── Phase 4: Bulk activate ──

    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products`);
    }

    await appendLog(pool, job.id,
      `Scrape complete. Products: ${stats.created} new / ${stats.updated} updated, ` +
      `SKUs: ${stats.skusCreated}, Images: ${stats.imagesSet}, ` +
      `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
      {
        products_found: stats.found,
        products_created: stats.created,
        products_updated: stats.updated,
        skus_created: stats.skusCreated,
      }
    );
  }
}

/**
 * Parse listing page HTML to extract product entries.
 */
function parseListingPage(html, listingCategory) {
  const entries = [];

  const cardRegex = /<a\s+href="\/product\?id=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const productId = match[1];
    const cardContent = match[2];

    if (/Discontinued/i.test(cardContent) || /Coming Soon/i.test(cardContent)) {
      continue;
    }

    const fullName = decodeURIComponent(productId.replace(/\+/g, ' ')).trim();
    if (/\bsample\b/i.test(fullName)) continue;

    const thumbMatch = cardContent.match(/src="([^"]*\/static\/images\/product\/200\/[^"]+)"/);
    const thumbUrl = thumbMatch ? thumbMatch[1] : null;

    let itemCode = null;
    if (thumbUrl) {
      const idMatch = thumbUrl.match(/\/200_(\d+)-/);
      if (idMatch) itemCode = idMatch[1];
    }

    const sizeMatch = fullName.match(SIZE_SUFFIX_RE);
    const baseName = sizeMatch ? sizeMatch[1].trim() : fullName;
    const size = sizeMatch ? sizeMatch[2].trim() : null;

    entries.push({
      fullName,
      baseName,
      size,
      url: `/product?id=${productId}`,
      listingCategory,
      thumbUrl,
      itemCode,
    });
  }

  return entries;
}

/**
 * Parse a product detail page (authenticated).
 * Extracts all available data: title, item code, category (from h5.blue),
 * collection, finish, trims, description, gallery images at /1000/ + /750/,
 * catalog PDF, vendor product_id, specs, technical specs, packaging,
 * inventory, pricing, sold-by, stock status, and ETA.
 */
function parseDetailPage(html) {
  const result = {
    title: null,
    itemCode: null,
    detailCategory: null,
    collection: null,
    finish: null,
    trims: null,
    description: null,
    vendorProductId: null,
    catalogPdf: null,
    galleryImages: [],
    specs: {},
    technicalSpecs: {},
    packaging: {},
    inventory: { caSqft: null },
    pricing: { retailPerSqft: null },
    soldBy: null,
    stockStatus: null,
    etaText: null,
  };

  const titleMatch = html.match(/class="product-title">\s*([\s\S]*?)\s*<\/div>/)
                  || html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/);
  if (titleMatch) result.title = stripTags(titleMatch[1]).trim();

  const blueH5 = html.match(/<h5[^>]*class="blue"[^>]*>\s*([\s\S]*?)\s*<\/h5>/);
  if (blueH5) result.detailCategory = stripTags(blueH5[1]).trim();

  const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
  if (codeMatch) result.itemCode = codeMatch[1].trim();

  const prodIdMatch = html.match(/name="product_id"\s+value="(\d+)"/);
  if (prodIdMatch) result.vendorProductId = prodIdMatch[1];

  const collMatch = html.match(/<h4>([^<]+?)\s+Collection<\/h4>/i);
  if (collMatch) result.collection = collMatch[1].trim();

  const finishMatch = html.match(/available finish(?:es)?:\s*([^<\n]+)/i);
  if (finishMatch) result.finish = finishMatch[1].trim();

  const trimsMatch = html.match(/available trims:\s*([^<\n]+)/i);
  if (trimsMatch) result.trims = trimsMatch[1].trim();

  const pdfMatch = html.match(/href="([^"]*products-pdf[^"]*\.pdf)"/i);
  if (pdfMatch) result.catalogPdf = pdfMatch[1];

  const descMatch = html.match(/id="description"[^>]*>([\s\S]*?)(?:<div id="detailDescription|<div style="padding)/);
  if (descMatch) {
    let desc = descMatch[1]
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (desc) result.description = desc;
  }

  // ── Specification tab ──
  const specSection = html.match(/id="specification"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<\/div>|<div[^>]*id="packaging")/);
  if (specSection) {
    const specHtml = specSection[1];
    // Parse all <th>...</th><td>...</td> pairs
    const thTdPairs = [...specHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)];

    // Spec field name → result key mapping
    const specFieldMap = {
      'collection': 'collection',
      'type': 'type',
      'thickness': 'thickness',
      'weight per piece': 'weightPerPiece',
      'edge': 'edge',
      'country of origin': 'countryOfOrigin',
      'look': 'look',
      'finish': 'finish',
      'colors': 'colors',
    };
    const techFieldMap = {
      'application': 'application',
      'abrasion resistance': 'abrasionResistance',
      'breaking strength': 'breakingStrength',
      'dcof acutest': 'dcof',
      'dcof': 'dcof',
      'din 51130': 'din51130',
      'frost resistant': 'frostResistant',
      'mohs': 'mohs',
      'pei rating': 'peiRating',
      'shade variation': 'shadeVariation',
      'staining resistance': 'stainingResistance',
      'thermal shock': 'thermalShock',
      'type of porcelain': 'typeOfPorcelain',
      'water absorption': 'waterAbsorption',
    };

    // Detect where technical specs start (colspan="2" header)
    let inTechnical = false;

    for (const pair of thTdPairs) {
      const rawLabel = stripTags(pair[1]).trim().toLowerCase();
      const rawValue = stripTags(pair[2]).replace(/\s+/g, ' ').trim();

      if (rawLabel === 'technical specification' || rawLabel === 'technical specifications') {
        inTechnical = true;
        continue;
      }
      if (!rawValue) continue;

      if (!inTechnical && specFieldMap[rawLabel]) {
        result.specs[specFieldMap[rawLabel]] = rawValue;
      } else if (inTechnical && techFieldMap[rawLabel]) {
        result.technicalSpecs[techFieldMap[rawLabel]] = rawValue;
      } else if (techFieldMap[rawLabel]) {
        // Some pages don't have colspan header, try tech map as fallback
        result.technicalSpecs[techFieldMap[rawLabel]] = rawValue;
      }
    }

    // Override collection/finish from spec tab if present (more reliable)
    if (result.specs.finish) result.finish = result.specs.finish;
    if (result.specs.collection && !result.collection) result.collection = result.specs.collection;
  }

  // ── Packaging tab ──
  const pkgSection = html.match(/id="packaging"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<\/div>|<div[^>]*id=")/);
  if (pkgSection) {
    const pkgHtml = pkgSection[1];
    const pkgPairs = [...pkgHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)];

    for (const pair of pkgPairs) {
      const label = stripTags(pair[1]).trim().toLowerCase();
      const rawVal = stripTags(pair[2]).replace(/\s+/g, ' ').trim();

      if (label.includes('pieces per box')) {
        result.packaging.piecesPerBox = parseInt(rawVal) || null;
      } else if (label.includes('square feet per box') || label.includes('sqft per box')) {
        result.packaging.sqftPerBox = parseFloat(rawVal) || null;
      } else if (label.includes('weight per box')) {
        result.packaging.weightPerBox = parseFloat(rawVal.replace(/[^0-9.]/g, '')) || null;
      } else if (label.includes('box label')) {
        result.packaging.boxLabel = rawVal || null;
      } else if (label.includes('boxes per pallet')) {
        result.packaging.boxesPerPallet = parseInt(rawVal) || null;
      } else if (label.includes('sqft per pallet') || label.includes('square feet per pallet')) {
        result.packaging.sqftPerPallet = parseFloat(rawVal.replace(/[^0-9.]/g, '')) || null;
      } else if (label.includes('weight per pallet')) {
        // Value may be inside an <a> tag and comma-formatted: "2,650.00 lbs."
        const weightStr = stripTags(pair[2]).replace(/,/g, '').trim();
        result.packaging.weightPerPallet = parseFloat(weightStr.replace(/[^0-9.]/g, '')) || null;
      }
    }
  }

  // ── Inventory (CA warehouse only) ──
  const caInvMatch = html.match(/CA\s*-\s*\(([\d,]+)\s*SqFt\)/);
  if (caInvMatch) {
    result.inventory.caSqft = parseInt(caInvMatch[1].replace(/,/g, '')) || 0;
  }

  // ── ETA (incoming shipment for CA) ──
  const etaMatch = html.match(/ETA\s+CA:\s*([^<\n]+)/i);
  if (etaMatch) {
    result.etaText = etaMatch[1].trim();
    // Parse incoming sqft from ETA text like "03/18/26 [9,765 sf]"
    const etaSqftMatch = result.etaText.match(/\[([\d,]+)\s*sf\]/i);
    if (etaSqftMatch) {
      result.inventory.caInTransitSqft = parseInt(etaSqftMatch[1].replace(/,/g, '')) || 0;
    }
  }

  // ── Pricing ──
  const priceMatch = html.match(/\$([\d.]+)\s*Per SqFt/i);
  if (priceMatch) {
    result.pricing.retailPerSqft = parseFloat(priceMatch[1]) || null;
  }

  // ── Sold By ──
  const soldByMatch = html.match(/Product Sold By ([^<\n]+)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].trim().toLowerCase();
    if (raw.includes('box')) result.soldBy = 'sqft';
    else if (raw.includes('sqft') || raw.includes('sq ft') || raw.includes('square')) result.soldBy = 'sqft';
    else if (raw.includes('piece')) result.soldBy = 'unit';
    else result.soldBy = 'sqft'; // default
  }

  // ── Stock Status ──
  const stockMatch = html.match(/font-weight:\s*bold[^>]*>\s*(In Stock|Out of Stock|Coming Soon)\s*</i);
  if (stockMatch) {
    result.stockStatus = stockMatch[1].trim();
  }

  // ── Gallery images from id="img_N" tags ──
  const galleryImgs = [...html.matchAll(/id="img_(\d+)"\s+src="([^"]+)"/g)];

  // Build /1000/ lookup
  const img1000Map = new Map();
  const all1000 = [...html.matchAll(/src="(\/static\/images\/product\/1000\/[^"]+)"/g)];
  for (const m of all1000) {
    const base = m[1].replace('/static/images/product/1000/1000_', '');
    img1000Map.set(base, m[1]);
  }

  // Deduplicate by base filename and cap at MAX_GALLERY_IMAGES
  const seenBases = new Set();
  for (const m of galleryImgs) {
    const url750 = m[2];
    const base750 = url750.replace(/^.*\/750\/750_/, '');
    if (seenBases.has(base750)) continue;
    seenBases.add(base750);
    const url1000 = img1000Map.get(base750) || null;
    result.galleryImages.push({ url750, url1000 });
  }

  // Fallback to any /750/ images if no gallery found
  if (result.galleryImages.length === 0) {
    const fallback750 = [...html.matchAll(/src="(\/static\/images\/product\/750\/[^"]+)"/g)];
    const seen = new Set();
    for (const m of fallback750) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const base = m[1].replace('/static/images/product/750/750_', '');
      const url1000 = img1000Map.get(base) || null;
      result.galleryImages.push({ url750: m[1], url1000 });
    }
  }

  // Cap gallery images at 8 (primary + lifestyle + 6 alternate)
  if (result.galleryImages.length > MAX_GALLERY_IMAGES) {
    result.galleryImages = result.galleryImages.slice(0, MAX_GALLERY_IMAGES);
  }

  return result;
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
