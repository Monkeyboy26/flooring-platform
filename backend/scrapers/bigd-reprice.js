import fs from 'fs';
import path from 'path';
import { upsertPricing, appendLog, addJobError } from './base.js';

/**
 * Generic Big D price-sheet repricer.
 *
 * Applies a parsed Big D Floor Covering Supplies CSP sheet (see
 * data/bigd-*-pricesheet.json) to an existing Daltile-imported sub-brand
 * catalog. Business rule (2026-07-27, rev 2 — the CSP is Roma's NET price:
 * per-account sheet, sits ~70% of street retail on identical items):
 *   cost   = sheet price
 *   retail = 1.6x cost, nickel-rounded (the store's standard markup)
 *
 * Matching: the Daltile EDI writes the manufacturer part code into the variant
 * name (e.g. "Walnut PBPG54125"). Sheet codes are either exact (TL10050T) or
 * color wildcards (PBPGXX25 → one price for every stocking color). Wildcard
 * X-blocks become \d{2,3}; a 'T' is tolerated before '-' or end because
 * Daltile appends channel suffixes the sheet omits (PG54017T vs PGXX17,
 * LWCEG09AT-EA vs LWCEGXXA-EA). A trailing "-<digit>" on the DB side is
 * retried without the suffix (020372-4 → 020372).
 *
 * Used by thin per-brand wrappers (cbp-reprice.js, ...) that supply { sheetPath,
 * vendorCode, collection }. Backup: data/<key>-reprice-backup-*.json.
 */

const money = (n) => Math.round(n * 100) / 100;
const STANDARD_MARKUP = 1.6;
const nickel = (n) => Math.round(n * STANDARD_MARKUP / 0.05) * 0.05;

function buildMatchers(sheetItems) {
  const exact = new Map();
  const wildcards = [];
  for (const it of sheetItems) {
    if (!it.code) continue;
    const code = it.code.toUpperCase();
    if (/X{2,3}/.test(code)) {
      let pat = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/X{2,3}/g, '\\d{2,3}');
      pat = pat.replace(/\\?-/g, 'T?-') + 'T?';
      wildcards.push({ re: new RegExp('^' + pat + '$'), price: it.price, desc: it.desc });
    } else {
      exact.set(code, it.price);
    }
  }
  return (rawCode) => {
    const code = rawCode.toUpperCase();
    const candidates = [code, code.replace(/-\d$/, '')];
    for (const c of candidates) {
      if (exact.has(c)) return exact.get(c);
      for (const w of wildcards) if (w.re.test(c)) return w.price;
    }
    return null;
  };
}

const CODE_RE = /\b([A-Z]{2,10}[\dX][\w-]*|\d{5,8}(?:-\d)?)\b/g;

export function extractCodes(...texts) {
  const out = [];
  for (const t of texts) {
    if (!t) continue;
    // Tokenize on whitespace FIRST and drop any token containing '/': a slash
    // prefix means a DIFFERENT part (EV/RO60AKGB is the outside CORNER of
    // profile RO60AKGB, priced nothing like the full profile). Running the
    // regex over the raw string would treat '/' as a word boundary and match
    // the profile code inside the corner token.
    for (const tok of t.toUpperCase().split(/\s+/)) {
      if (tok.includes('/')) continue;
      let m;
      CODE_RE.lastIndex = 0;
      while ((m = CODE_RE.exec(tok)) !== null) out.push(m[1]);
      // Single-letter+digit codes (J80AE) that CODE_RE's two-letter minimum misses
      if (/\d/.test(tok) && tok.length >= 3) out.push(tok);
    }
  }
  return out;
}

export async function reprice(pool, job, { key, sheetPath, vendorCode, collection, brandCode, dry }) {
  const log = async (msg, counters) => {
    if (job?.id) await appendLog(pool, job.id, msg, counters);
    else console.log(msg);
  };

  const sheet = JSON.parse(fs.readFileSync(path.resolve(sheetPath), 'utf8'));
  const lookup = buildMatchers(sheet.items);
  await log(`${key} reprice${dry ? ' (DRY RUN)' : ''}: ${sheet.items.length} sheet rows — ${sheet.source}`);

  const rows = await pool.query(`
    SELECT s.id AS sku_id, s.variant_name, s.vendor_sku, p.name AS product_name,
           pr.cost, pr.retail_price, pr.retail_locked
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    -- published/curated products move to per-line collections + a brand_id;
    -- untouched EDI rows keep the original collection
    WHERE v.code = $1 AND (p.collection = $2
      OR ($3::text IS NOT NULL AND p.brand_id = (SELECT id FROM brands WHERE code = $3)))
    ORDER BY p.name, s.variant_name
  `, [vendorCode, collection, brandCode || null]);
  await log(`Target: ${rows.rows.length} SKUs (${vendorCode} / ${collection})`);

  const backup = [];
  const stats = { matched: 0, untouched: 0, retailUp: 0, retailDown: 0, locked: 0, errors: 0 };
  const unmatchedByPrefix = new Map();

  for (const row of rows.rows) {
    try {
      let price = null;
      for (const c of extractCodes(row.vendor_sku, row.variant_name, row.product_name)) {
        price = lookup(c);
        if (price != null) break;
      }
      if (price == null) {
        stats.untouched++;
        const pfx = (row.variant_name || row.product_name || '').replace(/[\d].*$/, '').trim().slice(0, 24);
        unmatchedByPrefix.set(pfx, (unmatchedByPrefix.get(pfx) || 0) + 1);
        continue;
      }
      stats.matched++;
      backup.push({ sku_id: row.sku_id, cost: row.cost, retail_price: row.retail_price });
      const newCost = money(price);
      const newRetail = money(nickel(price));
      if (row.retail_price != null && parseFloat(row.retail_price) > 0) {
        if (newRetail > parseFloat(row.retail_price)) stats.retailUp++;
        else if (newRetail < parseFloat(row.retail_price)) stats.retailDown++;
      }
      if (row.retail_locked) stats.locked++;
      if (!dry) {
        await upsertPricing(pool, row.sku_id, { cost: newCost, retail_price: newRetail, price_basis: 'per_unit' }, { jobId: job?.id });
      }
    } catch (err) {
      stats.errors++;
      if (job?.id) await addJobError(pool, job.id, `${row.vendor_sku}: ${err.message}`);
      else console.error(`ERROR ${row.vendor_sku}:`, err.message);
    }
  }

  if (!dry && backup.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.resolve(`data/${key}-reprice-backup-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ created_at: new Date().toISOString(), pricing: backup }));
    await log(`Backup written: ${path.basename(file)} (${backup.length} pricing rows)`);
  }

  const top = [...unmatchedByPrefix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, n]) => `${k || '(blank)'}×${n}`).join(', ');
  await log(
    `Done${dry ? ' (dry)' : ''}. Matched ${stats.matched}/${rows.rows.length}; ` +
    `retail up ${stats.retailUp} / down ${stats.retailDown}; retail-locked kept ${stats.locked}; errors ${stats.errors}.`,
    { products_found: rows.rows.length, products_updated: stats.matched }
  );
  await log(`Top unmatched groups: ${top}`);
  return stats;
}
