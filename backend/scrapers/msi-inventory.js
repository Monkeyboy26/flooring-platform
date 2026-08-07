import { delay, appendLog, addJobError } from './base.js';

const DEFAULT_CONFIG = {
  delayMs: 200,      // politeness delay applied per worker between requests
  concurrency: 8,    // number of SKUs fetched in parallel
  maxRetries: 8,     // per-SKU retries when the endpoint returns HTTP 429
  cooldownMs: 30000  // shared pause after a 429 so MSI's rate window can reset (~20-25s observed)
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
  let processed = 0;
  let lastLogged = 0;
  let throttleHits = 0;      // count of 429 responses observed
  let dropped = 0;           // SKUs abandoned after exhausting retries

  // Concurrent worker pool: fetch `concurrency` SKUs in parallel rather than
  // one-at-a-time. The old sequential loop spent ~27 min just sleeping between
  // SKUs; batching cuts a full run to a few minutes. JS is single-threaded so
  // the shared counters increment safely.
  //
  // MSI's endpoint rate-limits with HTTP 429 after ~500 requests in a rolling
  // window (~60s). A 429 is IP-wide, so when one worker sees it we set a SHARED
  // cooldown that every worker waits out — hammering during the window only
  // keeps it tripped. The SKU that hit the 429 is then retried (it was NOT
  // missing data). Earlier this was swallowed as "no inventory", capping
  // coverage at ~350 of 3235.
  const concurrency = Math.max(1, Math.min(config.concurrency || 8, 16));
  const maxRetries = config.maxRetries ?? 8;
  const cooldownMs = config.cooldownMs ?? 30000;
  let cursor = 0;
  let cooldownUntil = 0;

  async function waitOutCooldown() {
    let remaining;
    while ((remaining = cooldownUntil - Date.now()) > 0) {
      await delay(Math.min(remaining, 2000));
    }
  }

  async function processSku(sku) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitOutCooldown();

      let data;
      try {
        data = await fetchInventory(sku.vendor_sku);
      } catch (err) {
        errors++;
        if (errors <= 10) {
          await appendLog(pool, job.id, `Error fetching inventory for ${sku.vendor_sku}: ${err.message}`);
          await addJobError(pool, job.id, `SKU ${sku.vendor_sku}: ${err.message}`);
        }
        return;
      }

      if (data && data.throttled) {
        // Rate limited — set a shared cooldown so every worker backs off, then retry this SKU.
        throttleHits++;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);
        if (throttleHits === 1 || throttleHits % 25 === 0) {
          await appendLog(pool, job.id, `Rate limited (429) — pausing all workers ${Math.round(cooldownMs / 1000)}s to let MSI's window reset (hit #${throttleHits})`);
        }
        continue;
      }

      if (!data) {
        return; // Genuinely no inventory data for this SKU
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
      return;
    }

    // Exhausted retries while still being throttled — leave prior snapshot intact.
    dropped++;
  }

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= skus.length) return;

      await processSku(skus[i]);
      processed++;

      // Progress logging every ~200 SKUs
      if (processed - lastLogged >= 200 || processed === skus.length) {
        lastLogged = processed;
        await appendLog(pool, job.id, `Progress: ${processed}/${skus.length} SKUs checked, ${found} found, ${updated} updated, ${throttleHits} throttled`, {
          products_found: found,
          products_updated: updated
        });
      }

      if (config.delayMs) await delay(config.delayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (dropped > 0) {
    await appendLog(pool, job.id, `${dropped} SKU(s) abandoned after exhausting ${maxRetries} retries under sustained rate limiting`);
  }

  await appendLog(pool, job.id, `Inventory scrape complete. Checked: ${skus.length}, Found: ${found}, Updated: ${updated}, Errors: ${errors}, Throttled: ${throttleHits}, Dropped: ${dropped}`, {
    products_found: found,
    products_updated: updated
  });
}

/**
 * Fetch inventory data from MSI's public API for a single SKU.
 * Returns { regions: [...] } when data is present, { throttled: true } on HTTP 429
 * (caller should back off and retry — the SKU is NOT missing data), or null when
 * there is genuinely no inventory record.
 */
async function fetchInventory(skuCode) {
  const url = INVENTORY_API + encodeURIComponent(skuCode);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });

  if (resp.status === 429) return { throttled: true };
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
