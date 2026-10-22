// Data-integrity sweep: keep products.status in sync with sellable-SKU availability.
//
// WHY: a product does NOT auto-deactivate when its last sellable (non-accessory,
// non-sample) SKU goes inactive — so the "active" catalog slowly fills with
// unsellable records that 410 to crawlers (showing up as GSC "Not found (404)")
// and inflate the active count. A one-time sweep on 2026-10-22 found 3,223 such
// products and retired 239 genuinely-dead ones (products_inactive_deadstock_backup_20261022).
// This rule closes the loop for good, both directions, idempotently.
//
//   Deactivate:  status='active'   AND 0 active SKUs                        -> inactive
//   Reactivate:  status='inactive' AND >=1 active SKU
//                AND this rule was what deactivated it (safe undo only)     -> active
//
// Liveness is "has >=1 ACTIVE SKU of any kind" — the same condition used for the
// 2026-10-22 one-time cleanup of 239 dead records. This DELIBERATELY leaves
// accessory/trim-only products ACTIVE: a trim has active accessory SKUs, so it's
// a real attachable product — it just 410s as a standalone PDP, which is a
// separate storefront concern (NOT a status question). Do not confuse this with
// the "sellable / indexable PDP" gate (active + non-sample + non-accessory) that
// decides 200-vs-410; that is intentionally NOT what governs product.status.
//
// Default is a DRY RUN. Pass --apply to commit.
//   local: node backend/data/product-status-integrity.mjs [--apply]
//   prod:  docker exec -w /app flooring-api node backend/data/product-status-integrity.mjs --apply
// Idempotent and safe to run nightly via cron.

import { pool } from '../db.js';

const APPLY = process.argv.includes('--apply');
const TAG = '[product-integrity]';
// A product is "live" if it has at least one active SKU of ANY type (field,
// accessory, trim, or sample). Matches the 239-record cleanup condition exactly.
const ACTIVE_SKU = `s.status='active'`;

async function main() {
  console.log(TAG, APPLY ? 'APPLY' : 'DRY RUN', new Date().toISOString());

  // Persistent audit log of this rule's own actions. Also drives safe reactivation:
  // we only ever un-retire a product the rule itself retired, never an admin-hidden one.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_status_integrity_log (
      id         bigserial PRIMARY KEY,
      product_id uuid NOT NULL,
      action     text NOT NULL,          -- 'deactivate' | 'reactivate'
      from_status text,
      to_status  text,
      run_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_psil_product ON product_status_integrity_log(product_id)`);

  // One-time adoption: fold the 2026-10-22 manual dead-stock retirement into the log
  // so the rule "owns" those 239 and can reactivate them if a sellable SKU returns.
  const hasBackup = (await pool.query(
    `SELECT to_regclass('products_inactive_deadstock_backup_20261022') AS t`)).rows[0].t;
  if (hasBackup && APPLY) {
    const seeded = await pool.query(`
      INSERT INTO product_status_integrity_log (product_id, action, from_status, to_status, run_at)
      SELECT b.id, 'deactivate', b.old_status, 'inactive', b.old_updated_at
      FROM products_inactive_deadstock_backup_20261022 b
      WHERE NOT EXISTS (
        SELECT 1 FROM product_status_integrity_log l
        WHERE l.product_id = b.id AND l.action = 'deactivate')`);
    if (seeded.rowCount) console.log(TAG, `seeded ${seeded.rowCount} prior retirements into the log`);
  }

  // Candidates to DEACTIVATE: active product with no active SKU of any kind.
  const deac = (await pool.query(`
    SELECT p.id, p.slug FROM products p
    WHERE p.status='active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id AND ${ACTIVE_SKU})
    ORDER BY p.slug`)).rows;

  // Candidates to REACTIVATE: inactive, now has an active SKU again, and the rule's
  // most recent action for it was 'deactivate' (so we only undo our own work).
  const reac = (await pool.query(`
    SELECT p.id, p.slug FROM products p
    WHERE p.status='inactive'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id AND ${ACTIVE_SKU})
      AND (SELECT l.action FROM product_status_integrity_log l
           WHERE l.product_id=p.id ORDER BY l.run_at DESC, l.id DESC LIMIT 1) = 'deactivate'
    ORDER BY p.slug`)).rows;

  console.log(TAG, `deactivate: ${deac.length} | reactivate: ${reac.length}`);
  deac.slice(0, 15).forEach(r => console.log('  - retire ', r.slug));
  if (deac.length > 15) console.log(`  … +${deac.length - 15} more`);
  reac.slice(0, 15).forEach(r => console.log('  + restore', r.slug));

  if (!APPLY) {
    console.log(TAG, 'DRY RUN — no changes written. Re-run with --apply to commit.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (deac.length) {
      const ids = deac.map(r => r.id);
      await client.query(`UPDATE products SET status='inactive', updated_at=now() WHERE id = ANY($1::uuid[])`, [ids]);
      await client.query(`INSERT INTO product_status_integrity_log (product_id, action, from_status, to_status)
        SELECT unnest($1::uuid[]), 'deactivate', 'active', 'inactive'`, [ids]);
    }
    if (reac.length) {
      const ids = reac.map(r => r.id);
      await client.query(`UPDATE products SET status='active', updated_at=now() WHERE id = ANY($1::uuid[])`, [ids]);
      await client.query(`INSERT INTO product_status_integrity_log (product_id, action, from_status, to_status)
        SELECT unnest($1::uuid[]), 'reactivate', 'inactive', 'active'`, [ids]);
    }
    await client.query('COMMIT');
    console.log(TAG, `APPLIED — deactivated ${deac.length}, reactivated ${reac.length}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch(e => { console.error(TAG, 'FAILED', e); process.exitCode = 1; })
  .finally(() => pool.end());
