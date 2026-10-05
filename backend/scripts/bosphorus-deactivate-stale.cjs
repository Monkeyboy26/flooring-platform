#!/usr/bin/env node
/**
 * Deactivate Bosphorus SKUs the scraper has stopped seeing.
 *
 * upsertSku bumps skus.updated_at on EVERY nightly scrape, so an active BOS SKU
 * whose updated_at is older than STALE_DAYS has been missing from the vendor's
 * site for that many consecutive runs. This happens when Bosphorus renames a
 * page (e.g. the "Curiousity"→"Curiosity" title fix, Aug 2026): the scraper
 * mints the new-name product and the old one strands as a stale-active twin
 * with duplicate listings. Nothing else retires it — this sweep does.
 *
 * Runs as a bosphorus pipeline step AFTER the catalog scrape + color grouping,
 * so it only ever executes when the scrape just succeeded (a failed scrape
 * cancels the remaining steps and can never trigger a mass deactivation).
 *
 * Safety:
 *  - deactivates (status='inactive'), never deletes
 *  - aborts (exit 1 → step fails → failure alert) if more than MAX_FRACTION of
 *    active BOS SKUs would be deactivated — a partial-crawl tripwire
 *  - products whose SKUs all go inactive are marked 'discontinued'
 *
 * Usage:
 *   node backend/scripts/bosphorus-deactivate-stale.cjs --dry-run
 *   node backend/scripts/bosphorus-deactivate-stale.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const dryRun = process.argv.includes('--dry-run');
const STALE_DAYS = 7;      // nightly scrape → 7 consecutive misses
const MAX_FRACTION = 0.15; // abort if >15% of active BOS SKUs look stale

async function main() {
  const vendor = (await pool.query(`SELECT id FROM vendors WHERE code='BOS' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('Bosphorus vendor (BOS) not found');

  const { rows: [{ count: activeCount }] } = await pool.query(`
    SELECT count(*)::int AS count FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'`, [vendor.id]);

  const { rows: stale } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.updated_at::date AS last_seen, p.name AS product
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND s.updated_at < NOW() - make_interval(days => $2)
    ORDER BY p.name, s.vendor_sku`, [vendor.id, STALE_DAYS]);

  console.log(`${activeCount} active BOS SKUs; ${stale.length} not seen by a scrape in ${STALE_DAYS}+ days`);
  if (stale.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const s of stale) {
    console.log(`  stale: ${s.product} / ${s.vendor_sku} (${s.variant_name || ''}) last seen ${s.last_seen}`);
  }

  if (activeCount > 0 && stale.length / activeCount > MAX_FRACTION) {
    console.error(`ABORT: ${stale.length}/${activeCount} (${Math.round(100 * stale.length / activeCount)}%) ` +
      `exceeds the ${Math.round(MAX_FRACTION * 100)}% safety cap — looks like a partial crawl, not vendor drops. ` +
      `No changes made.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('[dry-run] no changes made');
    return;
  }

  const ids = stale.map(s => s.id);
  await pool.query(
    `UPDATE skus SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [ids]);
  console.log(`Deactivated ${ids.length} SKUs.`);

  // Retire products left with no active SKUs (but that do have SKUs — don't
  // touch SKU-less shells some flows create intentionally).
  const { rows: retired } = await pool.query(`
    UPDATE products p SET status = 'discontinued', updated_at = NOW()
    WHERE p.vendor_id = $1 AND p.status <> 'discontinued'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')
    RETURNING p.name`, [vendor.id]);
  if (retired.length) {
    console.log(`Retired ${retired.length} product(s) with no active SKUs left: ${retired.map(r => r.name).join(', ')}`);
  }
}

main()
  .then(() => pool.end())
  .catch(err => { console.error(err); process.exit(1); });
