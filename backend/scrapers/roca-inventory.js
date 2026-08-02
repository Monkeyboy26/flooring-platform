import { appendLog, addJobError } from './base.js';

/**
 * Roca inventory scraper (public JSON feed).
 *
 * Roca's stock-check page (https://rocatileusa.com/roca-stock) is a Vue app that
 * pulls warehouse inventory from a public JSON endpoint:
 *
 *   GET https://rocatileusa.com/items-inventory/{warehouseId}
 *
 * where warehouseId indexes the location buttons on the page. As of 2026-08:
 *   0 = ALL WHS   1 = CHICAGO   2 = ANAHEIM   3 = HOUSTON   4 = MIAMI
 * No auth / cookies / special headers required (plain HTTPS GET, returns 201).
 *
 * We only care about ANAHEIM (id 2) — Roma's local pickup warehouse.
 *
 * Each row is a lot (unique shade + caliber), so a single SKU appears on
 * multiple rows. We aggregate all lots per SKU before writing. Every row also
 * carries a `name` field equal to the warehouse name ("ANAHEIM"), which we use
 * as a guard against Roca silently re-ordering their location ids.
 *
 * Row shape:
 *   { name:"ANAHEIM", sku:"AESSMAPM935", series, color, size, description,
 *     shade:"01", caliber:"2", pc_available:2784, sqft_available:6068.28,
 *     sqft_per_box:13.0782, pcs_per_box:6, ... , updated_at }
 *
 * Matched against our DB by exact skus.vendor_sku. Roca gives no in-transit data.
 */

const INVENTORY_API = 'https://rocatileusa.com/items-inventory/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_CONFIG = {
  warehouseId: 2,               // Roca /items-inventory/{id} index for Anaheim
  warehouseName: 'Roca-Anaheim', // stored in inventory_snapshots.warehouse
  expectFeedName: 'ANAHEIM',    // guard: row.name must match this warehouse
};

export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const { warehouseId, warehouseName, expectFeedName } = config;

  await appendLog(pool, job.id, `Starting Roca inventory scrape (${warehouseName}, /items-inventory/${warehouseId})...`);

  // 1. Fetch the warehouse feed
  const items = await fetchInventory(warehouseId);
  await appendLog(pool, job.id, `Fetched ${items.length} inventory rows from Roca ${expectFeedName}`);

  if (items.length === 0) {
    await appendLog(pool, job.id, 'Feed returned no rows — nothing to update. Roca may have re-indexed warehouses; verify the warehouseId.');
    return;
  }

  // Guard: every row's `name` is the warehouse name. If Roca re-orders location
  // ids, id 2 could start returning a different warehouse — bail loudly rather
  // than silently overwriting Anaheim stock with (e.g.) Houston's.
  const feedNames = [...new Set(items.map(i => (i.name || '').trim().toUpperCase()))];
  if (!feedNames.includes(expectFeedName)) {
    const msg = `Warehouse mismatch: /items-inventory/${warehouseId} returned name(s) ${JSON.stringify(feedNames)}, expected "${expectFeedName}". Roca likely re-indexed locations — aborting before writing wrong-warehouse stock.`;
    await addJobError(pool, job.id, msg);
    throw new Error(msg);
  }

  // 2. Aggregate lot-level rows by SKU (sum pieces + sqft across shade/caliber lots)
  const bySku = new Map();
  for (const it of items) {
    const key = (it.sku || '').trim();
    if (!key) continue;
    const agg = bySku.get(key) || { pcs: 0, sqft: 0, pcsPerBox: 0, sqftPerBox: 0 };
    agg.pcs += num(it.pc_available);
    agg.sqft += num(it.sqft_available);
    // pcs_per_box / sqft_per_box are constant per SKU across its lots
    if (!agg.pcsPerBox) agg.pcsPerBox = num(it.pcs_per_box);
    if (!agg.sqftPerBox) agg.sqftPerBox = num(it.sqft_per_box);
    bySku.set(key, agg);
  }
  await appendLog(pool, job.id, `Aggregated to ${bySku.size} unique SKUs`);

  // 3. Load our Roca SKUs, index by vendor_sku
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ROCA' AND s.vendor_sku IS NOT NULL
  `);
  const skuMap = new Map(skuResult.rows.map(r => [r.vendor_sku, r.id]));
  await appendLog(pool, job.id, `Loaded ${skuMap.size} Roca SKUs from catalog to match against`);

  if (skuMap.size === 0) {
    await appendLog(pool, job.id, 'No Roca SKUs in catalog — run the Roca product scraper/import first.');
    return;
  }

  // 4. Upsert one snapshot per matched SKU
  let updated = 0;
  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples = [];

  for (const [vendorSku, agg] of bySku) {
    const skuId = skuMap.get(vendorSku);
    if (!skuId) {
      unmatched++;
      if (unmatchedSamples.length < 20) unmatchedSamples.push(vendorSku);
      continue;
    }
    matched++;

    // qty_on_hand is BOXES (the app displays sqft as qty_on_hand * sqft_per_box).
    // Derive boxes from the feed's own packaging; fall back to sqft when needed.
    let boxes;
    if (agg.pcsPerBox > 0) boxes = Math.round(agg.pcs / agg.pcsPerBox);
    else if (agg.sqftPerBox > 0) boxes = Math.round(agg.sqft / agg.sqftPerBox);
    else boxes = Math.round(agg.pcs); // per-piece accessory: 1 pc = 1 unit

    try {
      // Pass explicit qty_on_hand so base.js skips the per-SKU packaging lookup.
      await pool.query(`
        INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, qty_on_hand_sqft, qty_in_transit_sqft, snapshot_time, fresh_until)
        VALUES ($1, $2, $3, 0, $4, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '48 hours')
        ON CONFLICT (sku_id, warehouse) DO UPDATE SET
          qty_on_hand = EXCLUDED.qty_on_hand,
          qty_in_transit = EXCLUDED.qty_in_transit,
          qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
          qty_in_transit_sqft = EXCLUDED.qty_in_transit_sqft,
          snapshot_time = CURRENT_TIMESTAMP,
          fresh_until = CURRENT_TIMESTAMP + INTERVAL '48 hours'
      `, [skuId, warehouseName, boxes, Math.round(agg.sqft)]);
      updated++;
    } catch (err) {
      await addJobError(pool, job.id, `SKU ${vendorSku}: ${err.message}`);
    }
  }

  await appendLog(
    pool, job.id,
    `Roca ${expectFeedName} inventory complete. Feed SKUs: ${bySku.size}, matched: ${matched}, updated: ${updated}, unmatched: ${unmatched}` +
      (unmatched ? ` (e.g. ${unmatchedSamples.slice(0, 10).join(', ')})` : ''),
    { products_found: matched, products_updated: updated }
  );
}

/**
 * Fetch and parse the Roca inventory feed for one warehouse id.
 * Returns an array of row objects (never null; throws on transport/parse error).
 */
async function fetchInventory(warehouseId) {
  const url = INVENTORY_API + encodeURIComponent(warehouseId);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(30000),
  });

  // Roca returns 201 (not 200) for this endpoint on success.
  if (!resp.ok && resp.status !== 201) {
    throw new Error(`Roca inventory feed HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const items = Array.isArray(data) ? data : (data.items || data.data || []);
  if (!Array.isArray(items)) {
    throw new Error('Roca inventory feed: unexpected response shape (no items array)');
  }
  return items;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
