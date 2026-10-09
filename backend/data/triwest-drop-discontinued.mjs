/**
 * Tri-West EDI discontinued-SKU sweep.
 *
 * The DNav portal feed (dumped to data/triwest-instock.json by triwest-inventory.js)
 * prefixes a product's description with "ZZ" to mark it discontinued / closeout.
 * Closeout items are still real, in-stock, sellable inventory, so we DON'T drop them
 * on sight. Instead, two phases — the "sell-through, then drop" policy:
 *
 *   1. TAG   — stamp skus.discontinued_at on every SKU whose feed row is ZZ-marked
 *              (and clear the stamp if a previously-flagged SKU reappears un-ZZ'd,
 *              i.e. the manufacturer un-discontinued it). The SKU stays status='active'
 *              and keeps selling while stock lasts.
 *   2. DROP  — deactivate a tagged SKU only once it has fallen OUT of the feed for
 *              >= STALE_DAYS (no fresh inventory snapshot) — meaning the closeout
 *              stock is exhausted. Then any product left with no active SKU is
 *              deactivated too. A cap guard aborts the drop if an unusually large
 *              batch would go inactive (protects against a truncated/bad scrape).
 *
 * Matching mirrors triwest-inventory.js exactly, using the per-row `mfgr` code the
 * dump carries, so the same portal item resolves to the same DB SKU in both places.
 *
 * Usage:
 *   node backend/data/triwest-drop-discontinued.mjs                 # dry-run report
 *   node backend/data/triwest-drop-discontinued.mjs --apply         # tag + drop
 *   node backend/data/triwest-drop-discontinued.mjs --apply --stale-days=10 --cap=300
 *   node backend/data/triwest-drop-discontinued.mjs --apply --force  # ignore cap guard
 *
 * The scraper imports runDiscontinuedSweep() and calls it (apply mode) after each run.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const TW_VENDOR_CODE = 'TW';
const DEFAULT_STALE_DAYS = 7;   // grace after falling out of the feed before we drop
const DEFAULT_CAP = 250;        // max SKUs a single sweep may deactivate
const DEFAULT_CAP_PCT = 0.15;   // ...or 15% of active Tri-West SKUs, whichever is smaller

/** A feed row is discontinued when its product description starts with the "ZZ" marker. */
export function isDiscontinuedRow(row) {
  const name = (row.productName || row.rawDescription || '').trim();
  return /^ZZ/i.test(name);
}

/**
 * Resolve a feed item number to a DB SKU id, mirroring triwest-inventory.js:
 * exact → punctuation-stripped → manufacturer-prefix-stripped (+ optional CF suffix).
 */
function resolveSku(itemNumber, mfgrCode, skuMap) {
  if (!itemNumber) return undefined;
  const skuKey = itemNumber.toUpperCase();
  const normalizedKey = itemNumber.replace(/[-\s.]/g, '').toUpperCase();
  const mfgr = (mfgrCode || '').toUpperCase();
  const strippedKey = mfgr && skuKey.startsWith(mfgr) && skuKey.length >= mfgr.length + 4
    ? skuKey.slice(mfgr.length) : null;
  return skuMap.get(skuKey) || skuMap.get(normalizedKey) ||
    (strippedKey ? skuMap.get(strippedKey) : undefined) ||
    (strippedKey && strippedKey.endsWith('CF') ? skuMap.get(strippedKey.slice(0, -2)) : undefined);
}

/**
 * Run the discontinued sweep.
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @param {boolean} [opts.apply=false]      actually write (else dry-run)
 * @param {number}  [opts.staleDays=7]      days out of feed before a tagged SKU is dropped
 * @param {number}  [opts.cap]              absolute max SKUs to deactivate in one sweep
 * @param {boolean} [opts.force=false]      ignore the cap guard
 * @param {string}  [opts.instockPath]      path to triwest-instock.json
 * @param {string}  [opts.backupDir]        where to write the drop backup JSON
 * @param {string}  [opts.ts]               timestamp string for backup filename (callers w/o Date)
 * @param {(msg:string)=>any} [opts.log]    logger (defaults to console.log)
 * @returns {Promise<{tagged:number,untagged:number,candidates:number,dropped:number,
 *                     productsDropped:number,capped:boolean,cap:number,apply:boolean}>}
 */
export async function runDiscontinuedSweep(pool, opts = {}) {
  const apply = !!opts.apply;
  const staleDays = Number(opts.staleDays) > 0 ? Number(opts.staleDays) : DEFAULT_STALE_DAYS;
  const force = !!opts.force;
  const log = opts.log || ((m) => console.log(m));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const instockPath = opts.instockPath || path.join(here, 'triwest-instock.json');
  const backupDir = opts.backupDir || here;
  const ts = opts.ts || new Date().toISOString().replace(/[:.]/g, '-');

  const vend = await pool.query('SELECT id FROM vendors WHERE code = $1', [TW_VENDOR_CODE]);
  if (!vend.rows.length) throw new Error(`vendor ${TW_VENDOR_CODE} not found`);
  const vendorId = vend.rows[0].id;

  // ── Load the feed dump ────────────────────────────────────────────────────
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(instockPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read instock dump ${instockPath}: ${err.message}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`instock dump empty: ${instockPath}`);

  // ── Load DB SKUs + build the same lookup map the inventory scraper uses ─────
  const skuRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.discontinued_at, s.status
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
  `, [vendorId]);
  const skuMap = new Map();
  const skuById = new Map();
  for (const r of skuRes.rows) {
    skuById.set(r.id, r);
    skuMap.set(r.vendor_sku.toUpperCase(), r);
    const norm = r.vendor_sku.replace(/[-\s.]/g, '').toUpperCase();
    if (!skuMap.has(norm)) skuMap.set(norm, r);
  }

  // ── Phase 1: classify feed rows → SKUs seen ZZ vs seen un-ZZ ────────────────
  const seenZz = new Set();     // sku ids matched to a ZZ row this run
  const seenPlain = new Set();  // sku ids matched to a non-ZZ row this run
  for (const row of rows) {
    const sku = resolveSku(row.itemNumber, row.mfgr, skuMap);
    if (!sku) continue;
    if (isDiscontinuedRow(row)) seenZz.add(sku.id);
    else seenPlain.add(sku.id);
  }
  // If an item appears both ZZ and plain in one feed, treat ZZ as authoritative.
  for (const id of seenZz) seenPlain.delete(id);

  const toTag = [...seenZz].filter((id) => !skuById.get(id)?.discontinued_at);
  const toUntag = [...seenPlain].filter((id) => skuById.get(id)?.discontinued_at);

  if (apply) {
    if (toTag.length) {
      await pool.query(
        `UPDATE skus SET discontinued_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1) AND discontinued_at IS NULL`, [toTag]);
    }
    if (toUntag.length) {
      await pool.query(
        `UPDATE skus SET discontinued_at = NULL, updated_at = NOW()
         WHERE id = ANY($1)`, [toUntag]);
    }
  }
  log(`Tag phase: ${seenZz.size} ZZ SKUs in feed → ${apply ? 'tagged' : 'would tag'} +${toTag.length} new` +
      (toUntag.length ? `, ${apply ? 'cleared' : 'would clear'} ${toUntag.length} reappeared` : ''));

  // ── Feed-freshness gate ─────────────────────────────────────────────────────
  // The drop phase reads "tagged SKU with no fresh inventory" as "sold through".
  // That's only valid when a scrape has recently refreshed the feed — otherwise
  // "no fresh inventory" just means "we haven't scraped lately" and we'd wrongly
  // drop live stock. Require at least one currently-fresh TW snapshot (the scraper
  // writes thousands right before calling this; a stale local DB has none).
  const freshRes = await pool.query(`
    SELECT COUNT(*)::int AS n FROM inventory_snapshots inv
    JOIN skus s ON s.id = inv.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND inv.fresh_until > NOW()`, [vendorId]);
  const freshFeed = freshRes.rows[0].n;
  if (freshFeed === 0) {
    log(`Drop phase: feed is not fresh (0 current TW snapshots) — skipping drop. ` +
        `Run the inventory scraper first; drop only runs on a freshly-scraped feed.`);
    return { tagged: toTag.length, untagged: toUntag.length, candidates: 0,
             dropped: 0, productsDropped: 0, capped: false, cap: 0, apply };
  }

  // ── Phase 2: drop tagged SKUs that have fallen out of the feed ──────────────
  // "Fallen out" = no inventory snapshot still fresh, and last sighting (or the
  // discontinue stamp, if it never had stock) older than STALE_DAYS.
  const candRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.discontinued_at,
           p.id AS product_id, p.name AS product_name,
           MAX(inv.fresh_until) AS fresh_until,
           MAX(inv.snapshot_time) AS last_seen
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN inventory_snapshots inv ON inv.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active' AND s.discontinued_at IS NOT NULL
    GROUP BY s.id, s.vendor_sku, s.discontinued_at, p.id, p.name
    HAVING (MAX(inv.fresh_until) IS NULL OR MAX(inv.fresh_until) <= NOW())
       AND COALESCE(MAX(inv.snapshot_time), s.discontinued_at) < NOW() - ($2 || ' days')::interval
  `, [vendorId, String(staleDays)]);
  const candidates = candRes.rows;

  // Cap guard: never let one sweep deactivate an outsized batch.
  const activeCntRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM skus s JOIN products p ON p.id = s.product_id
     WHERE p.vendor_id = $1 AND s.status = 'active'`, [vendorId]);
  const activeCnt = activeCntRes.rows[0].n;
  const cap = Number(opts.cap) > 0 ? Number(opts.cap)
    : Math.min(DEFAULT_CAP, Math.max(25, Math.floor(activeCnt * DEFAULT_CAP_PCT)));
  const capped = candidates.length > cap && !force;

  let dropped = 0, productsDropped = 0;
  if (candidates.length) {
    const bpath = path.join(backupDir, `triwest-discontinued-drops-backup-${ts}.json`);
    try {
      fs.writeFileSync(bpath, JSON.stringify(candidates, null, 1));
      log(`Drop backup: ${bpath} (${candidates.length} candidates)`);
    } catch (err) {
      log(`Drop backup write failed: ${err.message}`);
    }
  }

  if (capped) {
    log(`Drop phase: ${candidates.length} stale discontinued SKUs EXCEEDS cap ${cap} — ` +
        `skipping drop (re-run with --force if this is expected). Active TW SKUs: ${activeCnt}`);
  } else if (candidates.length === 0) {
    log(`Drop phase: 0 tagged SKUs have sold through (>${staleDays}d out of feed) — nothing to drop`);
  } else {
    const ids = candidates.map((c) => c.sku_id);
    if (apply) {
      for (let i = 0; i < ids.length; i += 500) {
        const r = await pool.query(
          `UPDATE skus SET status = 'inactive', updated_at = NOW() WHERE id = ANY($1)`,
          [ids.slice(i, i + 500)]);
        dropped += r.rowCount;
      }
      const pr = await pool.query(`
        UPDATE products p SET status = 'inactive', is_active = false, updated_at = NOW()
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')`,
        [vendorId]);
      productsDropped = pr.rowCount;
    } else {
      dropped = ids.length;
    }
    log(`Drop phase: ${apply ? 'deactivated' : 'would deactivate'} ${dropped} sold-through discontinued SKUs` +
        (apply ? `, ${productsDropped} now-empty products` : ''));
  }

  return {
    tagged: toTag.length, untagged: toUntag.length,
    candidates: candidates.length, dropped, productsDropped,
    capped, cap, apply,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { pool } = await import('../db.js');
  const args = process.argv.slice(2);
  const getNum = (flag) => {
    const a = args.find((x) => x.startsWith(flag + '='));
    return a ? Number(a.split('=')[1]) : undefined;
  };
  const opts = {
    apply: args.includes('--apply'),
    force: args.includes('--force'),
    staleDays: getNum('--stale-days'),
    cap: getNum('--cap'),
    instockPath: (args.find((x) => x.startsWith('--instock=')) || '').split('=')[1] || undefined,
  };
  console.log(`Tri-West discontinued sweep — ${opts.apply ? 'APPLY' : 'DRY-RUN'}` +
    (opts.force ? ' (force, cap ignored)' : '') + `\n`);
  try {
    const res = await runDiscontinuedSweep(pool, opts);
    console.log(`\nSummary: tagged +${res.tagged}, untagged ${res.untagged}, ` +
      `drop candidates ${res.candidates}, dropped ${res.dropped} SKUs / ${res.productsDropped} products` +
      (res.capped ? ` [CAP ${res.cap} HIT — drop skipped]` : ''));
    if (!opts.apply) console.log('\n(dry-run — re-run with --apply to write)');
  } finally {
    await pool.end();
  }
}
