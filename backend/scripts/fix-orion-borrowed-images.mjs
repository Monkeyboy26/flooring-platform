// Orion (169) borrowed / wrong-color image cleanup — 2026-09-02 session.
//
// Idempotent. Runs the same catalog-wide image-integrity pass the scraper now
// runs post-scrape (backend/scrapers/orion.js → fixOrionBorrowedImages), so it
// can be applied to the current DB without a full re-scrape and re-run on prod.
//
//   docker compose exec -T api node scripts/fix-orion-borrowed-images.mjs
//   (prod) ssh ubuntu@32.188.96.3 -i roma-prod.pem
//          docker compose exec -T api node scripts/fix-orion-borrowed-images.mjs
//
// Fixes: generic shared images reused across unrelated products (e.g. Blue Forest's
// file showing on Lux Danae) and sibling swatches on the wrong color (Montclair
// Ivory carrying a Blanco/Carrara file). Borrowed copies are removed; the rightful
// owner keeps the image. Products left with no real image become photoless.

import { pool } from '../db.js';
import { fixOrionBorrowedImages } from '../scrapers/orion.js';

const ORION_VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';

async function main() {
  try {
    const before = await pool.query(
      `SELECT COUNT(*) FROM media_assets m
       JOIN products p ON p.id = m.product_id WHERE p.vendor_id = $1`, [ORION_VENDOR_ID]);
    const res = await fixOrionBorrowedImages(pool, ORION_VENDOR_ID);
    const after = await pool.query(
      `SELECT COUNT(*) FROM media_assets m
       JOIN products p ON p.id = m.product_id WHERE p.vendor_id = $1`, [ORION_VENDOR_ID]);
    console.log('[fix-orion-borrowed-images] applied:', JSON.stringify({
      images_before: Number(before.rows[0].count),
      removed: res.deleted,
      images_after: Number(after.rows[0].count),
    }, null, 2));
  } catch (err) {
    console.error('[fix-orion-borrowed-images] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
