import fs from 'fs';
import path from 'path';
import { upsertPricing, upsertMediaAsset, appendLog, addJobError } from './base.js';

/**
 * Mapei Unified Pipeline — cost, retail, names, and images from Lowe's.
 *
 * Replaces the old 3-piece Mapei flow (Daltile-832 pricing + mapeihome.com image
 * enrichment + Floor & Decor per-color images). Business rule (2026-07-27, rev 2 —
 * the Big D CSP is Roma's NET buy price: per-account sheet, ~70% of street retail):
 *   sheet-priced items:  cost = sheet price, retail = 1.6x nickel-rounded
 *   Lowe's-priced items: retail = Lowe's shelf price AS-IS (that's already retail;
 *                        marking it up 1.6x would price us over market), cost untouched
 *   images = lowes.com product photos (mobileimages.lowes.com CDN)
 *
 * Input: data/lowes-mapei-catalog.json — harvested from lowes.com in a real
 * browser session (Akamai blocks all server-side fetches; see the harvest notes
 * in the dev endpoint in server.js). Refresh = re-run the browser harvest.
 *
 * Matching tiers against the 302-item Lowe's catalog:
 *   1. exact   — Mapei part code in variant/product name equals a Lowe's model
 *                (Daltile writes color block 5xxx as 0xxx; normalized before compare)
 *                → price + rename + per-product Lowe's images
 *   2. family  — alphanumeric code family (line prefix + package suffix) has
 *                Lowe's items in other colors → median family price; image only
 *                if the product has none
 *   3. numeric — curated map for Daltile's 5-digit legacy codes
 *                ([line][color-last-2][size]): lines 3/9 size '10' = Keracolor
 *                10-lb → Lowe's Keracolor 10-lb price
 *   4. none    — no Lowe's evidence → pricing left untouched, counted in report
 *
 * BIGD gap-fill SKUs (created by lowes-mapei.js): repriced from Lowe's Keracolor
 * anchors (S = sanded 25-lb, U = unsanded 10-lb); Floor & Decor per-color images
 * are swapped for the Lowe's same-color bag shot where Lowe's stocks the color.
 * Keracaulk and pro thinsets Lowe's doesn't carry stay untouched.
 *
 * Every pricing/name/media row is backed up to data/mapei-unified-backup-*.json
 * before the first write.
 *
 * CLI: docker compose exec api node scrapers/mapei-unified.js [--dry]
 */

const CATALOG_PATH = 'data/lowes-mapei-catalog.json';
const PRICESHEET_PATH = 'data/bigd-mapei-pricesheet.json';
const STANDARD_MARKUP = 1.6;
const IMG_HOST = 'https://mobileimages.lowes.com';

const nickel = (n) => Math.round(n * STANDARD_MARKUP / 0.05) * 0.05;
const money = (n) => Math.round(n * 100) / 100;

// ─── Lowe's catalog indexing ─────────────────────────────────────────────────

function absImg(u) {
  if (!u) return null;
  return u.startsWith('/') ? IMG_HOST + u : u;
}

/** 6BU509305 → { fam: '6BU-05', color: '5093' }; Daltile 0xxx color → 5xxx */
function alnumParts(code) {
  const m = /^([0-9])([A-Z]{2})(\d{4})(\d{2})$/.exec(code);
  if (!m) return null;
  let color = m[3];
  if (color.startsWith('0')) color = '5' + color.slice(1);
  return { fam: `${m[1]}${m[2]}-${m[4]}`, color };
}

function normalizeCode(code) {
  const c = code.toUpperCase();
  const m = /^([0-9])([A-Z]{2})(\d{4})(\d{2})$/.exec(c);
  if (m && m[3].startsWith('0')) return `${m[1]}${m[2]}5${m[3].slice(1)}${m[4]}`;
  return c;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cleanDesc(desc) {
  const unitWord = (u) => /pound/i.test(u) ? 'lb' : /gal/i.test(u) ? 'Gal' : /quart/i.test(u) ? 'Qt' : 'fl oz';
  return desc
    // "( 50 Pound(s) )" / "( 1 - Gallons )" → "(50 lb)" / "(1 Gal)"
    .replace(/\(\s*(\d+(?:\.\d+)?)\s*(?:-\s*)?(Pound\(s\)|Gallons?|Quarts?|Fluid ounce\(s\))\s*\)/gi,
      (_, n, u) => `(${n} ${unitWord(u)})`)
    // inline "8 Fluid ounce(s)" / "50 Pound(s)" / "1 Quart(s)" / "1 Gallon(s)"
    .replace(/(\d+(?:\.\d+)?)\s*(Pound\(s\)|Gallon\(s\)|Quart\(s\)|Fluid ounce\(s\))/gi,
      (_, n, u) => `${n} ${unitWord(u)}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCatalog() {
  const raw = fs.readFileSync(path.resolve(CATALOG_PATH), 'utf8');
  const items = JSON.parse(raw);

  const byModel = new Map();
  const byFamily = new Map(); // fam key → items[]
  const byName = new Map();   // our deterministic product name → item
  for (const it of items) {
    it.img = absImg(it.img);
    byModel.set(it.model.toUpperCase(), it);
    // Renamed products carry 'Mapei ' + cleanDesc(desc) as their name and no
    // longer contain a part code — name lookup keeps them matchable on re-runs.
    byName.set(('mapei ' + cleanDesc(it.desc)).toLowerCase(), it);
    const p = alnumParts(it.model.toUpperCase());
    if (p) {
      if (!byFamily.has(p.fam)) byFamily.set(p.fam, []);
      byFamily.get(p.fam).push(it);
    }
  }

  // Anchors for numeric legacy codes + BIGD lines
  const priceWhere = (re) => {
    const hits = items.filter(x => re.test(x.desc)).map(x => x.price);
    return hits.length ? median(hits) : null;
  };
  const anchors = {
    keracolorUnsanded10: priceWhere(/^Keracolor .*Unsanded Grout \(10-lb\)/),
    keracolorSanded25: priceWhere(/^Keracolor .*Sanded Grout \(25-lb\)/),
  };

  return { items, byModel, byFamily, byName, anchors };
}

// ─── Big D price sheet (authoritative cost when present) ────────────────────
//
// data/bigd-mapei-pricesheet.json is the customer-specific price sheet from
// Big D Floor Covering Supplies (Roma Flooring CSP). When an item is on the
// sheet, that IS what we pay — it beats the Lowe's shelf-price approximation.
// Lookup order: exact code → 5-digit prefix for 7-digit+USA codes (Daltile and
// the sheet use different 2-digit package suffixes for the same bag) →
// wildcard color families like 6BU5XXX11 (one price for all stocking colors).

function loadPriceSheet() {
  let sheet;
  try {
    sheet = JSON.parse(fs.readFileSync(path.resolve(PRICESHEET_PATH), 'utf8'));
  } catch {
    return null;
  }
  const byCode = new Map();
  const byPrefix = new Map();
  const wildcards = [];
  for (const it of sheet.items) {
    if (!it.code) continue;
    const code = it.code.toUpperCase().replace(/USA?$/, '');
    if (code.includes('XXX')) {
      wildcards.push({ re: new RegExp('^' + code.replace('XXX', '\\d{3}') + '$'), price: it.price, desc: it.desc });
      continue;
    }
    byCode.set(code, it.price);
    const pm = /^(\d{5})\d{2}$/.exec(code);
    if (pm && !byPrefix.has(pm[1])) byPrefix.set(pm[1], it.price);
  }
  const lookup = (rawCode) => {
    if (!rawCode) return null;
    const code = normalizeCode(rawCode).replace(/USA?$/, '');
    if (byCode.has(code)) return byCode.get(code);
    const pm = /^(\d{5})\d{2}$/.exec(code);
    if (pm && byPrefix.has(pm[1])) return byPrefix.get(pm[1]);
    for (const w of wildcards) if (w.re.test(code)) return w.price;
    return null;
  };
  return { source: sheet.source, count: sheet.items.length, lookup };
}

// ─── DB-side code extraction ─────────────────────────────────────────────────

const CODE_RE = /\b([0-9][A-Z]{2}\d{6}|\d{5,8}(?:USA)?)\b/g;

function extractCodes(...texts) {
  const out = [];
  for (const t of texts) {
    if (!t) continue;
    const up = t.toUpperCase();
    let m;
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(up)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * Match one DB SKU against the Big D price sheet + Lowe's catalog.
 * The sheet is the cost authority; Lowe's supplies names/images and the cost
 * fallback for items Big D doesn't stock.
 * Returns { tier, item?, price, costSource } or null.
 */
function matchSku(row, catalog, sheet) {
  // vendor_sku holds the Mapei part code (backfilled 2026-07-27; Big D orders
  // reference these). Variant/product names may or may not still contain one.
  const codes = extractCodes(row.vendor_sku, row.variant_name, row.product_name);

  let sheetPrice = null;
  for (const c of codes) {
    const p = sheet?.lookup(c);
    if (p != null) { sheetPrice = p; break; }
  }

  let hit = null;
  for (const c of codes) {
    const item = catalog.byModel.get(normalizeCode(c)) || catalog.byModel.get(c);
    if (item) { hit = { tier: 'exact', item, price: item.price }; break; }
  }
  // Name lookup covers renamed products that lost their codes — but only for
  // single-SKU products: a product grouping several sizes must match per-code
  // or its SKUs would all inherit one size's price.
  if (!hit && Number(row.product_sku_count) === 1) {
    const nameHit = catalog.byName.get((row.product_name || '').toLowerCase());
    if (nameHit) hit = { tier: 'exact', item: nameHit, price: nameHit.price };
  }
  if (!hit) {
    for (const c of codes) {
      const p = alnumParts(normalizeCode(c));
      if (p && catalog.byFamily.has(p.fam)) {
        const fam = catalog.byFamily.get(p.fam);
        hit = { tier: 'family', item: fam[0], price: median(fam.map(x => x.price)) };
        break;
      }
    }
  }
  if (!hit) {
    // Numeric legacy: [line][color2][size2] — only Keracolor 10-lb is certain
    for (const c of codes) {
      const m = /^(\d)(\d{2})(10)$/.exec(c);
      if (m && (m[1] === '3' || m[1] === '9') && catalog.anchors.keracolorUnsanded10) {
        hit = { tier: 'numeric', item: null, price: catalog.anchors.keracolorUnsanded10 };
        break;
      }
    }
  }

  if (hit) {
    // Even when the DB code only matched Lowe's, the Lowe's model may be on the sheet
    if (sheetPrice == null && hit.item) sheetPrice = sheet?.lookup(hit.item.model);
    if (sheetPrice != null) return { ...hit, price: sheetPrice, costSource: 'sheet' };
    return { ...hit, costSource: 'lowes' };
  }
  if (sheetPrice != null) return { tier: 'sheet', item: null, price: sheetPrice, costSource: 'sheet' };
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function run(pool, job, source, opts = {}) {
  const dry = !!opts.dry;
  const log = async (msg, counters) => {
    if (job?.id) await appendLog(pool, job.id, msg, counters);
    else console.log(msg);
  };
  const jobError = async (msg) => {
    if (job?.id) await addJobError(pool, job.id, msg);
    else console.error('ERROR:', msg);
  };

  const catalog = loadCatalog();
  const sheet = loadPriceSheet();
  await log(`Mapei unified pipeline${dry ? ' (DRY RUN)' : ''}: ${catalog.items.length} Lowe's items loaded; ` +
    `anchors: Keracolor 10-lb $${catalog.anchors.keracolorUnsanded10}, 25-lb $${catalog.anchors.keracolorSanded25}`);
  await log(sheet
    ? `Cost authority: Big D price sheet (${sheet.count} Mapei rows) — ${sheet.source}`
    : `No Big D price sheet found at ${PRICESHEET_PATH} — falling back to Lowe's prices as cost`);

  // ── Load target SKUs ──────────────────────────────────────────────────────
  const dal = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name, s.vendor_sku,
           p.name AS product_name, pr.cost, pr.retail_price, pr.retail_locked,
           COUNT(*) OVER (PARTITION BY p.id) AS product_sku_count
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    -- All Mapei lives under Big D Supply since 2026-07-27 (vendor move; the
    -- Daltile 832 import now skips Mapei rows). Published products carry
    -- per-line collections (Flexcolor CQ, Keracolor, ...) with brand_id=MAPEI;
    -- legacy rows still say 'Mapei Corporation'.
    WHERE v.code = 'BIGD'
      AND (p.collection = 'Mapei Corporation'
           OR p.brand_id = (SELECT id FROM brands WHERE code = 'MAPEI'))
    ORDER BY p.name, s.variant_name
  `);

  const bigd = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name, s.vendor_sku,
           p.name AS product_name, pr.cost, pr.retail_price, pr.retail_locked
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code = 'BIGD'
      AND (p.collection ILIKE '%mapei%' OR p.name ILIKE '%mapei%'
           OR p.brand_id = (SELECT id FROM brands WHERE code = 'MAPEI'))
    ORDER BY p.name, s.variant_name
  `);

  await log(`Targets: ${dal.rows.length} Daltile Mapei SKUs, ${bigd.rows.length} Big D Supply SKUs`);

  // ── Backup ────────────────────────────────────────────────────────────────
  const backup = { created_at: new Date().toISOString(), pricing: [], product_names: [], media: [] };
  const stats = {
    exact: 0, family: 0, numeric: 0, fingerprint: 0, sheet: 0, untouched: 0, locked: 0,
    costFromSheet: 0, costFromLowes: 0,
    retailUp: 0, retailDown: 0, renamed: 0, imagesReplaced: 0,
    bigdRepriced: 0, bigdImagesSwapped: 0, bigdImagesKeptFD: 0, errors: 0,
  };

  const backedUpProducts = new Set();
  async function backupProduct(productId) {
    if (backedUpProducts.has(productId)) return;
    backedUpProducts.add(productId);
    const p = await pool.query('SELECT id, name FROM products WHERE id = $1', [productId]);
    backup.product_names.push(p.rows[0]);
    const m = await pool.query('SELECT * FROM media_assets WHERE product_id = $1', [productId]);
    backup.media.push(...m.rows);
  }

  // ── Apply helpers ─────────────────────────────────────────────────────────
  // products has UNIQUE (vendor_id, collection, name) — seed with every existing
  // DAL Mapei name so a rename never collides with a product we aren't touching
  // (Daltile lists some Lowe's items twice under different item numbers).
  const renamedTargets = new Set();
  const existingNames = await pool.query(`
    SELECT p.name FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'BIGD'
      AND (p.collection = 'Mapei Corporation'
           OR p.brand_id = (SELECT id FROM brands WHERE code = 'MAPEI'))
  `);
  existingNames.rows.forEach(r => renamedTargets.add(r.name));

  async function applyPrice(row, price, costSource) {
    backup.pricing.push({ sku_id: row.sku_id, cost: row.cost, retail_price: row.retail_price });
    // Sheet price = our net cost → standard 1.6x retail. Lowe's price is already
    // a retail number → use as-is and leave cost alone (upsertPricing COALESCEs
    // a null cost to the existing value).
    const fromSheet = costSource === 'sheet';
    const newCost = fromSheet ? money(price) : null;
    const newRetail = fromSheet ? money(nickel(price)) : money(price);
    // Lowe's-priced items: the shelf price is also the FLOOR (map_price) so
    // nothing — trade discounts, future repricing — sells them below street.
    const mapPrice = fromSheet ? null : newRetail;
    if (row.retail_price != null && parseFloat(row.retail_price) > 0) {
      if (newRetail > parseFloat(row.retail_price)) stats.retailUp++;
      else if (newRetail < parseFloat(row.retail_price)) stats.retailDown++;
    }
    if (row.retail_locked) stats.locked++;
    if (dry) return;
    await upsertPricing(pool, row.sku_id, {
      cost: newCost, retail_price: newRetail, price_basis: 'per_unit', map_price: mapPrice,
    }, { jobId: job?.id });
  }

  async function applyName(row, item) {
    const newName = 'Mapei ' + cleanDesc(item.desc);
    if (row.product_name === newName || renamedTargets.has(newName)) return;
    renamedTargets.add(newName);
    await backupProduct(row.product_id);
    stats.renamed++;
    if (dry) return;
    await pool.query('UPDATE products SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newName, row.product_id]);
  }

  const imagedProducts = new Set();
  async function applyImages(row, item, { onlyIfMissing = false } = {}) {
    if (!item?.img || imagedProducts.has(row.product_id)) return;
    imagedProducts.add(row.product_id);
    if (onlyIfMissing) {
      const has = await pool.query(
        `SELECT 1 FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1`, [row.product_id]);
      if (has.rows.length) return;
    }
    await backupProduct(row.product_id);
    stats.imagesReplaced++;
    if (dry) return;
    await pool.query('DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL', [row.product_id]);
    await upsertMediaAsset(pool, {
      product_id: row.product_id, sku_id: null, asset_type: 'primary',
      url: item.img, original_url: item.img, sort_order: 0,
    });
    const alts = (item.alts || []).map(absImg).filter(u => u && u !== item.img).slice(0, 4);
    for (let i = 0; i < alts.length; i++) {
      await upsertMediaAsset(pool, {
        product_id: row.product_id, sku_id: null, asset_type: 'alternate',
        url: alts[i], original_url: alts[i], sort_order: i + 1,
      });
    }
  }

  // ── Phase A: Daltile Mapei ────────────────────────────────────────────────
  // Pass 1: resolve code-based matches, and fingerprint Daltile costs of
  // exact-matched SKUs. Daltile lists the same physical product under both a
  // legacy numeric item number and a new Mapei part number at the SAME cost,
  // so a unique cost shared with an exact-matched line identifies the product.
  const resolved = new Map(); // sku_id → hit
  const costFingerprint = new Map(); // cost string → Set of lowes prices
  for (const row of dal.rows) {
    const hit = matchSku(row, catalog, sheet);
    if (hit) {
      resolved.set(row.sku_id, hit);
      if (hit.tier === 'exact' && row.cost != null && parseFloat(row.cost) > 0) {
        const key = parseFloat(row.cost).toFixed(2);
        if (!costFingerprint.has(key)) costFingerprint.set(key, []);
        costFingerprint.get(key).push({ price: hit.price, src: hit.costSource });
      }
    }
  }
  let fingerprint = 0;
  for (const row of dal.rows) {
    if (resolved.has(row.sku_id) || row.cost == null || parseFloat(row.cost) <= 0) continue;
    const key = parseFloat(row.cost).toFixed(2);
    const entries = costFingerprint.get(key);
    // Only trust a fingerprint that maps to a tight price cluster (one price,
    // or a spread under 25% — Lowe's varies a few dollars by color)
    if (entries && entries.length >= 1) {
      const arr = [...new Set(entries.map(e => e.price))];
      const lo = Math.min(...arr), hi = Math.max(...arr);
      if (hi / lo <= 1.25) {
        // Inherit the cost-source too: only treat as net cost if every donor was sheet-priced
        const src = entries.every(e => e.src === 'sheet') ? 'sheet' : 'lowes';
        resolved.set(row.sku_id, { tier: 'fingerprint', item: null, price: median(arr), costSource: src });
        fingerprint++;
      }
    }
  }
  const unmatchedByPrefix = new Map();
  for (const row of dal.rows) {
    try {
      const hit = resolved.get(row.sku_id);
      if (!hit) {
        stats.untouched++;
        const pfx = (row.variant_name || row.product_name || '').replace(/\d.*$/, '').trim().slice(0, 24);
        unmatchedByPrefix.set(pfx, (unmatchedByPrefix.get(pfx) || 0) + 1);
        continue;
      }
      stats[hit.tier]++;
      if (hit.costSource === 'sheet') stats.costFromSheet++;
      else if (hit.costSource === 'lowes') stats.costFromLowes++;
      await applyPrice(row, hit.price, hit.costSource);
      if (hit.tier === 'exact') {
        await applyName(row, hit.item);
        await applyImages(row, hit.item);
      } else if (hit.item) {
        await applyImages(row, hit.item, { onlyIfMissing: true });
      }
    } catch (err) {
      stats.errors++;
      await jobError(`DAL ${row.vendor_sku}: ${err.message}`);
    }
  }

  // ── Variant-name cleanup ──────────────────────────────────────────────────
  // EDI variant names arrive as "MOONBEAM 4KA522104" / "Eggshell (formerly
  // White) 4KA522004" and render directly as color pills. Normalize matched
  // rows to a clean title-cased color ("Moonbeam", "Eggshell").
  const cleanVariant = (v) => {
    if (!v) return v;
    let s = v.replace(/\s*\(formerly[^)]*\)/i, '');
    s = s.replace(/\s+(?:[0-9][A-Z]{2}[\w-]{4,}|[A-Z]{2,}-[\w-]+|\d{4,}[\w-]*)\s*$/i, '').trim();
    if (!s) return v.trim();
    if (s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return s;
  };
  let variantsCleaned = 0;
  for (const row of dal.rows) {
    if (!resolved.has(row.sku_id) || !row.variant_name) continue;
    const cleaned = cleanVariant(row.variant_name);
    if (cleaned && cleaned !== row.variant_name) {
      variantsCleaned++;
      if (!dry) {
        // Preserve the part code being stripped from the variant — it becomes
        // the vendor_sku (Big D orders by Mapei part number) unless one is set.
        const codeMatch = /\b([0-9][A-Z]{2}\d{4,8}[A-Z-]*|\d{5,9}(?:USA)?)\b/i.exec(row.variant_name);
        if (codeMatch && /^9999/.test(row.vendor_sku || '')) {
          await pool.query('UPDATE skus SET vendor_sku = $1 WHERE id = $2', [codeMatch[1].toUpperCase(), row.sku_id]);
        }
        await pool.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [cleaned, row.sku_id]);
        await pool.query(`
          UPDATE sku_attributes SET value = $1
          WHERE sku_id = $2 AND attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
            AND value = $3
        `, [cleaned, row.sku_id, row.variant_name]);
      }
    }
  }
  if (variantsCleaned) await log(`Variant names cleaned: ${variantsCleaned}`);

  // ── Phase B: Big D Supply gap-fill ────────────────────────────────────────
  // Line anchors: Keracolor S = sanded 25-lb, Keracolor U = unsanded 10-lb.
  // Keracaulk + thinsets Lowe's doesn't carry keep their existing pricing.
  // Only swap to a Lowe's image of the SAME product line — an Ultracolor bag
  // photo on a Keracolor SKU would show the wrong product.
  const lowesColorImg = (productName, color) => {
    const lineRe = /keracolor/i.test(productName) ? /^Keracolor\b/
      : /keracaulk/i.test(productName) ? /^Keracaulk\b/
      : null;
    if (!lineRe) return null;
    const c = color.toLowerCase().replace(/\s+\S*\d.*$/, '').replace(/\s*\(.*\)/, '').trim();
    if (!c) return null;
    const it = catalog.items.find(x => lineRe.test(x.desc) && x.desc.toLowerCase().includes(' ' + c + ' '));
    return it?.img || null;
  };

  for (const row of bigd.rows) {
    try {
      let anchor = null;
      if (/keracolor s/i.test(row.product_name)) anchor = catalog.anchors.keracolorSanded25;
      else if (/keracolor u/i.test(row.product_name)) anchor = catalog.anchors.keracolorUnsanded10;

      if (anchor) {
        await applyPrice(row, anchor, 'lowes'); // Keracolor isn't on the sheet — Lowe's shelf price is retail
        stats.bigdRepriced++;
      }

      // Swap F&D (Amplience) per-SKU color images for Lowe's same-color shots
      const media = await pool.query(
        `SELECT id, url FROM media_assets WHERE sku_id = $1 AND url ILIKE '%amplience%'`, [row.sku_id]);
      if (media.rows.length) {
        const lowesImg = row.variant_name ? lowesColorImg(row.product_name, row.variant_name) : null;
        if (lowesImg) {
          backup.media.push(...media.rows.map(r => ({ ...r, sku_id: row.sku_id })));
          stats.bigdImagesSwapped++;
          if (!dry) {
            await pool.query('UPDATE media_assets SET url = $1, original_url = $1 WHERE id = ANY($2)',
              [lowesImg, media.rows.map(r => r.id)]);
          }
        } else {
          stats.bigdImagesKeptFD++;
        }
      }
    } catch (err) {
      stats.errors++;
      await jobError(`BIGD ${row.vendor_sku}: ${err.message}`);
    }
  }

  // ── Backup + summary ──────────────────────────────────────────────────────
  if (!dry && (backup.pricing.length || backup.media.length || backup.product_names.length)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.resolve(`data/mapei-unified-backup-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(backup));
    await log(`Backup written: ${path.basename(file)} (${backup.pricing.length} pricing rows, ` +
      `${backup.product_names.length} names, ${backup.media.length} media rows)`);
  }

  const topUnmatched = [...unmatchedByPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, n]) => `${k || '(blank)'}×${n}`).join(', ');
  await log(
    `Done${dry ? ' (dry)' : ''}. DAL matched: exact ${stats.exact}, family ${stats.family}, numeric ${stats.numeric}, ` +
    `fingerprint ${stats.fingerprint}, sheet-only ${stats.sheet} (cost source: sheet ${stats.costFromSheet}, lowes ${stats.costFromLowes}); ` +
    `untouched ${stats.untouched}. Retail up ${stats.retailUp} / down ${stats.retailDown}; retail-locked kept ${stats.locked}. ` +
    `Renamed ${stats.renamed}, product images set ${stats.imagesReplaced}. ` +
    `BIGD repriced ${stats.bigdRepriced}, color images → Lowe's ${stats.bigdImagesSwapped}, kept F&D ${stats.bigdImagesKeptFD}. ` +
    `Errors ${stats.errors}.`,
    { products_found: dal.rows.length + bigd.rows.length, products_updated: stats.exact + stats.family + stats.numeric + stats.bigdRepriced }
  );
  await log(`Top unmatched groups: ${topUnmatched}`);

  return stats;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('mapei-unified.js')) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
  });
  const dry = process.argv.includes('--dry');
  try {
    await run(pool, { id: null }, null, { dry });
  } finally {
    await pool.end();
  }
}
