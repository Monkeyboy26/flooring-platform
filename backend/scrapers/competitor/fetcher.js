/**
 * Competitor price fetcher — resolves our SKUs to reputable competitor listings
 * (anchor: Home Depot / Lowe's) and records their EVERYDAY price into
 * competitor_prices for the repricing engine (engine.js) to consume.
 *
 * Two phases, by design:
 *   1. MATCH (expensive, one-time per SKU): find the competitor's product URL +
 *      their model/internet number and store it. Gated by match_status='pending'
 *      until a human confirms in the admin queue — bad matches poison pricing.
 *   2. REFRESH (cheap, recurring): re-fetch known URLs for a fresh everyday price.
 *
 * SOURCING NOTE (decision pending, owner 2026-11-12): Home Depot & Lowe's sit
 * behind Akamai bot protection that blocks headless Puppeteer from datacenter IPs
 * unreliably. Three backends are possible — pick one before wiring a cron:
 *   (a) 'puppeteer' — the base.js stack; authentic but flaky/high-maintenance.
 *   (b) 'serpapi'   — SerpApi Home Depot/Lowe's engines; reliable structured
 *                     price+model+stock, ~$50-75/mo. Set SERPAPI_KEY.
 *   (c) 'manual'    — agent/human seeds competitor_prices for the pilot set
 *                     (what the initial shadow-mode pilot uses). Zero infra.
 * Only the backend module changes; the normalize/upsert/engine layers are shared.
 *
 * MATCHING CAVEAT discovered 2026-11-12: Home Depot relabels MSI Everlife LVP
 * under its "A&A Surfaces" house brand with mangled model codes (our
 * VTRBAYBLO7X48 -> HD VTRCOBAYBLO7X48 "Bayfield Blonde"). So vendor_sku-exact
 * matching to HD works for MSI porcelain/stone but NOT MSI LVP — LVP should match
 * against Floor & Decor / specialty sellers that keep the real MSI codes.
 */

// --- unit normalization ----------------------------------------------------
// Competitors quote tile per sq.ft. OR per case ("$67.36 /case, 16 sq.ft.").
// Normalize everything to OUR sell-by so the engine compares apples to apples.
// Returns { pricePerUnit, unit } or null if it can't be made comparable.
export function normalizePrice({ price, unitLabel, caseSqft, sellBy }) {
  const p = Number(price);
  if (!(p > 0)) return null;
  const label = String(unitLabel || '').toLowerCase();
  const wantSqft = sellBy === 'per_sqft' || sellBy == null;

  // Per-case / per-carton price -> divide by coverage to get $/sqft.
  if (/case|carton|box|pallet/.test(label)) {
    if (wantSqft && caseSqft > 0) return { pricePerUnit: round2(p / caseSqft), unit: 'sqft' };
    return null; // can't normalize a case price without coverage
  }
  // Already per sq.ft.
  if (/sq\.?\s*ft|sqft|\/\s*ft|square\s*foot/.test(label)) {
    return wantSqft ? { pricePerUnit: round2(p), unit: 'sqft' } : null;
  }
  // Per piece / each.
  if (/each|\/\s*ea|piece|\bpc\b/.test(label)) {
    return wantSqft ? null : { pricePerUnit: round2(p), unit: 'ea' };
  }
  // Unlabeled: trust it matches our sell-by.
  return { pricePerUnit: round2(p), unit: wantSqft ? 'sqft' : 'ea' };
}
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// --- upsert ----------------------------------------------------------------
// Record one competitor observation. New matches land as 'pending' (await human
// confirm); refreshes of an already-confirmed row keep their confirmed status.
export async function upsertCompetitorPrice(pool, {
  sku_id, competitor, competitor_sku, competitor_url,
  everyday_price, sale_price, unit, raw_price, raw_unit, in_stock,
  match_method, match_confidence, confirm = false,
}) {
  await pool.query(
    `INSERT INTO competitor_prices
       (sku_id, competitor, competitor_sku, competitor_url, everyday_price, sale_price,
        unit, raw_price, raw_unit, in_stock, match_method, match_confidence,
        match_status, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CURRENT_TIMESTAMP)
     ON CONFLICT (sku_id, competitor) DO UPDATE SET
       competitor_sku = COALESCE(EXCLUDED.competitor_sku, competitor_prices.competitor_sku),
       competitor_url = COALESCE(EXCLUDED.competitor_url, competitor_prices.competitor_url),
       everyday_price = EXCLUDED.everyday_price,
       sale_price     = EXCLUDED.sale_price,
       unit           = COALESCE(EXCLUDED.unit, competitor_prices.unit),
       raw_price      = EXCLUDED.raw_price,
       raw_unit       = EXCLUDED.raw_unit,
       in_stock       = EXCLUDED.in_stock,
       match_method   = COALESCE(EXCLUDED.match_method, competitor_prices.match_method),
       match_confidence = GREATEST(competitor_prices.match_confidence, EXCLUDED.match_confidence),
       -- a refresh never downgrades a human-confirmed match back to pending
       match_status = CASE WHEN competitor_prices.match_status = 'confirmed'
                           THEN 'confirmed' ELSE EXCLUDED.match_status END,
       scraped_at = CURRENT_TIMESTAMP`,
    [sku_id, competitor, competitor_sku || null, competitor_url || null,
     everyday_price ?? null, sale_price ?? null, unit || null,
     raw_price ?? null, raw_unit || null, in_stock ?? null,
     match_method || null, match_confidence ?? 0,
     confirm ? 'confirmed' : 'pending']
  );
}

// --- backend dispatch ------------------------------------------------------
// Resolve+fetch a competitor everyday price for one SKU. Backend modules live
// alongside this file (e.g. ./backends/puppeteer.js) and export fetchPrice({
// vendorSku, productName, competitor }) -> { everyday_price, sale_price,
// raw_price, raw_unit, caseSqft, competitor_sku, competitor_url, in_stock }.
export async function fetchPrice(backend, args) {
  if (!backend || typeof backend.fetchPrice !== 'function') {
    throw new Error('fetcher: no backend configured (puppeteer|serpapi|manual). See SOURCING NOTE in fetcher.js');
  }
  return backend.fetchPrice(args);
}

// Match-confidence heuristic for a resolved listing: exact model-number hit is
// gold; name-only is weak and should stay 'pending' for human review.
export function scoreMatch({ ourVendorSku, theirModel, ourName, theirName }) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = norm(ourVendorSku), b = norm(theirModel);
  if (a && b && (a === b || a.startsWith(b) || b.startsWith(a))) return { method: 'vendor_sku_exact', confidence: 100 };
  // token overlap on the product name as a weak fallback
  const at = new Set(String(ourName || '').toLowerCase().split(/\W+/).filter(Boolean));
  const bt = String(theirName || '').toLowerCase().split(/\W+/).filter(Boolean);
  const hit = bt.filter(t => at.has(t)).length;
  const conf = Math.min(60, Math.round((hit / Math.max(1, at.size)) * 60));
  return { method: 'model_fuzzy', confidence: conf };
}
