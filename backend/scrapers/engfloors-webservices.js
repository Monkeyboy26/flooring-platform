/**
 * Engineered Floors — fcB2B Web Services Integration
 *
 * Polls EF's fcB2B PriceInquiry endpoint for real-time pricing and inventory
 * data on all active EF SKUs in the database.
 *
 * PriceInquiry returns both price AND available quantity per SKU, with separate
 * entries for Roll (R) and Cut (C) availability. This is more useful than
 * InventoryInquiry which returns empty quantities for most product types.
 *
 * Actual XML response format (from live testing):
 *   <AvailableItem>
 *     <AvailableQuantity>145.75</AvailableQuantity>  (or "NA" or empty)
 *     <Price>5.76</Price>
 *     <AvailableUnitOfMeasure>SY</AvailableUnitOfMeasure>
 *     <RollOrCutFlag>R</RollOrCutFlag>  (R=Roll, C=Cut)
 *     <MinimumQuantityRestriction>150.00</MinimumQuantityRestriction> (optional)
 *   </AvailableItem>
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
  api_key: process.env.EF_B2B_API_KEY || 'ENGFLOORWSV1',
  secret_key: process.env.EF_B2B_SECRET_KEY || '1WDE34',
  client_id: process.env.EF_CLIENT_ID || '18110',
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
// Web service caller
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
 * Call PriceInquiry for a single SKU.
 * Returns both price AND inventory data.
 *
 * Response shape:
 * {
 *   available: boolean,
 *   items: [{
 *     qty: number | null,     // AvailableQuantity (null if "NA" or empty)
 *     price: number,          // Price (dealer cost per SY)
 *     uom: string,            // AvailableUnitOfMeasure (SY, LF, EA)
 *     rollOrCut: string,      // R=Roll, C=Cut, Roll, Cut
 *     minQty: number | null,  // MinimumQuantityRestriction
 *   }],
 *   error: string | null,
 * }
 */
async function priceInquiry(baseUrl, config, sku) {
  const url = buildUrl(baseUrl, 'PriceInquiry', config, sku);
  const res = await httpsGet(url);
  if (res.status !== 200) return { available: false, items: [], error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { available: false, items: [], error: err.message };

  const items = [];
  const availableItems = xmlAll(res.body, 'AvailableItem');

  if (availableItems.length === 0) {
    // Try flat structure (single item directly inside AvailableItems)
    const avSection = res.body.match(/<AvailableItems>(.*?)<\/AvailableItems>/is);
    if (avSection && avSection[1].trim()) {
      const price = xmlText(avSection[1], 'Price');
      const qtyRaw = xmlText(avSection[1], 'AvailableQuantity');
      if (price || (qtyRaw && qtyRaw !== 'NA')) {
        items.push({
          qty: (qtyRaw && qtyRaw !== 'NA' && qtyRaw !== '') ? parseFloat(qtyRaw) : null,
          price: price ? parseFloat(price) : null,
          uom: xmlText(avSection[1], 'AvailableUnitOfMeasure') || 'SY',
          rollOrCut: (xmlText(avSection[1], 'RollOrCutFlag') || '').toUpperCase().charAt(0) || null,
          minQty: parseFloat(xmlText(avSection[1], 'MinimumQuantityRestriction') || '0') || null,
        });
      }
    }
  } else {
    for (const itemXml of availableItems) {
      const price = xmlText(itemXml, 'Price');
      const qtyRaw = xmlText(itemXml, 'AvailableQuantity');
      items.push({
        qty: (qtyRaw && qtyRaw !== 'NA' && qtyRaw !== '') ? parseFloat(qtyRaw) : null,
        price: price ? parseFloat(price) : null,
        uom: xmlText(itemXml, 'AvailableUnitOfMeasure') || 'SY',
        rollOrCut: (xmlText(itemXml, 'RollOrCutFlag') || '').toUpperCase().charAt(0) || null,
        minQty: parseFloat(xmlText(itemXml, 'MinimumQuantityRestriction') || '0') || null,
      });
    }
  }

  return { available: items.length > 0, items };
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
    SELECT s.id, s.vendor_sku, s.sell_by
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

  // ── Step 3: Query PriceInquiry for each SKU ──
  let inventoryUpdated = 0, pricingUpdated = 0, errCount = 0;
  let inventoryDataFound = 0, pricingDataFound = 0, noDataCount = 0;
  const batchSize = 100;
  let processed = 0;

  for (const sku of skus) {
    const vendorSku = sku.vendor_sku;
    if (!vendorSku) continue;

    try {
      const result = await priceInquiry(baseUrl, cfg, vendorSku);

      if (result.error) {
        errCount++;
        if (errCount <= 20) {
          await addJobError(pool, job.id, { message: `Error for ${vendorSku}: ${result.error}` });
        }
      } else if (!result.available || result.items.length === 0) {
        noDataCount++;
      } else {
        // ── Process inventory ──
        // Find the best inventory entry (prefer Roll over Cut for broadloom)
        let bestQty = null;
        let rollMinSqft = null;

        for (const item of result.items) {
          if (item.qty !== null && item.qty > 0) {
            inventoryDataFound++;
            // Convert SY to sqft for inventory (1 SY = 9 sqft)
            const qtySqft = item.uom === 'SY' ? Math.round(item.qty * 9) : Math.round(item.qty);
            if (bestQty === null || qtySqft > bestQty) bestQty = qtySqft;

            // Track roll minimum
            if (item.rollOrCut === 'C' && item.minQty) {
              const minSqft = item.uom === 'SY' ? Math.round(item.minQty * 9) : Math.round(item.minQty);
              rollMinSqft = minSqft;
            }
          }
        }

        if (bestQty !== null) {
          await upsertInventorySnapshot(pool, sku.id, 'EF-main', {
            qty_on_hand_sqft: bestQty,
            qty_in_transit_sqft: 0,
          });
          inventoryUpdated++;
        }

        // ── Process pricing ──
        // EF PriceInquiry returns dealer cost per SY (for broadloom/tile)
        // Find Roll price and Cut price
        let rollPrice = null, cutPrice = null;
        let primaryPrice = null;

        for (const item of result.items) {
          if (item.price === null) continue;
          const flag = item.rollOrCut;

          if (flag === 'R') {
            rollPrice = item.price;
            if (primaryPrice === null) primaryPrice = item.price;
          } else if (flag === 'C') {
            cutPrice = item.price;
            if (primaryPrice === null) primaryPrice = item.price;
          } else {
            if (primaryPrice === null) primaryPrice = item.price;
          }
        }

        if (primaryPrice !== null) {
          pricingDataFound++;

          // Determine price basis from sell_by
          const isSqyd = sku.sell_by === 'sqyd';
          const isUnit = sku.sell_by === 'unit';

          if (isSqyd) {
            // Broadloom carpet: cost is per SY, store as cut_cost / roll_cost
            const pricingData = {
              price_basis: 'per_sqyd',
            };
            if (cutPrice !== null) pricingData.cut_cost = parseFloat(cutPrice.toFixed(2));
            if (rollPrice !== null) pricingData.roll_cost = parseFloat(rollPrice.toFixed(2));
            if (rollMinSqft !== null) pricingData.roll_min_sqft = rollMinSqft;
            // Also update base cost (per sqft) = per SY / 9
            pricingData.cost = parseFloat(((cutPrice || rollPrice || primaryPrice) / 9).toFixed(4));
            await upsertPricing(pool, sku.id, pricingData);
          } else if (isUnit) {
            // Transitions/accessories: price per unit
            await upsertPricing(pool, sku.id, {
              cost: parseFloat(primaryPrice.toFixed(2)),
              price_basis: 'per_unit',
            });
          } else {
            // Carpet tile / LVP: price per SY, convert to per sqft
            const costPerSqft = parseFloat((primaryPrice / 9).toFixed(4));
            await upsertPricing(pool, sku.id, {
              cost: costPerSqft,
              price_basis: 'per_sqft',
            });
          }
          pricingUpdated++;
        }
      }

      await sleep(cfg.batch_delay_ms);

    } catch (err) {
      errCount++;
      if (errCount <= 20) {
        await addJobError(pool, job.id, { message: `Exception for ${vendorSku}: ${err.message}` });
      }
    }

    processed++;
    if (processed % batchSize === 0) {
      await appendLog(pool, job.id,
        `Progress: ${processed}/${skus.length} SKUs (${inventoryDataFound} inv, ${pricingDataFound} price, ${noDataCount} no data, ${errCount} errors)`);
    }
  }

  // ── Step 4: Log summary ──
  await appendLog(pool, job.id, [
    `EF Web Services sync complete.`,
    `  SKUs checked: ${processed}`,
    `  Inventory found: ${inventoryDataFound} → ${inventoryUpdated} snapshots upserted`,
    `  Pricing found: ${pricingDataFound} → ${pricingUpdated} upserted`,
    `  No data returned: ${noDataCount}`,
    `  Errors: ${errCount}`,
  ].join('\n'), {
    products_found: processed,
    products_updated: inventoryUpdated + pricingUpdated,
    skus_created: 0,
  });
}
