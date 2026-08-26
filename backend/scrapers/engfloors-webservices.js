/**
 * Engineered Floors — fcB2B Web Services Integration
 *
 * Polls EF's fcB2B PriceInquiry endpoint for real-time pricing and inventory
 * data on all active EF SKUs in the database.
 *
 * PriceInquiry returns both price AND available quantity per SKU, with separate
 * entries for Roll (R) and Cut (C) availability. For soft surface (SY basis)
 * its quantities are full precision, but for LVT/hard surface (SF basis) the
 * AvailableQuantity field is truncated to a single character (1490 SF comes
 * back as "1", 733 SF as "7" — confirmed live 2026-07-26). InventoryInquiry
 * returns the full LVT quantity (and empty AvailableItems for soft surface),
 * so SF-basis quantities are re-queried there.
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
 *   batch_delay_ms — per-worker delay between requests (default: 200)
 *   concurrency — parallel request workers, 1-8 (default: 4)
 *
 * Note: serviceDiscovery advertises PriceInquiry as a "multiple item request"
 * but the endpoint is single-item in practice (probed 2026-07-26: repeated
 * SupplierItemSKU params use only the last value, comma lists match nothing,
 * POST bodies are ignored) — hence per-SKU calls with a keep-alive agent.
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

// SECURITY: no hardcoded credential fallbacks. These are live vendor B2B API keys
// and must come from the environment; missing values are left blank so callers
// fail loudly rather than silently using committed secrets.
const DEFAULT_CONFIG = {
  api_key: process.env.EF_B2B_API_KEY || '',
  secret_key: process.env.EF_B2B_SECRET_KEY || '',
  client_id: process.env.EF_CLIENT_ID || '',
  base_url: 'https://www.engfloors.info/B2B',
  batch_delay_ms: 200,
  concurrency: 4,
};

// The EF endpoint has unresponsive windows (July 2026: hung requests and
// runaway XML parsing wedged the API process for hours). Bound everything:
// response size, consecutive network failures, and total run time.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONSECUTIVE_FAILURE_LIMIT = 10;
const BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFFS = 3;
const TIME_BUDGET_MS = 3.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url, timeoutMs = 15000, deadlineMs = 30000, agent = undefined) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    // Hard deadline: reject directly — req.destroy(err) does NOT reliably emit
    // 'error' once a response has started streaming, so relying on it leaves
    // the promise unsettled forever.
    const deadline = setTimeout(() => {
      settle(reject, new Error(`Request deadline exceeded (${deadlineMs}ms)`));
      req.destroy();
    }, deadlineMs);
    const req = https.get({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { 'Accept': 'text/xml, application/xml' },
      timeout: timeoutMs,
      agent,
    }, (res) => {
      // Guard for the rejectUnauthorized:false agent: tolerate ONLY the
      // expired-cert error, and require the peer to actually be engfloors.info
      // signed by DigiCert — anything else is treated as a hard TLS failure.
      const sock = res.socket;
      if (sock && sock.authorizationError && sock.authorizationError !== 'CERT_HAS_EXPIRED') {
        settle(reject, new Error(`TLS validation failed: ${sock.authorizationError}`));
        req.destroy();
        return;
      }
      if (sock && sock.authorizationError === 'CERT_HAS_EXPIRED' && !sock.__efIdentityOk) {
        // Verify identity once per socket: on keep-alive REUSED sockets Node
        // returns an empty object from getPeerCertificate(), which would fail
        // the check spuriously. TLS guarantees the peer cannot change on an
        // established connection, so a socket that passed once stays trusted.
        const cert = sock.getPeerCertificate();
        const cn = (cert && cert.subject && cert.subject.CN) || '';
        const issuerO = (cert && cert.issuer && cert.issuer.O) || '';
        if (!/(^|\.)engfloors\.info$/.test(cn) || !/DigiCert/i.test(issuerO)) {
          settle(reject, new Error(`TLS identity mismatch on expired cert: CN=${cn} issuer=${issuerO}`));
          req.destroy();
          return;
        }
        sock.__efIdentityOk = true;
      }
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > MAX_BODY_BYTES) {
          settle(reject, new Error(`Response exceeded ${MAX_BODY_BYTES} bytes`));
          req.destroy();
        }
      });
      res.on('end', () => settle(resolve, { status: res.statusCode, body: data }));
      // Peer dropped mid-response: 'end' never fires and no 'error' reaches req.
      res.on('aborted', () => settle(reject, new Error('Response aborted mid-stream')));
      res.on('close', () => settle(reject, new Error('Connection closed before response completed')));
    });
    req.on('error', (err) => settle(reject, err));
    req.on('timeout', () => {
      settle(reject, new Error('Request timeout'));
      req.destroy();
    });
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

/**
 * Extract all occurrences of a repeating XML element and return their inner XML.
 * indexOf-based: the previous lazy dot-all regex was quadratic on malformed
 * bodies (unclosed tags) and could block the event loop for hours.
 */
function xmlAll(xml, tag) {
  const results = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  while (true) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;
    // Tag-name boundary: don't let <AvailableItem match <AvailableItems>
    const next = xml.charAt(start + open.length);
    if (next !== '>' && next !== ' ' && next !== '\t' && next !== '\r' && next !== '\n' && next !== '/') {
      pos = start + open.length;
      continue;
    }
    const openEnd = xml.indexOf('>', start);
    if (openEnd === -1) break;
    const end = xml.indexOf(close, openEnd + 1);
    if (end === -1) break;
    results.push(xml.slice(openEnd + 1, end));
    pos = end + close.length;
  }
  return results;
}

/** Extract the inner XML of the first <tag>…</tag> section (no attributes). */
function xmlSection(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(`</${tag}>`, start + open.length);
  if (end === -1) return null;
  return xml.slice(start + open.length, end);
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
async function priceInquiry(baseUrl, config, sku, agent) {
  const url = buildUrl(baseUrl, 'PriceInquiry', config, sku);
  const res = await httpsGet(url, 15000, 30000, agent);
  if (res.status !== 200) return { available: false, items: [], error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { available: false, items: [], error: err.message };

  const items = [];
  const availableItems = xmlAll(res.body, 'AvailableItem');

  if (availableItems.length === 0) {
    // Try flat structure (single item directly inside AvailableItems)
    const avSection = xmlSection(res.body, 'AvailableItems');
    if (avSection && avSection.trim()) {
      const price = xmlText(avSection, 'Price');
      const qtyRaw = xmlText(avSection, 'AvailableQuantity');
      if (price || (qtyRaw && qtyRaw !== 'NA')) {
        items.push({
          qty: (qtyRaw && qtyRaw !== 'NA' && qtyRaw !== '') ? parseFloat(qtyRaw) : null,
          price: price ? parseFloat(price) : null,
          uom: xmlText(avSection, 'AvailableUnitOfMeasure') || 'SY',
          rollOrCut: (xmlText(avSection, 'RollOrCutFlag') || '').toUpperCase().charAt(0) || null,
          minQty: parseFloat(xmlText(avSection, 'MinimumQuantityRestriction') || '0') || null,
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

/**
 * Call InventoryInquiry for a single SKU. Only LVT/hard surface items return
 * quantities here (soft surface comes back with empty AvailableItems), but
 * unlike PriceInquiry the quantity is full precision.
 */
async function inventoryInquiry(baseUrl, config, sku, agent) {
  const url = buildUrl(baseUrl, 'InventoryInquiry', config, sku);
  const res = await httpsGet(url, 15000, 30000, agent);
  if (res.status !== 200) return { items: [], error: `HTTP ${res.status}` };

  const err = xmlError(res.body);
  if (err) return { items: [], error: err.message };

  const items = xmlAll(res.body, 'AvailableItem').map((itemXml) => {
    const qtyRaw = xmlText(itemXml, 'AvailableQuantity');
    return {
      qty: (qtyRaw && qtyRaw !== 'NA' && qtyRaw !== '') ? parseFloat(qtyRaw) : null,
      uom: xmlText(itemXml, 'AvailableUnitOfMeasure') || 'SF',
    };
  });
  return { items, error: null };
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

  // ── Step 2b: Find SKUs that already have pricing rows ──
  // The web services API only provides dealer cost, not retail_price.
  // pricing.retail_price is NOT NULL, so we can only UPDATE existing rows
  // (COALESCE preserves the existing retail_price). For SKUs without a
  // pricing row we must skip the cost-only upsert.
  const pricingResult = await pool.query(`
    SELECT pr.sku_id FROM pricing pr
    JOIN skus s ON pr.sku_id = s.id
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
  `, [vendorId]);
  const skusWithPricing = new Set(pricingResult.rows.map(r => r.sku_id));
  await appendLog(pool, job.id, `${skusWithPricing.size} of ${skus.length} SKUs have existing pricing rows`);

  // ── Step 3: Query PriceInquiry for each SKU ──
  let inventoryUpdated = 0, pricingUpdated = 0, errCount = 0;
  let inventoryDataFound = 0, pricingDataFound = 0, noDataCount = 0;
  let pricingSkipped = 0;
  const batchSize = 100;
  let processed = 0;
  let consecutiveFailures = 0, backoffsUsed = 0;
  let abortReason = null, timeBudgetHit = false;
  const runStart = Date.now();

  const concurrency = Math.max(1, Math.min(8, parseInt(cfg.concurrency, 10) || 4));
  // Keep-alive agent: reuse TLS connections across the ~4.7k requests instead
  // of a fresh handshake per call. Destroyed after the run.
  // TEMP (2026-08-25): EF let their TLS certificate expire (notAfter
  // 2026-08-23), which fails every request. Scoped workaround: accept the
  // expired cert, but the response handler still verifies the peer identity
  // (CN + DigiCert issuer) and rejects any OTHER validation failure. Remove
  // once `openssl s_client -connect www.engfloors.info:443` shows a fresh cert.
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency, rejectUnauthorized: false });
  let nextIndex = 0;
  let backoffGate = null; // Promise all workers await while backing off

  async function worker() {
    while (!abortReason && !timeBudgetHit) {
      if (backoffGate) { await backoffGate; continue; }
      if (Date.now() - runStart > TIME_BUDGET_MS) {
        timeBudgetHit = true;
        break;
      }
      const idx = nextIndex++;
      if (idx >= skus.length) break;
      const sku = skus[idx];
      const vendorSku = sku.vendor_sku;
      if (!vendorSku) continue;

      try {
        const result = await priceInquiry(baseUrl, cfg, vendorSku, agent);
        consecutiveFailures = 0;

        if (result.error) {
          errCount++;
          if (errCount <= 20) {
            await addJobError(pool, job.id, { message: `Error for ${vendorSku}: ${result.error}` });
          }
        } else if (!result.available || result.items.length === 0) {
          noDataCount++;
        } else {
          // ── Process inventory ──
          // Find the best inventory entry (prefer Roll over Cut for broadloom).
          // SY quantities are trusted as-is; SF quantities are single-character
          // truncated garbage, so any SF entry triggers an InventoryInquiry
          // follow-up for the real number.
          let bestQty = null;
          let rollMinSqft = null;
          let needsInventoryInquiry = false;

          for (const item of result.items) {
            if (item.qty !== null && item.qty > 0) {
              inventoryDataFound++;
              if (item.uom === 'SY') {
                // Convert SY to sqft for inventory (1 SY = 9 sqft)
                const qtySqft = Math.round(item.qty * 9);
                if (bestQty === null || qtySqft > bestQty) bestQty = qtySqft;
              } else {
                needsInventoryInquiry = true;
              }

              // Track roll minimum
              if (item.rollOrCut === 'C' && item.minQty) {
                const minSqft = item.uom === 'SY' ? Math.round(item.minQty * 9) : Math.round(item.minQty);
                rollMinSqft = minSqft;
              }
            }
          }

          if (needsInventoryInquiry) {
            const inv = await inventoryInquiry(baseUrl, cfg, vendorSku, agent);
            for (const item of inv.items) {
              if (item.qty !== null && item.qty > 0) {
                const qtySqft = item.uom === 'SY' ? Math.round(item.qty * 9) : Math.round(item.qty);
                if (bestQty === null || qtySqft > bestQty) bestQty = qtySqft;
              }
            }
            // On error/empty, bestQty stays null and the snapshot is skipped —
            // better to keep the previous snapshot than write a truncated digit.
            if (inv.error) {
              errCount++;
              if (errCount <= 20) {
                await addJobError(pool, job.id, { message: `InventoryInquiry error for ${vendorSku}: ${inv.error}` });
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
          let primaryPrice = null, primaryUom = null;

          for (const item of result.items) {
            if (item.price === null) continue;
            const flag = item.rollOrCut;

            if (flag === 'R') {
              rollPrice = item.price;
              if (primaryPrice === null) { primaryPrice = item.price; primaryUom = item.uom; }
            } else if (flag === 'C') {
              cutPrice = item.price;
              if (primaryPrice === null) { primaryPrice = item.price; primaryUom = item.uom; }
            } else {
              if (primaryPrice === null) { primaryPrice = item.price; primaryUom = item.uom; }
            }
          }

          if (primaryPrice !== null) {
            pricingDataFound++;

            // Skip pricing upsert for SKUs without an existing pricing row —
            // we only have dealer cost, not retail_price, and the pricing
            // table requires retail_price NOT NULL on INSERT.
            if (!skusWithPricing.has(sku.id)) {
              pricingSkipped++;
            } else {
              // Determine price basis from sell_by
              const isSqyd = sku.sell_by === 'roll';
              const isUnit = sku.sell_by === 'unit';

              if (isSqyd) {
                // Broadloom carpet: cost is per SY, store as cut_cost / roll_cost
                const pricingData = {
                  price_basis: 'per_sqyd',
                };
                if (cutPrice !== null) pricingData.cut_cost = parseFloat(cutPrice.toFixed(2));
                if (rollPrice !== null) pricingData.roll_cost = parseFloat(rollPrice.toFixed(2));
                if (rollMinSqft !== null) pricingData.roll_min_sqft = rollMinSqft;
                // Base cost stays in the same unit as retail_price (per SY) so
                // margin math is correct everywhere — matching how Shaw/Pentz store
                // carpet cost. (Previously this stored cost/9 as a per-sqft value,
                // which read as a nonsensical ~$1.60 against a per-SY retail and
                // inflated margins to ~94% on every surface but the catalog.)
                pricingData.cost = parseFloat((cutPrice || rollPrice || primaryPrice).toFixed(2));
                await upsertPricing(pool, sku.id, pricingData);
              } else if (isUnit) {
                // Transitions/accessories: price per unit
                await upsertPricing(pool, sku.id, {
                  cost: parseFloat(primaryPrice.toFixed(2)),
                  price_basis: 'per_unit',
                });
              } else {
                // Box goods (LVP / carpet tile) sold per sqft. Honor the response
                // UOM instead of assuming per-SY: EF reports hard-surface LVP per
                // SF already, and only carpet-tile-style goods come back as SY.
                // The old blind `/9` made LVP cost ~9x too low (e.g. $0.13/sf vs a
                // real ~$1.17/sf), inflating catalog margins to ~94%.
                const costPerSqft = primaryUom === 'SY'
                  ? parseFloat((primaryPrice / 9).toFixed(4))
                  : parseFloat(primaryPrice.toFixed(4));
                await upsertPricing(pool, sku.id, {
                  cost: costPerSqft,
                  price_basis: 'per_sqft',
                });
              }
              pricingUpdated++;
            }
          }
        }

        await sleep(cfg.batch_delay_ms);

      } catch (err) {
        errCount++;
        consecutiveFailures++;
        if (errCount <= 20) {
          await addJobError(pool, job.id, { message: `Exception for ${vendorSku}: ${err.message}` });
        }
        // First worker to hit the threshold opens the gate (synchronously, so
        // only one backoff starts); the rest pause on it at the top of the loop.
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT && !backoffGate) {
          if (backoffsUsed >= MAX_BACKOFFS) {
            abortReason = `${CONSECUTIVE_FAILURE_LIMIT} consecutive request failures after ${MAX_BACKOFFS} backoffs — endpoint unresponsive`;
            break;
          }
          backoffsUsed++;
          backoffGate = (async () => {
            await appendLog(pool, job.id,
              `${consecutiveFailures} consecutive request failures at ${processed}/${skus.length} — backing off ${Math.round(BACKOFF_MS / 60000)} min (${backoffsUsed}/${MAX_BACKOFFS})`);
            await sleep(BACKOFF_MS);
            consecutiveFailures = 0;
            backoffGate = null;
          })();
        }
      }

      processed++;
      if (processed % batchSize === 0) {
        await appendLog(pool, job.id,
          `Progress: ${processed}/${skus.length} SKUs (${inventoryDataFound} inv, ${pricingDataFound} price, ${noDataCount} no data, ${errCount} errors)`);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    agent.destroy();
  }

  // ── Step 4: Log summary ──
  const header = abortReason
    ? `EF Web Services sync ABORTED (${abortReason}).`
    : timeBudgetHit
      ? `EF Web Services sync stopped at time budget (${Math.round(TIME_BUDGET_MS / 60000)} min) — partial run.`
      : `EF Web Services sync complete.`;
  await appendLog(pool, job.id, [
    header,
    `  SKUs checked: ${processed} of ${skus.length}`,
    `  Inventory found: ${inventoryDataFound} → ${inventoryUpdated} snapshots upserted`,
    `  Pricing found: ${pricingDataFound} → ${pricingUpdated} upserted`,
    pricingSkipped ? `  Pricing skipped (no existing row): ${pricingSkipped}` : null,
    `  No data returned: ${noDataCount}`,
    `  Errors: ${errCount}`,
  ].filter(Boolean).join('\n'), {
    products_found: processed,
    products_updated: inventoryUpdated + pricingUpdated,
    skus_created: 0,
  });

  // Circuit-breaker abort → mark the job failed (and trigger the failure
  // alert email). Time-budget stops complete normally: data upserted so far
  // is already persisted and the next scheduled run picks up fresh.
  if (abortReason) {
    throw new Error(`EF Web Services sync aborted at ${processed}/${skus.length} SKUs: ${abortReason}`);
  }
}

// Exported for tests
export { httpsGet, xmlAll, xmlSection, xmlText };
