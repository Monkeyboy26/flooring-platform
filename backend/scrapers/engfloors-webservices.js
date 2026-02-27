/**
 * Engineered Floors — fcB2B Web Services Integration
 *
 * Polls EF's fcB2B web service endpoints for real-time inventory and pricing
 * data on all active EF SKUs in the database.
 *
 * Endpoints used:
 *   - InventoryInquiry (v2.0) — current stock availability per SKU
 *   - PriceInquiry (v1.0) — current dealer/retail pricing per SKU
 *   - StockCheck (v1.0) — quick single-item availability check
 *
 * Auth: GET requests with query params ApiKey + Signature (the secret key).
 * Discovery: https://www.engfloors.info/B2B/serviceDiscovery
 *
 * Config (vendor_sources.config):
 *   api_key, secret_key, client_id — web service credentials
 *   base_url — service base (default: https://www.engfloors.info/B2B)
 *   batch_delay_ms — delay between requests to avoid hammering (default: 200)
 */

import https from 'https';
import crypto from 'crypto';
import {
  appendLog, addJobError,
  upsertPricing, upsertInventorySnapshot,
} from './base.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_CODE = 'EF';

const DEFAULT_CONFIG = {
  api_key: 'ENGFLOORWSV1',
  secret_key: '1WDE34',
  client_id: '18110',
  base_url: 'https://www.engfloors.info/B2B',
  batch_delay_ms: 200,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'text/xml, application/xml' },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// XML parsing helpers (lightweight, no external deps)
// ---------------------------------------------------------------------------

/** Extract text content of a single XML element. Returns null if not found. */
function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Extract all occurrences of a repeating XML element and return their inner XML. */
function xmlAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gis');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]);
  }
  return results;
}

/** Check for error elements in response. */
function xmlError(xml) {
  const err = xmlText(xml, 'error');
  const desc = xmlText(xml, 'Description') || xmlText(xml, 'Messages');
  return err ? { code: err, message: desc || err } : null;
}

// ---------------------------------------------------------------------------
// Web service callers
// ---------------------------------------------------------------------------

function buildUrl(baseUrl, endpoint, config, supplierItemSku) {
  const ts = new Date().toISOString();
  const gid = crypto.randomUUID();
  const params = new URLSearchParams({
    ApiKey: config.api_key,
    Signature: config.secret_key,
    ClientIdentifier: config.client_id,
    SupplierItemSKU: supplierItemSku,
    TimeStamp: ts,
    GlobalIdentifier: gid,
  });
  return `${baseUrl}/${endpoint}?${params.toString()}`;
}

/**
 * Call InventoryInquiry for a single SKU.
 * Returns { available: boolean, items: [{ sku, warehouse, qtyOnHand, qtyInTransit, uom }] }
 */
async function inventoryInquiry(baseUrl, config, sku) {
  const url = buildUrl(baseUrl, 'InventoryInquiry', config, sku);
  const res = await httpsGet(url);
  if (res.status !== 200) return { available: false, items: [], error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { available: false, items: [], error: err.message };

  // Parse AvailableItems
  const items = [];
  const availableXml = xmlAll(res.body, 'AvailableItem');
  if (availableXml.length === 0) {
    // Try alternative: items may be direct children of AvailableItems
    const avSection = res.body.match(/<AvailableItems>(.*?)<\/AvailableItems>/is);
    if (avSection && avSection[1].trim()) {
      // Parse flat structure
      const qty = xmlText(avSection[1], 'Quantity') || xmlText(avSection[1], 'QuantityAvailable');
      if (qty) {
        items.push({
          sku,
          warehouse: xmlText(avSection[1], 'Warehouse') || xmlText(avSection[1], 'Location') || 'default',
          qtyOnHand: parseFloat(qty) || 0,
          qtyInTransit: parseFloat(xmlText(avSection[1], 'QuantityInTransit') || '0'),
          uom: xmlText(avSection[1], 'UnitOfMeasure') || 'SF',
        });
      }
    }
  } else {
    for (const itemXml of availableXml) {
      items.push({
        sku: xmlText(itemXml, 'SupplierItemSKU') || sku,
        warehouse: xmlText(itemXml, 'Warehouse') || xmlText(itemXml, 'Location') || 'default',
        qtyOnHand: parseFloat(xmlText(itemXml, 'Quantity') || xmlText(itemXml, 'QuantityAvailable') || '0'),
        qtyInTransit: parseFloat(xmlText(itemXml, 'QuantityInTransit') || '0'),
        uom: xmlText(itemXml, 'UnitOfMeasure') || 'SF',
        dyeLot: xmlText(itemXml, 'DyeLot') || null,
        shade: xmlText(itemXml, 'Shade') || null,
        rollWidth: xmlText(itemXml, 'RollWidth') || null,
        rollLength: xmlText(itemXml, 'RollLength') || null,
      });
    }
  }

  return { available: items.length > 0, items };
}

/**
 * Call PriceInquiry for a single SKU.
 * Returns { available: boolean, prices: [{ sku, priceType, unitPrice, uom }] }
 */
async function priceInquiry(baseUrl, config, sku) {
  const url = buildUrl(baseUrl, 'PriceInquiry', config, sku);
  const res = await httpsGet(url);
  if (res.status !== 200) return { available: false, prices: [], error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { available: false, prices: [], error: err.message };

  const prices = [];
  const priceItems = xmlAll(res.body, 'AvailableItem') || [];
  if (priceItems.length === 0) {
    // Try flat structure in AvailableItems
    const avSection = res.body.match(/<AvailableItems>(.*?)<\/AvailableItems>/is);
    if (avSection && avSection[1].trim()) {
      const price = xmlText(avSection[1], 'UnitPrice') || xmlText(avSection[1], 'Price');
      if (price) {
        prices.push({
          sku,
          priceType: xmlText(avSection[1], 'PriceType') || xmlText(avSection[1], 'ClassOfTrade') || 'NET',
          unitPrice: parseFloat(price),
          uom: xmlText(avSection[1], 'UnitOfMeasure') || 'SF',
          retail: parseFloat(xmlText(avSection[1], 'RetailPrice') || xmlText(avSection[1], 'MSRP') || '0'),
        });
      }
    }
  } else {
    for (const itemXml of priceItems) {
      const price = xmlText(itemXml, 'UnitPrice') || xmlText(itemXml, 'Price');
      if (price) {
        prices.push({
          sku: xmlText(itemXml, 'SupplierItemSKU') || sku,
          priceType: xmlText(itemXml, 'PriceType') || xmlText(itemXml, 'ClassOfTrade') || 'NET',
          unitPrice: parseFloat(price),
          uom: xmlText(itemXml, 'UnitOfMeasure') || 'SF',
          retail: parseFloat(xmlText(itemXml, 'RetailPrice') || xmlText(itemXml, 'MSRP') || '0'),
        });
      }
    }
  }

  return { available: prices.length > 0, prices };
}

/**
 * Call StockCheck for a single SKU.
 * Returns { available: boolean, qty, uom, warehouse }
 */
async function stockCheck(baseUrl, config, sku) {
  const url = buildUrl(baseUrl, 'stockcheck', config, sku);
  const res = await httpsGet(url);
  if (res.status !== 200) return { available: false, error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { available: false, error: err.message };

  const qty = xmlText(res.body, 'Quantity') || xmlText(res.body, 'QuantityAvailable');
  if (!qty) return { available: false };

  return {
    available: true,
    qty: parseFloat(qty),
    uom: xmlText(res.body, 'UnitOfMeasure') || 'SF',
    warehouse: xmlText(res.body, 'Warehouse') || xmlText(res.body, 'Location') || 'default',
  };
}

// ---------------------------------------------------------------------------
// Main run function (scraper framework entry point)
// ---------------------------------------------------------------------------

export async function run(pool, job, source) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(source?.config || {}),
  };
  const baseUrl = cfg.base_url.replace(/\/+$/, '');

  await appendLog(pool, job.id, `EF Web Services sync starting (endpoint: ${baseUrl})`);

  // ── Step 1: Resolve vendor ──
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    throw new Error(`Vendor with code "${VENDOR_CODE}" not found.`);
  }
  const vendorId = vendorResult.rows[0].id;

  // ── Step 2: Get all active EF SKUs ──
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  const skus = skuResult.rows;
  await appendLog(pool, job.id, `Found ${skus.length} active EF SKUs to check`, { products_found: skus.length });

  if (skus.length === 0) {
    await appendLog(pool, job.id, 'No active EF SKUs in database. Run the 832 importer first.');
    return;
  }

  // ── Step 3: Query web services for each SKU ──
  let inventoryUpdated = 0, pricingUpdated = 0, errCount = 0;
  let inventoryDataFound = 0, pricingDataFound = 0;
  const batchSize = 50;
  let processed = 0;

  for (const sku of skus) {
    const vendorSku = sku.vendor_sku;
    if (!vendorSku) continue;

    // Strip the EF- prefix to get the original vendor SKU for the API
    const apiSku = vendorSku.startsWith('EF-') ? vendorSku.slice(3) : vendorSku;

    try {
      // ── InventoryInquiry ──
      const invResult = await inventoryInquiry(baseUrl, cfg, apiSku);
      if (invResult.error && invResult.error !== 'SKU not available or does not exist') {
        errCount++;
        if (errCount <= 10) {
          await addJobError(pool, job.id, { message: `Inventory error for ${apiSku}: ${invResult.error}` });
        }
      }

      if (invResult.available && invResult.items.length > 0) {
        inventoryDataFound++;
        for (const item of invResult.items) {
          await upsertInventorySnapshot(pool, sku.id, item.warehouse, {
            qty_on_hand_sqft: Math.round(item.qtyOnHand),
            qty_in_transit_sqft: Math.round(item.qtyInTransit),
          });
          inventoryUpdated++;
        }
      }

      // Rate limit
      await sleep(cfg.batch_delay_ms);

      // ── PriceInquiry ──
      const priceResult = await priceInquiry(baseUrl, cfg, apiSku);
      if (priceResult.error && priceResult.error !== 'SKU not available or does not exist') {
        errCount++;
        if (errCount <= 10) {
          await addJobError(pool, job.id, { message: `Price error for ${apiSku}: ${priceResult.error}` });
        }
      }

      if (priceResult.available && priceResult.prices.length > 0) {
        pricingDataFound++;
        // Find net/dealer cost and retail price
        let cost = null, retail = null;
        for (const p of priceResult.prices) {
          const type = (p.priceType || '').toUpperCase();
          if (['NET', 'WS', 'DE', 'DI', 'DEALER', 'WHOLESALE'].includes(type)) {
            cost = p.unitPrice;
          }
          if (['RS', 'MSR', 'MSRP', 'RETAIL', 'MAP'].includes(type)) {
            retail = p.unitPrice;
          }
          // Fallback: use first price as cost if type unknown
          if (cost === null) cost = p.unitPrice;
          if (p.retail) retail = p.retail;
        }

        if (cost !== null) {
          const priceBasis = sku.sell_by === 'sqft' ? 'per_sqft' : 'per_unit';
          await upsertPricing(pool, sku.id, {
            cost: parseFloat(cost).toFixed(2),
            retail_price: retail ? parseFloat(retail).toFixed(2) : null,
            price_basis: priceBasis,
          });
          pricingUpdated++;
        }
      }

      await sleep(cfg.batch_delay_ms);

    } catch (err) {
      errCount++;
      if (errCount <= 10) {
        await addJobError(pool, job.id, { message: `Exception for ${apiSku}: ${err.message}` });
      }
    }

    processed++;
    if (processed % batchSize === 0) {
      await appendLog(pool, job.id,
        `Progress: ${processed}/${skus.length} SKUs checked (${inventoryDataFound} inventory, ${pricingDataFound} pricing found)`);
    }
  }

  // ── Step 4: Log summary ──
  await appendLog(pool, job.id, [
    `EF Web Services sync complete.`,
    `  SKUs checked: ${processed}`,
    `  Inventory data found: ${inventoryDataFound} (${inventoryUpdated} snapshots upserted)`,
    `  Pricing data found: ${pricingDataFound} (${pricingUpdated} prices upserted)`,
    `  Errors: ${errCount}`,
  ].join('\n'), {
    products_found: processed,
    products_updated: inventoryDataFound + pricingDataFound,
    skus_created: 0,
  });
}
