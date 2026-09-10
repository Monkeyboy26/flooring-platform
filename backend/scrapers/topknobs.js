/**
 * Top Knobs scraper — decorative cabinet hardware (knobs, pulls, hooks, backplates,
 * appliance pulls, latches) + Top Bath (towel bars/rings, tissue holders).
 *
 * Top Knobs is a BRAND of the existing "Hardware Resources" (HR) vendor — its
 * products are written under vendor code 'HR' with brand = "Top Knobs" so the
 * recognizable brand still shows on the storefront (HR itself is the sourcing
 * vendor, already onboarded via scripts/import-rom440.cjs).
 *
 * Source: https://www.topknobs.com — public Magento storefront. Each product page
 * server-renders a Magento `jsonConfig` (in a <script type="text/x-magento-init">)
 * mapping every finish → child product: item number (e.g. TK880AG), RETAIL price,
 * and image. So one plain HTTP fetch per product yields all finish-level SKUs — no
 * Puppeteer / browser needed. Catalog is enumerated from the /products.html grid.
 *
 * Pricing (owner, 2026-09-10): OUR COST = 50% of Top Knobs retail (MSRP). Our
 * selling retail is then set by the standard pricing engine (base.js upsertPricing:
 * ~1.6× cost, charm-priced to a 9-ending → ≈0.8× MSRP). The scraped MSRP is stored
 * as map_price for reference/strikethrough.
 *
 * Selling: per-unit (each) — sell_by='unit', variant_type='hardware', price_basis='per_unit'.
 *
 * Run (inside the flooring-api container, where the DB is reachable):
 *   docker compose exec -T api node run-scraper.cjs topknobs         # via harness (needs vendor_sources row — auto-created below)
 *   docker compose exec -T api node scrapers/topknobs.js             # standalone full import
 *   docker compose exec -T api node scrapers/topknobs.js --dry-run --limit=20   # no writes, sample
 *   node scrapers/topknobs.js --harvest=out.json --limit=20          # NO DB: fetch+parse to JSON (works even if DB is down)
 */

import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';
import {
  upsertProduct, upsertPricing, upsertSkuAttribute, upsertMediaAsset,
  resolveBrandId, appendLog, addJobError,
} from './base.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────
const BASE = 'https://www.topknobs.com';
const VENDOR = { code: 'HR', name: 'Hardware Resources', website: 'https://www.hardwareresources.com' };
const BRAND = { code: 'TOPKNOBS', name: 'Top Knobs', website: 'https://www.topknobs.com' };
const COST_FRACTION_OF_RETAIL = 0.5;   // our cost = 50% of Top Knobs MSRP
const OUR_MARKUP = 1.6;                 // our retail = 1.6× cost (base.js charm-rounds to a 9-ending)
const PAGE_LIMIT = 60;                  // /products.html max per-page (store allows 30/45/60)
const CONCURRENCY = 4;
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Category leaves already exist under the 'hardware-specialty' parent (created by
// import-rom440.cjs). Map Top Knobs product types → leaf slug by name keywords.
function categorySlugFor(name) {
  const t = (name || '').toLowerCase();
  // The Top Bath line ("Aqua Bath …", "… Bath Ring/Hook/Tissue Holder") → bath-hardware.
  if (/\bbath\b/.test(t) || /\b(towel bar|towel ring|tissue|toilet paper|robe hook|paper holder)\b/.test(t)) return 'bath-hardware';
  if (/\b(latch|catch)\b/.test(t)) return 'functional-hardware';
  return 'decorative-hardware'; // knobs, pulls, appliance pulls, backplates, decorative hooks
}

/** "3 3/4 INCH PULL" → `3 3/4"`; "12 INCH APP PULL" → `12" App` (the appliance
 * qualifier is KEPT — a product can offer both a 12" pull and a 12" appliance pull,
 * and dropping it would collapse them to one variant name). */
function cleanSize(label) {
  if (!label) return null;
  let s = decodeEntities(label);
  const isApp = /\bapp(liance)?\b/i.test(s);
  s = s
    .replace(/\b(inch(es)?|in|pull|knob|hook|bar|ring|holder|hardware|appliance|app|c\.?t\.?c\.?|center\s*to\s*center|overall|length|width|dia(meter)?)\b/gi, ' ')
    .replace(/["″'']/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return isApp ? 'Appliance' : null;
  if (/^\d/.test(s) && /\d/.test(s)) s = s + '"';
  if (isApp) s = s + ' App';
  return s;
}

/** SKU variant label: "Polished Chrome · 3 3/4\"" (finish + size), or just one. */
function variantLabel(v) {
  return [v.finish, v.size].filter(Boolean).join(' · ') || 'Standard';
}

// ────────────────────────────────────────────────────────────────────────────
// Pure fetch + parse helpers (no DB — usable in --harvest mode)
// ────────────────────────────────────────────────────────────────────────────
async function fetchHtml(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
      if (resp.ok) return await resp.text();
      // 4xx (except 429) won't recover on retry
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) return null;
    } catch { /* network/timeout — retry */ }
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}

/** Enumerate all current product page URLs from the /products.html grid.
 * Uses a STABLE name sort — the default "Popularity" sort is non-deterministic
 * per request, so pages overlap and pagination silently drops products
 * (observed 483 vs the true 518). Name sort yields zero page overlap → complete. */
async function enumerateProductUrls(log = () => {}) {
  const urls = new Set();
  const SORT = '&product_list_order=name&product_list_dir=asc';
  for (let page = 1; page <= 40; page++) {
    const html = await fetchHtml(`${BASE}/products.html?product_list_limit=${PAGE_LIMIT}&p=${page}${SORT}`);
    if (!html) break;
    const before = urls.size;
    const re = /<a[^>]+class="[^"]*product-item-link[^"]*"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="[^"]*product-item-link/g;
    let m;
    while ((m = re.exec(html))) {
      const href = m[1] || m[2];
      if (href) urls.add(href.split('?')[0]);
    }
    const added = urls.size - before;
    log(`grid p${page}: +${added} (total ${urls.size})`);
    if (added === 0) break; // past the last populated page
  }
  return [...urls];
}

/** Recursively locate the Magento configurable jsonConfig within an init blob. */
function findConfig(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.jsonConfig && typeof node.jsonConfig === 'object'
      && node.jsonConfig.attributes && node.jsonConfig.optionPrices) return node.jsonConfig;
  if (node.attributes && node.optionPrices && node.skus) return node;
  for (const k of Object.keys(node)) {
    const r = findConfig(node[k]);
    if (r) return r;
  }
  return null;
}

function extractJsonConfig(html) {
  const re = /<script[^>]+type="text\/x-magento-init"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    const jc = findConfig(json);
    if (jc) return jc;
  }
  return null;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Product title from the Magento page-title span. */
function parseTitle(html) {
  let m = html.match(/data-ui-id="page-title-wrapper"[^>]*>([^<]+)</);
  if (m) return decodeEntities(m[1]);
  m = html.match(/<h1[^>]*>\s*(?:<span[^>]*>)?([^<]+)</i);
  return m ? decodeEntities(m[1]) : null;
}

/** Best-effort "Collection" from the product DETAILS table. */
function parseCollection(html) {
  // <th ...>Collection</th> ... <td ...>Devon</td>  (also handles data-th="Collection")
  let m = html.match(/Collection<\/(?:th|span|strong)>[\s\S]{0,80}?<(?:td|span|div)[^>]*>\s*([^<]+?)\s*</i);
  if (m) { const v = decodeEntities(m[1]); if (v && !/^item number$/i.test(v)) return v; }
  m = html.match(/data-th="Collection"[^>]*>\s*([^<]+?)\s*</i);
  return m ? decodeEntities(m[1]) : '';
}

/** Turn a jsonConfig into per-SKU rows: {finish, size, itemNumber, retail, img}.
 * Top Knobs products carry TWO configurable axes — finish (finish_tk) and size
 * (website_center_to_center). Iterate every child product (jc.skus keys) and read
 * BOTH axis labels for it, so a 5-size × 6-finish product yields 30 DISTINCT
 * variants (finish+size) rather than 6 finishes repeated 5× with the same label. */
function parseVariants(jc) {
  const attrs = Object.values(jc.attributes || {});
  const realFinishAttr = attrs.find(a => /finish/i.test(a.code));   // genuine finish axis, if any
  const finishAttr = realFinishAttr || attrs[0];
  const sizeAttr = attrs.find(a => a !== finishAttr && /(center_to_center|size|diameter|length|width)/i.test(a.code));
  const labelFor = (attr, cid) => {
    if (!attr) return null;
    const o = (attr.options || []).find(o => (o.products || []).includes(cid));
    return o ? decodeEntities(o.label) : null;
  };
  // Children present in jc.skus but NOT offered in any finish swatch are
  // discontinued/disabled variants Magento leaves in the data — exclude them
  // (importing them yields un-selectable "Standard"-named SKUs for dead product).
  const offeredInFinish = realFinishAttr
    ? new Set(realFinishAttr.options.flatMap(o => o.products || []))
    : null;
  const rows = [];
  for (const cid of Object.keys(jc.skus || {})) {
    if (offeredInFinish && !offeredInFinish.has(cid)) continue;
    const itemNumber = jc.skus[cid];
    const po = jc.optionPrices ? jc.optionPrices[cid] : null;
    const retail = po && po.finalPrice ? Number(po.finalPrice.amount) : null;
    if (!itemNumber || !(retail > 0)) continue;
    let img = null;
    const imgs = jc.images ? jc.images[cid] : null;
    if (Array.isArray(imgs) && imgs.length) {
      // Drop the ?quality/fit/canvas resize params — the bare /media path serves
      // the original (higher-res) file and both resolve 200.
      img = (imgs[0].full || imgs[0].img || imgs[0].thumb || '').split('?')[0] || null;
    }
    rows.push({
      finish: labelFor(finishAttr, cid),
      size: cleanSize(labelFor(sizeAttr, cid)),
      itemNumber: String(itemNumber).trim(),
      retail, img,
    });
  }
  return rows;
}

/** Fetch + parse a single product page into {name, collection, category, variants[]}.
 * Retries once if the page came back with a configurable finish attribute but every
 * variant resolved to a null finish — under concurrency Magento occasionally serves
 * a page whose swatch options have empty product lists, which would otherwise land a
 * whole product's SKUs as "Standard". A fresh fetch reliably has the full mapping. */
async function scrapeProduct(url) {
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const html = await fetchHtml(url);
    if (!html) { best = best || { url, error: 'fetch-failed' }; continue; }
    const name = parseTitle(html);
    if (!name) return { url, error: 'no-title' };
    const jc = extractJsonConfig(html);
    let variants = jc ? parseVariants(jc) : [];
    // Simple (single-finish) product fallback: read the lone item number + price.
    if (!variants.length) {
      const sku = (html.match(/data-ui-id="page-title-wrapper"[\s\S]{0,4000}?Item Number[\s\S]{0,120}?>\s*([A-Z0-9][A-Z0-9.-]{2,})\s*</i) || [])[1]
               || (html.match(/"sku"\s*:\s*"([A-Z0-9][A-Z0-9.-]{2,})"/i) || [])[1];
      const price = (html.match(/data-price-type="finalPrice"[^>]*data-price-amount="([\d.]+)"/i) || [])[1]
                 || (html.match(/"finalPrice"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/i) || [])[1];
      if (sku && price && Number(price) > 0) {
        variants = [{ finish: 'Standard', size: null, itemNumber: sku.trim(), retail: Number(price), img: null }];
      }
    }
    const result = { url, name, collection: parseCollection(html), category: categorySlugFor(name), variants };
    const hadFinishAttr = jc && Object.values(jc.attributes || {}).some(a => /finish/i.test(a.code));
    const badFinishMapping = hadFinishAttr && variants.length > 1 && variants.every(v => !v.finish);
    if (!badFinishMapping) return result;
    best = result; // keep as fallback, but try once more for the full mapping
  }
  return best || { url, error: 'fetch-failed' };
}

/** Bounded-concurrency map. */
async function mapPool(items, worker, concurrency, onEach = () => {}) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
      onEach(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// DB setup helpers
// ────────────────────────────────────────────────────────────────────────────
async function ensureVendor(pool) {
  const r = await pool.query(
    `INSERT INTO vendors (id, name, code, website)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [VENDOR.name, VENDOR.code, VENDOR.website]
  );
  return r.rows[0].id;
}

async function ensureBrand(pool) {
  await pool.query(
    `INSERT INTO brands (id, name, code, website, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, true)
     ON CONFLICT (code) DO NOTHING`,
    [BRAND.name, BRAND.code, BRAND.website]
  );
  return resolveBrandId(pool, BRAND.code);
}

async function ensureVendorSource(pool, vendorId) {
  const existing = await pool.query(`SELECT id FROM vendor_sources WHERE scraper_key = 'topknobs' LIMIT 1`);
  if (existing.rows.length) return existing.rows[0].id;
  const r = await pool.query(
    `INSERT INTO vendor_sources (vendor_id, source_type, name, base_url, scraper_key, is_active)
     VALUES ($1, 'scraper', 'Top Knobs (topknobs.com)', $2, 'topknobs', true)
     RETURNING id`,
    [vendorId, BASE]
  );
  return r.rows[0].id;
}

async function resolveCategoryIds(pool) {
  const slugs = ['decorative-hardware', 'bath-hardware', 'functional-hardware'];
  const r = await pool.query(`SELECT id, slug FROM categories WHERE slug = ANY($1)`, [slugs]);
  const map = {};
  for (const row of r.rows) map[row.slug] = row.id;
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// Main scrape → DB
// ────────────────────────────────────────────────────────────────────────────
async function scrapeAll(pool, { jobId = null, limit = 0, dryRun = false } = {}) {
  const log = async (msg) => { console.log(`[topknobs] ${msg}`); if (jobId) await appendLog(pool, jobId, msg).catch(() => {}); };

  const vendorId = await ensureVendor(pool);
  const brandId = await ensureBrand(pool);
  const cats = await resolveCategoryIds(pool);
  if (!cats['decorative-hardware']) {
    throw new Error("Category 'decorative-hardware' not found — run import-rom440 first to create the hardware-specialty tree.");
  }
  if (!brandId) throw new Error('Top Knobs brand could not be resolved/created.');
  await log(`vendor HR=${vendorId} brand TopKnobs=${brandId}${dryRun ? ' [DRY RUN]' : ''}`);

  let urls = await enumerateProductUrls((m) => console.log(`[topknobs] ${m}`));
  await log(`enumerated ${urls.length} product URLs`);
  if (limit > 0) urls = urls.slice(0, limit);

  const stats = { products: 0, productsNew: 0, skus: 0, skusNew: 0, priced: 0, images: 0, fetchFailed: 0, noVariants: 0 };
  const touched = [];
  const touchedSkuIds = [];

  const parsed = await mapPool(urls, scrapeProduct, CONCURRENCY);

  for (const p of parsed) {
    if (!p || p.error) { stats.fetchFailed++; continue; }
    if (!p.variants.length) { stats.noVariants++; await log(`no variants: ${p.name || p.url}`); continue; }

    const categoryId = cats[p.category] || cats['decorative-hardware'];
    if (dryRun) {
      stats.products++; stats.skus += p.variants.length; stats.priced += p.variants.length;
      console.log(`[dry] ${p.name} [${p.category}] — ${p.variants.length} variants: ` +
        p.variants.map(v => `${v.itemNumber} ${variantLabel(v)} $${v.retail}→cost $${(v.retail * COST_FRACTION_OF_RETAIL).toFixed(2)}`).join(' | '));
      continue;
    }

    const prod = await upsertProduct(pool, {
      vendor_id: vendorId,
      name: p.name,
      collection: p.collection || '',
      category_id: categoryId,
      brand_id: brandId,
      description_short: p.name,
    }, { jobId });
    stats.products++; if (prod.is_new) stats.productsNew++;
    touched.push(prod.id);

    // Match the existing HR/ROM440 hardware convention (variant_type 'hardware' /
    // 'bath_hardware', sell_by 'unit'). base.js upsertSku would reject 'hardware'
    // (not in its VALID_VARIANT_TYPES) and null it — so upsert SKUs via raw SQL,
    // exactly as import-rom440.cjs does, to keep these consistent with their HR siblings.
    const variantType = p.category === 'bath-hardware' ? 'bath_hardware' : 'hardware';

    let sortOrder = 0;
    for (const v of p.variants) {
      const internalSku = `HR-${v.itemNumber}`;
      const variantName = variantLabel(v);
      const sRes = await pool.query(
        `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, is_sample, status)
         VALUES ($1, $2, $3, $4, 'unit', $5, false, 'active')
         ON CONFLICT (internal_sku) DO UPDATE SET
           product_id   = EXCLUDED.product_id,
           vendor_sku   = EXCLUDED.vendor_sku,
           variant_name = EXCLUDED.variant_name,
           sell_by      = 'unit',
           variant_type = EXCLUDED.variant_type,
           updated_at   = CURRENT_TIMESTAMP
         RETURNING id, (xmax = 0) AS is_new`,
        [prod.id, v.itemNumber, internalSku, variantName, variantType]
      );
      const sku = sRes.rows[0];
      stats.skus++; if (sku.is_new) stats.skusNew++;
      touchedSkuIds.push(sku.id);

      const cost = Math.round(v.retail * COST_FRACTION_OF_RETAIL * 100) / 100;
      const ourRetail = Math.round(cost * OUR_MARKUP * 100) / 100; // base.js charm-rounds down to a 9-ending
      await upsertPricing(pool, sku.id, {
        cost,
        retail_price: ourRetail,
        price_basis: 'per_unit',
        map_price: v.retail, // Top Knobs MSRP, for reference/strikethrough
      }, { jobId });
      stats.priced++;

      if (v.finish) await upsertSkuAttribute(pool, sku.id, 'finish', v.finish);
      if (v.size) await upsertSkuAttribute(pool, sku.id, 'size', v.size);

      if (v.img) {
        const url = v.img.startsWith('http') ? v.img : `${BASE}${v.img}`;
        await upsertMediaAsset(pool, {
          product_id: prod.id, sku_id: sku.id, asset_type: 'primary', url,
          original_url: url, sort_order: sortOrder,
        });
        stats.images++;
      }
      sortOrder++;
    }
  }

  // ── Activate touched products (they insert as 'draft') ──
  if (!dryRun && touched.length) {
    const act = await pool.query(
      `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1) AND status = 'draft'`,
      [touched]
    );
    await log(`activated ${act.rowCount} products`);

    // ── Prune discontinued Top Knobs items — SCOPED TO THE TOP KNOBS BRAND ONLY.
    // Critically NOT vendor-wide: these live under the shared HR vendor alongside
    // ~12K ROM440 products, so a vendor-scoped deactivation would wipe them out.
    // Guards: ≥50% of currently-active Top Knobs products were touched AND ≥80% of
    // pages fetched successfully (avoids pruning on a partial/failed crawl).
    const fetchRatio = urls.length ? (urls.length - stats.fetchFailed) / urls.length : 0;
    const guardsPass = fetchRatio >= 0.8;
    const activeTk = await pool.query(
      `SELECT id FROM products WHERE brand_id = $1 AND status = 'active'`, [brandId]
    );
    const touchedSet = new Set(touched);
    const orphans = activeTk.rows.filter(r => !touchedSet.has(r.id)).map(r => r.id);
    const coverage = activeTk.rows.length ? touched.length / activeTk.rows.length : 1;
    if (orphans.length && coverage >= 0.5 && guardsPass) {
      const de = await pool.query(
        `UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
        [orphans]
      );
      stats.deactivated = de.rowCount;
      await log(`deactivated ${de.rowCount} discontinued Top Knobs products (coverage ${(coverage * 100).toFixed(0)}%, fetch ${(fetchRatio * 100).toFixed(0)}%)`);
    } else if (orphans.length) {
      await log(`skipped pruning ${orphans.length} orphans (coverage ${(coverage * 100).toFixed(0)}%, fetch ${(fetchRatio * 100).toFixed(0)}%)`);
    }

    // ── SKU-level pruning: deactivate Top Knobs SKUs no longer offered (e.g. a
    // finish/size discontinued while the product lives on). Scoped to this brand's
    // products; only runs when the crawl was healthy so a bad fetch can't mass-kill.
    if (guardsPass && touchedSkuIds.length) {
      const deSku = await pool.query(
        `UPDATE skus SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'active'
           AND id <> ALL($1)
           AND product_id IN (SELECT id FROM products WHERE brand_id = $2)
         RETURNING id`,
        [touchedSkuIds, brandId]
      );
      stats.deactivatedSkus = deSku.rowCount;
      if (deSku.rowCount) await log(`deactivated ${deSku.rowCount} discontinued Top Knobs SKUs`);
    }
  }

  if (jobId) {
    await pool.query(
      `UPDATE scrape_jobs SET products_found=$2, products_created=$3, products_updated=$4, skus_created=$5, skus_affected=$6 WHERE id=$1`,
      [jobId, stats.products, stats.productsNew, stats.products - stats.productsNew, stats.skusNew, stats.skus]
    ).catch(() => {});
  }
  await log(`DONE — products ${stats.products} (${stats.productsNew} new), skus ${stats.skus} (${stats.skusNew} new), priced ${stats.priced}, images ${stats.images}, fetch-failed ${stats.fetchFailed}, no-variants ${stats.noVariants}`);
  return stats;
}

// ────────────────────────────────────────────────────────────────────────────
// Harness entrypoint: node run-scraper.cjs topknobs  →  run(pool, {id}, source)
// ────────────────────────────────────────────────────────────────────────────
export async function run(pool, opts = {}, _source = {}) {
  const jobId = opts.id || opts.jobId || null;
  try {
    return await scrapeAll(pool, { jobId, limit: opts.limit || 0, dryRun: !!opts.dryRun });
  } catch (e) {
    if (jobId) await addJobError(pool, jobId, e.message).catch(() => {});
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Standalone CLI
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name, def) => {
    const a = argv.find(x => x.startsWith(`--${name}`));
    if (!a) return def;
    const eq = a.indexOf('=');
    return eq === -1 ? true : a.slice(eq + 1);
  };
  const limit = parseInt(getArg('limit', '0'), 10) || 0;
  const dryRun = !!getArg('dry-run', false);
  const harvest = getArg('harvest', false);

  // --harvest: NO DB. Fetch + parse the catalog to a JSON file. Works even when
  // Postgres/Docker is down — lets you validate the parser and inspect the data.
  if (harvest) {
    const outPath = typeof harvest === 'string' ? harvest : 'topknobs-harvest.json';
    let urls = await enumerateProductUrls((m) => console.log(`[topknobs] ${m}`));
    console.log(`[topknobs] enumerated ${urls.length} product URLs`);
    if (limit > 0) urls = urls.slice(0, limit);
    let done = 0;
    const parsed = await mapPool(urls, scrapeProduct, CONCURRENCY, () => {
      if (++done % 25 === 0) console.log(`[topknobs] parsed ${done}/${urls.length}`);
    });
    const ok = parsed.filter(p => p && !p.error && p.variants.length);
    const skuCount = ok.reduce((n, p) => n + p.variants.length, 0);
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
    console.log(`[topknobs] HARVEST → ${outPath}: ${ok.length}/${urls.length} products, ${skuCount} SKUs`);
    return;
  }

  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  try {
    let jobId = null;
    if (!dryRun) {
      const vendorId = await ensureVendor(pool);
      const sourceId = await ensureVendorSource(pool, vendorId);
      const job = await pool.query(
        `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id`,
        [sourceId]
      );
      jobId = job.rows[0].id;
      console.log(`[topknobs] job ${jobId}`);
    }
    await scrapeAll(pool, { jobId, limit, dryRun });
    if (jobId) await pool.query(`UPDATE scrape_jobs SET status='completed', completed_at=NOW() WHERE id=$1`, [jobId]);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
