import { delay, appendLog, addJobError } from './base.js';
import { elysiumLogin, elysiumFetch } from './elysium-auth.js';

const DEFAULT_CONFIG = {
  categories: [
    { name: 'Mosaic', type: 'Mosaic' },
    { name: 'Porcelain Tile', type: 'Porcelain+Tile' },
    { name: 'SPC Vinyl', type: 'SPC+Vinyl' },
    { name: 'Marble Slab', type: 'Marble+Slab' },
    { name: 'Thin Porcelain Slab 6mm', type: 'Thin+Porcelain+Slab+6mm' },
    { name: 'Quartz, Quartzite, Granite', type: 'Quartz%2C+Quartzite%2C+Granite' },
    { name: 'Ceramic Tile', type: 'Ceramic+Tile' },
    { name: 'Marble Tile', type: 'Marble+Tile' },
  ],
  warehouse_filter: 'CA',
  max_products: 5000,
  freshness_hours: 8,
  delayMs: 500
};

/**
 * Elysium Tile inventory scraper — CA warehouse only.
 *
 * Lightweight: does NOT upsert products/SKUs/attributes.
 * Reads existing Elysium SKUs from DB and updates inventory_snapshots.
 * Runs every 4-6 hours on a tighter schedule than the catalog scraper.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };

  await appendLog(pool, job.id, 'Starting Elysium inventory scrape (CA warehouse)...');

  // Load all Elysium SKUs from DB
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ELY' AND s.vendor_sku IS NOT NULL
  `);

  const skus = skuResult.rows;
  await appendLog(pool, job.id, `Loaded ${skus.length} Elysium SKUs to check inventory`);

  if (skus.length === 0) {
    await appendLog(pool, job.id, 'No Elysium SKUs found — run the Elysium catalog scraper first.');
    return;
  }

  // Build lookup map: vendor_sku → sku.id
  const skuLookup = new Map();
  for (const sku of skus) {
    skuLookup.set(sku.vendor_sku, sku.id);
  }

  // Login
  const cookies = await elysiumLogin(pool, job.id);

  let found = 0;
  let updated = 0;
  let errors = 0;
  const warehouse = 'Elysium CA';
  const freshnessHours = parseInt(config.freshness_hours, 10) || 24;

  // Crawl category listing pages to find stock info
  for (const cat of config.categories) {
    let page = 1;
    let hasMore = true;

    while (hasMore && found < config.max_products) {
      try {
        const listUrl = `/category?type=${cat.type}&order_by=name&page=${page}`;
        const resp = await elysiumFetch(listUrl, cookies);
        const html = await resp.text();

        // Extract product entries with stock status
        // Look for product links and nearby stock indicators
        const productRegex = /href=["']\/product\?id=([^"']+)["']/g;
        let match;
        const productIds = [];

        while ((match = productRegex.exec(html)) !== null) {
          productIds.push(match[1]);
        }

        if (productIds.length === 0) {
          hasMore = false;
          break;
        }

        // For each product found on listing, fetch detail page for stock qty
        for (const productId of productIds) {
          if (found >= config.max_products) break;

          // Check if this product's SKU exists in our DB
          // We need to fetch detail to get the item code and match it
          try {
            const detailResp = await elysiumFetch(`/product?id=${productId}`, cookies);
            const detailHtml = await detailResp.text();

            // Extract item code
            const codeMatch = detailHtml.match(/item\s*(?:code|#|number)\s*[:\-]?\s*["']?([A-Z0-9\-]+)/i) ||
                               detailHtml.match(/(?:sku|code)\s*[:\-]?\s*["']?([A-Z][A-Z0-9\-]{2,})/i);

            const vendorSku = codeMatch ? codeMatch[1].trim() : productId;
            const skuId = skuLookup.get(vendorSku);

            if (!skuId) {
              // SKU not in our DB yet — skip
              continue;
            }

            found++;

            // Extract stock quantity
            let qty = 0;
            const stockMatch = detailHtml.match(/(?:stock|inventory|qty|quantity|available)\s*[:\-]?\s*(\d+)/i);
            if (stockMatch) {
              qty = parseInt(stockMatch[1], 10);
            } else if (/in\s*stock/i.test(detailHtml)) {
              qty = 1; // Binary: in stock but unknown qty
            }
            // Out of Stock or no match → qty stays 0

            // Check for CA warehouse specifically if site distinguishes
            const caSection = detailHtml.match(/(?:california|CA|anaheim|west\s*coast)[\s\S]{0,200}?(\d+)\s*(?:available|in\s*stock|qty|pcs|units)/i);
            if (caSection) {
              qty = parseInt(caSection[1], 10);
            }

            // Upsert inventory snapshot
            await pool.query(`
              INSERT INTO inventory_snapshots (
                sku_id, warehouse, qty_on_hand, fresh_until
              ) VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)
              ON CONFLICT (sku_id, warehouse) DO UPDATE SET
                qty_on_hand = EXCLUDED.qty_on_hand,
                fresh_until = EXCLUDED.fresh_until,
                snapshot_time = CURRENT_TIMESTAMP
            `, [skuId, warehouse, qty, freshnessHours]);

            updated++;
          } catch (err) {
            errors++;
            if (errors <= 10) {
              await addJobError(pool, job.id, `Inventory ${productId}: ${err.message}`);
            }
          }

          await delay(config.delayMs);
        }

        // Check for next page
        const nextPageRegex = new RegExp(`page=(${page + 1})`, 'g');
        hasMore = nextPageRegex.test(html);
        page++;
      } catch (err) {
        await appendLog(pool, job.id, `ERROR listing ${cat.name} page ${page}: ${err.message}`);
        await addJobError(pool, job.id, `Listing ${cat.name} p${page}: ${err.message}`);
        hasMore = false;
      }
    }

    // Progress logging per category
    await appendLog(pool, job.id, `Category ${cat.name}: ${found} found, ${updated} updated`, {
      products_found: found,
      products_updated: updated
    });
  }

  await appendLog(pool, job.id,
    `Inventory scrape complete. Found: ${found}, Updated: ${updated}, Errors: ${errors}`,
    { products_found: found, products_updated: updated }
  );
}
