import { delay, appendLog, addJobError } from './base.js';

const DEFAULT_CONFIG = {
  delayMs: 500,
  batchSize: 20
};

const INVENTORY_API = 'https://www.msisurfaces.com/inventory/tiledetails/?handler=CatagoryPartial&ItemId=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * MSI Inventory scraper (public API).
 *
 * Uses MSI's publicly available inventory tile details API to fetch real-time
 * warehouse inventory levels per SKU. No authentication required.
 *
 * Endpoint: /inventory/tiledetails/?handler=CatagoryPartial&ItemId={SKU_CODE}
 *
 * Returns per SKU:
 *   - Packaging: sqft/pc, sqft/box, pcs/box, pcs/crate, weight/pc, thickness
 *   - Inventory by region: East Coast, Southeast, West Coast, Canada
 *     - Qty in warehouse (pcs + sqft)
 *     - Qty in transit (pcs + sqft)
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };

  await appendLog(pool, job.id, 'Starting MSI inventory scrape (public API)...');

  // Load all MSI SKUs from DB
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MSI' AND s.vendor_sku IS NOT NULL
  `);

  const skus = skuResult.rows;
  await appendLog(pool, job.id, `Loaded ${skus.length} MSI SKUs to check inventory`);

  if (skus.length === 0) {
    await appendLog(pool, job.id, 'No MSI SKUs found — run the MSI product scraper first.');
    return;
  }

  let found = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];

    try {
      const data = await fetchInventory(sku.vendor_sku);

      if (!data) {
        continue; // No inventory data for this SKU
      }

      found++;

      // Upsert inventory snapshot per region
      for (const region of data.regions) {
        await pool.query(`
          INSERT INTO inventory_snapshots (
            sku_id, warehouse, qty_on_hand, qty_in_transit,
            qty_on_hand_sqft, qty_in_transit_sqft, fresh_until
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
          ON CONFLICT (sku_id, warehouse) DO UPDATE SET
            qty_on_hand = EXCLUDED.qty_on_hand,
            qty_in_transit = EXCLUDED.qty_in_transit,
            qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
            qty_in_transit_sqft = EXCLUDED.qty_in_transit_sqft,
            fresh_until = EXCLUDED.fresh_until,
            snapshot_time = CURRENT_TIMESTAMP
        `, [
          sku.id,
          region.geography,
          region.qtyInWhsePcs,
          region.qtyInTransitPcs,
          region.qtyInWhseSqft,
          region.qtyInTransitSqft
        ]);
      }

      updated++;
    } catch (err) {
      errors++;
      if (errors <= 10) {
        await appendLog(pool, job.id, `Error fetching inventory for ${sku.vendor_sku}: ${err.message}`);
        await addJobError(pool, job.id, `SKU ${sku.vendor_sku}: ${err.message}`);
      }
    }

    // Progress logging every 50 SKUs
    if ((i + 1) % 50 === 0 || i === skus.length - 1) {
      await appendLog(pool, job.id, `Progress: ${i + 1}/${skus.length} SKUs checked, ${found} found, ${updated} updated`, {
        products_found: found,
        products_updated: updated
      });
    }

    await delay(config.delayMs);
  }

  await appendLog(pool, job.id, `Inventory scrape complete. Checked: ${skus.length}, Found: ${found}, Updated: ${updated}, Errors: ${errors}`, {
    products_found: found,
    products_updated: updated
  });
}

/**
 * Fetch inventory data from MSI's public API for a single SKU.
 * Returns { regions: [{ geography, qtyInWhsePcs, qtyInTransitPcs, qtyInWhseSqft, qtyInTransitSqft }] }
 * or null if no data found.
 */
async function fetchInventory(skuCode) {
  const url = INVENTORY_API + encodeURIComponent(skuCode);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) return null;

  const html = await resp.text();
  if (html.includes('No Records') || !html.includes('tblwhse')) return null;

  // Parse the inventory table (class="tblwhse")
  const regions = [];
  const rowRegex = /<tr>\s*<td[^>]*translate="no"[^>]*>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const geography = match[1].trim();
    if (!geography || geography.includes('GEOGRAPHY')) continue;

    regions.push({
      geography,
      qtyInWhsePcs: parseIntSafe(match[2]),
      qtyInTransitPcs: parseIntSafe(match[3]),
      qtyInWhseSqft: parseIntSafe(match[4]),
      qtyInTransitSqft: parseIntSafe(match[5])
    });
  }

  if (regions.length === 0) return null;

  return { regions };
}

function parseIntSafe(str) {
  return parseInt((str || '').replace(/,/g, '').trim()) || 0;
}
