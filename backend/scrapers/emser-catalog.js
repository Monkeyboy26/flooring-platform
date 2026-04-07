import {
    upsertMediaAsset, upsertSkuAttribute,
    appendLog, addJobError, preferProductShot, isLifestyleUrl
} from './base.js';

/**
 * Emser Tile catalog enrichment scraper.
 *
 * Uses the Optimizely/Insite JSON REST API on emser.com to fetch all ~3,050
 * products with images, then matches by productNumber → vendor_sku to enrich
 * existing 832 EDI data. Never creates new products or SKUs.
 *
 * After SKU-matched enrichment, runs three fallback passes:
 *   1. Name-based: matches by collection+color or collection name
 *   2. Series-based: fuzzy-matches imageless tile products by series name
 *   3. CDN room scenes: constructs room scene URLs from primary images + HEAD-checks
 * Finally cleans up orphaned catalog-only products.
 */

const EMSER_API = 'https://www.emser.com/api/v2/products';
const PAGE_SIZE = 100;
const CDN_BASE = 'https://d3bauow4e98jr8.cloudfront.net/userfiles/product/images';

export async function run(pool, job, source) {
    await appendLog(pool, job.id, 'Starting Emser catalog enrichment scraper (Optimizely API)');

    // Resolve vendor ID
    let vendorId = source.vendor_id;
    if (!vendorId) {
        const r = await pool.query("SELECT id FROM vendors WHERE code = 'EMSER'");
        if (!r.rows.length) throw new Error('Vendor EMSER not found');
        vendorId = r.rows[0].id;
    }

    // Step 1: Paginate ALL products from the API
    const apiProducts = await fetchAllProducts(pool, job);
    await appendLog(pool, job.id, `Fetched ${apiProducts.length} products from Emser API`);

    if (apiProducts.length === 0) {
        await appendLog(pool, job.id, 'No products from API — check endpoint');
        return;
    }

    // Step 2: Load existing SKUs and category map
    const existingSkus = await loadExistingSkus(pool, vendorId);
    await appendLog(pool, job.id, `Loaded ${existingSkus.size} existing SKUs from DB`);

    const catMap = await loadCategoryMap(pool);

    const stats = {
        matched: 0,
        imagesSet: 0,
        collectionsSet: 0,
        categoriesSet: 0,
        attributesSet: 0,
        skipped: 0,
        errors: 0,
    };

    // Step 3: SKU-matched enrichment
    for (let i = 0; i < apiProducts.length; i++) {
        try {
            enrichProduct(apiProducts[i], existingSkus, stats, catMap, null);
        } catch (err) {
            stats.errors++;
            if (stats.errors <= 30) {
                await addJobError(pool, job.id, `${apiProducts[i].productNumber}: ${err.message}`);
            }
        }

        // Flush periodically to avoid unbounded memory
        if (queue.updates.length >= 200) {
            await flushQueue(pool);
        }

        if ((i + 1) % 500 === 0) {
            await appendLog(pool, job.id,
                `Progress: ${i + 1}/${apiProducts.length} — matched: ${stats.matched}, skipped: ${stats.skipped}`,
                { products_found: i + 1, products_updated: stats.matched }
            );
        }
    }

    // Flush remaining queued enrichment operations
    await flushQueue(pool);

    await appendLog(pool, job.id,
        `SKU pass complete. Matched: ${stats.matched}, Images: ${stats.imagesSet}, ` +
        `Collections: ${stats.collectionsSet}, Categories: ${stats.categoriesSet}, ` +
        `Skipped: ${stats.skipped}`
    );

    // Step 4: Name-based fallback for remaining imageless products
    const nameMatched = await matchImagesByName(pool, vendorId, apiProducts, job);
    stats.imagesSet += nameMatched;

    // Step 5: Series-based fallback for imageless tile products
    const seriesMatched = await matchImagesBySeries(pool, vendorId, apiProducts, job);
    stats.imagesSet += seriesMatched;

    // Step 6: Add room scene images via CDN URL construction
    const roomScenesAdded = await addRoomScenes(pool, vendorId, job);

    // Step 7: Cleanup orphaned catalog-only products
    const cleaned = await cleanupOrphans(pool, vendorId, job);

    // Final summary
    await appendLog(pool, job.id,
        `Complete. API products: ${apiProducts.length}, SKU matches: ${stats.matched}, ` +
        `Images set: ${stats.imagesSet}, Collections: ${stats.collectionsSet}, ` +
        `Categories: ${stats.categoriesSet}, Attributes: ${stats.attributesSet}, ` +
        `Name-matched images: ${nameMatched}, Series-matched: ${seriesMatched}, ` +
        `Room scenes added: ${roomScenesAdded}, Orphans cleaned: ${cleaned}, ` +
        `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
        {
            products_found: apiProducts.length,
            products_updated: stats.matched,
        }
    );
}

// ─── API Pagination ──────────────────────────────────────────────────────────

async function fetchAllProducts(pool, job) {
    const allProducts = [];
    let page = 1;

    while (true) {
        const url = `${EMSER_API}?pageSize=${PAGE_SIZE}&page=${page}&expand=images,properties`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
            await appendLog(pool, job.id, `API page ${page} failed: ${res.status}`);
            break;
        }

        const data = await res.json();
        const products = data.products || [];

        if (products.length === 0) break;
        allProducts.push(...products);

        const totalPages = data.pagination?.numberOfPages || 1;
        if (page >= totalPages) break;

        page++;
        await delay(100);
    }

    return allProducts;
}

// ─── Enrichment ──────────────────────────────────────────────────────────────

// Batch queue for DB operations to avoid one-at-a-time queries
const queue = { updates: [], images: [], attributes: [] };

function enrichProduct(apiProduct, existingSkus, stats, catMap, skuColorMap) {
    const productNumber = (apiProduct.productNumber || '').toUpperCase();
    if (!productNumber) { stats.skipped++; return; }

    const existing = existingSkus.get(productNumber);
    if (!existing) { stats.skipped++; return; }

    stats.matched++;
    const { product_id: productId, sku_id: skuId } = existing;

    // Parse title: "COLLECTION - SIZE, COLOR, FINISH"
    const title = apiProduct.productTitle || '';
    const props = apiProduct.properties || {};
    const rawCollection = props.parentNumber || '';
    const collectionName = titleCase(rawCollection) || titleCase(title.split(/\s*-\s*/)[0]) || '';

    const titleParts = title.split(/\s*-\s*/);
    const afterDash = titleParts.length > 1 ? titleParts.slice(1).join(' - ').split(/\s*,\s*/) : [];
    const colorName = titleCase(afterDash[1] || '');
    const finish = titleCase(afterDash[2] || '');
    const material = titleCase(props.bodyType || props.productType || '');
    const isTrim = String(props.isTrim || '').toLowerCase() === 'true';

    // Queue product update (collection + category)
    const productType = (props.productType || '').toLowerCase();
    const catId = resolveCategory(productType, material, collectionName, catMap);
    queue.updates.push({ productId, collectionName, catId, isTrim });

    if (collectionName) stats.collectionsSet++;
    if (catId) stats.categoriesSet++;

    // Queue attribute enrichment
    const attrPairs = [
        ['color', colorName],
        ['finish', finish],
        ['material', material],
    ];
    for (const [slug, val] of attrPairs) {
        if (val) {
            queue.attributes.push({ skuId, slug, val });
            stats.attributesSet++;
        }
    }

    // Queue images
    const images = apiProduct.images || [];
    const imagesToSave = [];

    for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        const imageUrl = img.largeImagePath || img.mediumImagePath || img.smallImagePath;
        if (!imageUrl || imageUrl.includes('placeholder')) continue;

        const fileName = (img.name || imageUrl).toLowerCase();
        const isLifestyle = /room|scene|lifestyle|installed|rs[_.]|roomscene|application|vignette/i.test(fileName);

        imagesToSave.push({
            url: imageUrl,
            sort: idx,
            type: isLifestyle ? 'lifestyle' : (idx === 0 ? 'primary' : 'alternate'),
        });
    }

    // Re-sort: prefer product shots as primary
    const nonLifestyle = imagesToSave.filter(i => i.type !== 'lifestyle');
    if (nonLifestyle.length > 0) {
        const sorted = preferProductShot(nonLifestyle.map(i => i.url));
        if (sorted.length > 0) {
            const bestUrl = sorted[0];
            for (const img of imagesToSave) {
                if (img.type === 'lifestyle') continue;
                if (img.url === bestUrl) {
                    img.type = 'primary';
                    img.sort = 0;
                } else {
                    img.type = 'alternate';
                }
            }
        }
    }

    // Fix sort orders
    let sortIdx = 0;
    for (const img of imagesToSave) {
        if (img.type !== 'lifestyle') img.sort = sortIdx++;
    }

    // Determine if image is for this specific SKU (color-matched) or shared (room scene w/ multiple colors)
    // Parse color from API title for filename matching
    const colorForSku = colorName ? colorName.toLowerCase().replace(/\s+/g, '_') : '';

    for (const imgObj of imagesToSave) {
        const filenameLower = imgObj.url.toLowerCase();
        const isRoomScene = imgObj.type === 'lifestyle';

        // Room scenes with multiple color references stay at product level
        // SKU-specific images (primary/alternate with this color) go to SKU level
        let targetSkuId = null;
        if (!isRoomScene && colorForSku && filenameLower.includes(colorForSku)) {
            targetSkuId = skuId;
        } else if (!isRoomScene && skuId) {
            // Non-lifestyle image from this API entry → assign to this SKU
            targetSkuId = skuId;
        }
        // Lifestyle images stay at product level (shared across color variants)

        queue.images.push({
            product_id: productId,
            sku_id: targetSkuId,
            asset_type: imgObj.type,
            url: imgObj.url,
            sort_order: imgObj.sort,
        });
        stats.imagesSet++;
    }
}

async function flushQueue(pool) {
    // Product updates: collection + category
    for (const u of queue.updates) {
        const sets = ['updated_at = CURRENT_TIMESTAMP'];
        const params = [u.productId];
        let idx = 2;

        if (u.collectionName) {
            // Only overwrite collection if current value is generic ALL-CAPS vendor name
            sets.push(`collection = CASE WHEN collection IS NULL OR collection = UPPER(collection) THEN $${idx} ELSE collection END`);
            params.push(u.collectionName);
            idx++;
        }
        if (u.catId) {
            sets.push(`category_id = COALESCE(category_id, $${idx})`);
            params.push(u.catId);
            idx++;
        }

        if (sets.length > 1) {
            try {
                await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, params);
            } catch (err) {
                // Skip unique constraint violations — duplicate (vendor, collection, name) after title-casing
                if (err.code !== '23505') throw err;
            }
        }
    }

    // Attributes
    for (const a of queue.attributes) {
        await upsertSkuAttribute(pool, a.skuId, a.slug, a.val);
    }

    // Images
    for (const img of queue.images) {
        await upsertMediaAsset(pool, {
            product_id: img.product_id,
            sku_id: img.sku_id || null,
            asset_type: img.asset_type,
            url: img.url,
            original_url: img.url,
            sort_order: img.sort_order,
        });
    }

    // Clear queues
    queue.updates.length = 0;
    queue.images.length = 0;
    queue.attributes.length = 0;
}

// ─── Name-Based Fallback ─────────────────────────────────────────────────────

async function matchImagesByName(pool, vendorId, apiProducts, job) {
    // Find products without images
    const noImg = await pool.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        LEFT JOIN media_assets ma ON ma.product_id = p.id
        WHERE p.vendor_id = $1 AND ma.id IS NULL
    `, [vendorId]);

    if (noImg.rows.length === 0) return 0;

    // Build lookup maps from API data: collection:color → images
    const byName = new Map();    // "collection color" → imageUrl
    const bySeries = new Map();  // "collection" → imageUrl

    for (const p of apiProducts) {
        const props = p.properties || {};
        const collection = titleCase(props.parentNumber || '');
        const title = p.productTitle || '';
        const afterDash = title.split(/\s*-\s*/).slice(1).join(' - ').split(/\s*,\s*/);
        const color = titleCase(afterDash[1] || '');

        const images = p.images || [];
        const imageUrl = pickBestImage(images);
        if (!imageUrl) continue;

        if (collection && color) {
            const key = `${collection} ${color}`.toLowerCase();
            if (!byName.has(key)) byName.set(key, imageUrl);
        }
        if (collection && !bySeries.has(collection.toLowerCase())) {
            bySeries.set(collection.toLowerCase(), imageUrl);
        }
    }

    let matched = 0;
    for (const prod of noImg.rows) {
        const compositeKey = prod.collection
            ? `${prod.collection} ${prod.name}`.toLowerCase()
            : prod.name.toLowerCase();

        let imageUrl = byName.get(compositeKey);
        if (!imageUrl) imageUrl = byName.get(prod.name.toLowerCase());
        if (!imageUrl && prod.collection) {
            imageUrl = bySeries.get(prod.collection.toLowerCase());
        }
        if (!imageUrl) continue;

        await upsertMediaAsset(pool, {
            product_id: prod.id, sku_id: null,
            asset_type: 'primary', url: imageUrl,
            original_url: imageUrl, sort_order: 0,
        });
        matched++;
    }

    if (matched > 0) {
        await appendLog(pool, job.id,
            `Name-based fallback: ${noImg.rows.length} products without images, ${matched} enriched`
        );
    }

    return matched;
}

// ─── Series-Based Fallback ──────────────────────────────────────────────────

/** Extract series name from API title: "BROOK II - 3X12, CREAM, MATTE" → "brook ii" */
function extractSeriesFromTitle(title) {
    return (title.split(/\s*-\s*/)[0] || '').trim().toLowerCase();
}

/** Extract series name from DB product name, stripping finish/size/trim qualifiers */
function extractSeriesFromName(name) {
    return name
        .replace(/\b(matte|polished|glossy|honed|satin|textured|lappato|rectified|structured|grip|anti-?slip)\b/gi, '')
        .replace(/\b(mosaic|bullnose|cove\s*base|single|double|trim|sbn|floor|wall|pencil|quarter\s*round|v-?cap|chair\s*rail|jolly|listel)\b/gi, '')
        .replace(/\b\d+[\./]?\d*\s*(mm|cm)\b/gi, '')
        .replace(/\b\d+x\d+\b/gi, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Series-level image fallback for tile products still missing images after
 * the SKU-matched and name-matched passes. Groups API products by series name,
 * then matches DB products by extracting + normalizing the series portion of
 * their product name.
 */
async function matchImagesBySeries(pool, vendorId, apiProducts, job) {
    // Find tile products (non-Z SKUs) still without any image
    const noImg = await pool.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        LEFT JOIN media_assets ma ON ma.product_id = p.id
        WHERE p.vendor_id = $1 AND ma.id IS NULL
          AND EXISTS (
              SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.vendor_sku NOT LIKE 'Z%'
          )
    `, [vendorId]);

    if (noImg.rows.length === 0) return 0;

    // Build series → images map from API products
    // Each series gets the best product shot + any room scenes
    const seriesMap = new Map();

    for (const p of apiProducts) {
        const title = p.productTitle || '';
        const series = extractSeriesFromTitle(title);
        if (!series) continue;

        const images = p.images || [];
        const bestUrl = pickBestImage(images);
        if (!bestUrl) continue;

        if (!seriesMap.has(series)) {
            seriesMap.set(series, []);
        }
        const urls = seriesMap.get(series);
        if (!urls.includes(bestUrl)) urls.push(bestUrl);

        // Also collect room scene / lifestyle images from this product
        for (const img of images) {
            const url = img.largeImagePath || img.mediumImagePath || img.smallImagePath;
            if (!url || url.includes('placeholder')) continue;
            const fileName = (img.name || url).toLowerCase();
            if (/room|scene|lifestyle|roomscene|application|vignette/i.test(fileName)) {
                if (!urls.includes(url)) urls.push(url);
            }
        }
    }

    let matched = 0;
    for (const prod of noImg.rows) {
        const dbSeries = extractSeriesFromName(prod.name);
        if (!dbSeries) continue;

        // 1. Exact series match
        let urls = seriesMap.get(dbSeries);

        // 2. Try collection name as series
        if (!urls && prod.collection) {
            urls = seriesMap.get(prod.collection.toLowerCase());
        }

        // 3. Try collection stripped of qualifiers
        if (!urls && prod.collection) {
            urls = seriesMap.get(extractSeriesFromName(prod.collection));
        }

        // 4. Fuzzy: find best series where all significant words overlap
        if (!urls) {
            const dbWords = dbSeries.split(/\s+/).filter(w => w.length >= 3);
            if (dbWords.length > 0) {
                for (const [seriesName, seriesUrls] of seriesMap) {
                    const allIn = dbWords.every(w => seriesName.includes(w));
                    if (allIn) { urls = seriesUrls; break; }
                }
            }
        }

        if (!urls || urls.length === 0) continue;

        // Save primary image
        await upsertMediaAsset(pool, {
            product_id: prod.id, sku_id: null,
            asset_type: 'primary', url: urls[0],
            original_url: urls[0], sort_order: 0,
        });

        // Save additional images as alternate/lifestyle (up to 3 more)
        for (let i = 1; i < Math.min(urls.length, 4); i++) {
            const type = isLifestyleUrl(urls[i]) ? 'lifestyle' : 'alternate';
            await upsertMediaAsset(pool, {
                product_id: prod.id, sku_id: null,
                asset_type: type, url: urls[i],
                original_url: urls[i], sort_order: i,
            });
        }

        matched++;
    }

    if (matched > 0) {
        await appendLog(pool, job.id,
            `Series-based fallback: ${noImg.rows.length} imageless tile products, ${matched} enriched`
        );
    }
    return matched;
}

// ─── CDN Room Scene Construction ────────────────────────────────────────────

/** Build full CDN URL from a filename using Emser's 2-char path bucket pattern */
function buildCdnUrl(filename) {
    const lower = filename.toLowerCase();
    const c1 = lower.substring(0, 2);
    const c2 = lower.substring(2, 4);
    const c3 = lower.substring(4, 6);
    return `${CDN_BASE}/${c1}/${c2}/${c3}/${lower}`;
}

/**
 * For products that already have a primary image on the Emser CDN but no
 * lifestyle images, attempt to construct room scene URLs by replacing the
 * _f1_large.jpg suffix with _roomscene_01 through _03, then HEAD-checking.
 */
async function addRoomScenes(pool, vendorId, job) {
    const candidates = await pool.query(`
        SELECT p.id, ma.url AS primary_url
        FROM products p
        JOIN media_assets ma ON ma.product_id = p.id
            AND ma.asset_type = 'primary' AND ma.sku_id IS NULL
        WHERE p.vendor_id = $1
          AND ma.url LIKE '%cloudfront.net%'
          AND NOT EXISTS (
              SELECT 1 FROM media_assets ma2
              WHERE ma2.product_id = p.id AND ma2.asset_type = 'lifestyle'
          )
    `, [vendorId]);

    if (candidates.rows.length === 0) return 0;

    await appendLog(pool, job.id,
        `Room scene pass: checking ${candidates.rows.length} products for CDN room scenes`
    );

    let added = 0;
    const CONCURRENCY = 10;

    for (let i = 0; i < candidates.rows.length; i += CONCURRENCY) {
        const batch = candidates.rows.slice(i, i + CONCURRENCY);

        await Promise.all(batch.map(async (row) => {
            try {
                const filename = row.primary_url.split('/').pop();
                // Strip known suffixes to get the base: series_color_sku
                const base = filename
                    .replace(/_f\d+_large\.(jpg|jpeg|png|webp)$/i, '')
                    .replace(/_large\.(jpg|jpeg|png|webp)$/i, '');

                if (!base || base === filename) return;

                const suffixes = ['roomscene_01', 'roomscene_02', 'roomscene_03'];
                let sortOrder = 0;

                for (const suffix of suffixes) {
                    const rsFilename = `${base}_${suffix}_large.jpg`;
                    const rsUrl = buildCdnUrl(rsFilename);

                    try {
                        const headRes = await fetch(rsUrl, {
                            method: 'HEAD',
                            signal: AbortSignal.timeout(5000),
                        });
                        if (headRes.ok) {
                            await upsertMediaAsset(pool, {
                                product_id: row.id, sku_id: null,
                                asset_type: 'lifestyle', url: rsUrl,
                                original_url: rsUrl, sort_order: sortOrder++,
                            });
                            added++;
                        }
                    } catch {
                        // HEAD failed — URL doesn't exist, skip
                    }
                }
            } catch {
                // Skip individual product errors
            }
        }));

        if ((i + CONCURRENCY) % 200 < CONCURRENCY || i + CONCURRENCY >= candidates.rows.length) {
            await appendLog(pool, job.id,
                `Room scenes: checked ${Math.min(i + CONCURRENCY, candidates.rows.length)}/${candidates.rows.length}, found ${added}`
            );
        }
    }

    return added;
}

function pickBestImage(images) {
    if (!images || images.length === 0) return null;

    const urls = [];
    for (const img of images) {
        const url = img.largeImagePath || img.mediumImagePath || img.smallImagePath;
        if (url && !url.includes('placeholder')) urls.push(url);
    }

    if (urls.length === 0) return null;
    const sorted = preferProductShot(urls);
    return sorted[0] || urls[0];
}

// ─── Orphan Cleanup ──────────────────────────────────────────────────────────

async function cleanupOrphans(pool, vendorId, job) {
    // Find products that have NO pricing on ANY of their SKUs (catalog-only orphans)
    const orphans = await pool.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        WHERE p.vendor_id = $1
          AND p.status = 'draft'
          AND NOT EXISTS (
              SELECT 1 FROM skus s
              JOIN pricing pr ON pr.sku_id = s.id
              WHERE s.product_id = p.id
          )
    `, [vendorId]);

    if (orphans.rows.length === 0) return 0;

    await appendLog(pool, job.id,
        `Found ${orphans.rows.length} orphaned catalog-only products (no pricing) — cleaning up`
    );

    const orphanIds = orphans.rows.map(r => r.id);

    // Delete in dependency order
    await pool.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [orphanIds]);
    // Clean up all SKU-child tables before deleting SKUs
    await pool.query(`
        DELETE FROM sku_attributes WHERE sku_id IN (
            SELECT id FROM skus WHERE product_id = ANY($1)
        )
    `, [orphanIds]);
    await pool.query(`
        DELETE FROM packaging WHERE sku_id IN (
            SELECT id FROM skus WHERE product_id = ANY($1)
        )
    `, [orphanIds]);
    await pool.query(`
        DELETE FROM inventory_snapshots WHERE sku_id IN (
            SELECT id FROM skus WHERE product_id = ANY($1)
        )
    `, [orphanIds]);
    await pool.query(`DELETE FROM skus WHERE product_id = ANY($1)`, [orphanIds]);
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [orphanIds]);

    await appendLog(pool, job.id, `Deleted ${orphanIds.length} orphaned products and their associated data`);
    return orphanIds.length;
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

async function loadExistingSkus(pool, vendorId) {
    const result = await pool.query(`
        SELECT s.id AS sku_id, s.product_id, s.vendor_sku
        FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
    `, [vendorId]);

    const map = new Map();
    for (const row of result.rows) {
        if (row.vendor_sku) {
            map.set(row.vendor_sku.toUpperCase(), row);
        }
    }
    return map;
}

async function loadCategoryMap(pool) {
    const result = await pool.query('SELECT id, slug FROM categories');
    const map = {};
    for (const row of result.rows) map[row.slug] = row.id;
    return map;
}

// ─── Category Resolution ─────────────────────────────────────────────────────

function resolveCategory(productType, material, collectionName, catMap) {
    const combined = (productType + ' ' + (material || '') + ' ' + (collectionName || '')).toLowerCase();

    if (combined.includes('lvt') || combined.includes('luxury vinyl') || combined.includes('plank'))
        return catMap['luxury-vinyl'] || catMap['lvp-plank'] || null;
    if (combined.includes('mosaic') || combined.includes('glass') || combined.includes('pebble'))
        return catMap['mosaic-tile'] || null;
    if (combined.includes('quarry'))
        return catMap['ceramic-tile'] || null;
    if (combined.includes('ledger') || combined.includes('stacked'))
        return catMap['natural-stone'] || null;
    if (combined.includes('marble') || combined.includes('travertine') ||
        combined.includes('granite') || combined.includes('slate') ||
        combined.includes('quartzite') || combined.includes('limestone') ||
        combined.includes('natural stone'))
        return catMap['natural-stone'] || null;
    if (combined.includes('ceramic'))
        return catMap['ceramic-tile'] || null;
    if (combined.includes('porcelain'))
        return catMap['porcelain-tile'] || null;

    return catMap['porcelain-tile'] || null;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function titleCase(s) {
    if (!s) return '';
    return s.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
