// One-off: run the Bedrosians reconcile pass standalone (DB-only, no browser) to
// finalize a scrape whose detail/reconcile phases were cut short. Re-derives
// display_name, applies category corrections, fills fallback costs, prunes orphans,
// attaches accessories. Idempotent. Safe to delete after use.
import { pool } from '../db.js';
import { reconcileBedProducts } from '../scrapers/bed.js';

const vendorId = (await pool.query("SELECT id FROM vendors WHERE code='BED'")).rows[0]?.id;
if (!vendorId) { console.error('No BED vendor'); process.exit(1); }
console.log('[bed-reconcile] start', new Date().toISOString());
try {
  const stats = await reconcileBedProducts(pool, vendorId);
  console.log('[bed-reconcile] DONE', JSON.stringify(stats));
} catch (e) {
  console.error('[bed-reconcile] FAILED', e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
