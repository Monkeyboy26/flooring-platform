import pg from 'pg';
const { Pool } = pg;

// Idempotent fix for Orion tile products whose customer-facing variant label
// (skus.variant_name) was missing the size — it was finish-only ("Polished"),
// empty, or a raw slug fallback ("(multifios-breton)"). The size was already
// known via the Size sku_attribute (and the slug); the naming step just dropped
// it. Convention across Orion is variant_name = "{Finish} {Size}".
//
// Also:
//  - Normalizes 4 all-caps Finish attr outliers (MATTE/MATT/POLISHED) to the
//    canonical Title-case values used by the other 168 Orion SKUs.
//  - Backfills ONI Blue Super's Size=24x48 (missing from fix-orion-sizes.mjs
//    SIZE_MAP; its 3 siblings Coral/Pearl/White Super are all 24x48).
//  - Folds a true-duplicate empty-variant Sybil Silver SKU (same Finish=Matte /
//    Size=24x48 / price as the kept SKU) by deactivating it (reversible).
//
// NOT touched here (need vendor data, reported separately):
//  - Inter Chelsea (draft, Herringbone, no size, doubled slug)
//  - Multifios Breton (unpriced/quote-only, raw-slug variant names)

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = '94dd7078-a068-4ea0-b78b-b0565731e758';
const SIZE_ATTR_ID = 'd50e8400-e29b-41d4-a716-446655440004';

// vendor_sku → desired "{Finish} {Size}" variant label
const VARIANT_NAMES = {
  'albany-pul-porcelain-tile-24x24': 'Polished 24x24',
  'boston-pul-porcelain-tile-24x24': 'Polished 24x24',
  'coreu-gris-matte-porcelain-tile-24x24': 'Matte 24x24',
  'oni-coral-super-polished-porcelain-tile-marble-look-onyx-onix-24x48': 'Polished 24x48',
  'oni-pearl-super-polished-porcelain-tile-marble-look-onyx-onix-24x48': 'Polished 24x48',
  'oni-white-super-polished-porcelain-tile-marble-look-onyx-onix-24x48-copy': 'Polished 24x48',
  'oni-blue-polished-porcelain-tile-marble-look-onyx-onix': 'Polished 24x48',
  'segesta-ivory-matt-porcelain-tile-24x48': 'Matte 24x48',
  'segesta-ivory-polished-porcelain-tile-24x48': 'Polished 24x48',
  'sybil-silver-matte-porcelain-tile-24x48': 'Matte 24x48',
  'taj-mahal-matte': 'Matte 24x48',
  'taj-mahal-porcelain-tile-24x48': 'Polished 24x48', // distinct Polished finish, not a dupe
};

// vendor_sku → Size to backfill (only when the Size attr is missing)
const SIZE_BACKFILL = {
  'oni-blue-polished-porcelain-tile-marble-look-onyx-onix': '24x48',
};

// Canonical Title-case for all-caps Finish outliers
const FINISH_CANON = { MATTE: 'Matte', MATT: 'Matte', POLISHED: 'Polished' };

// True-duplicate SKU to fold (deactivate — reversible)
const FOLD_INACTIVE = ['sybil-silver-porcelain-tile-24x48'];

// Split-duplicate reconciliation (prod only; no-ops where `from` sku is absent).
// PROD Taj Mahal has a stale $0.00 Matte SKU `taj-mahal` that holds the Matte
// media, while the correctly-priced `taj-mahal-matte` has none. Move the media
// onto the priced SKU, then deactivate the dupe (local was already consolidated
// this way and never pushed).
const FOLD_MERGE = [
  { from: 'taj-mahal', into: 'taj-mahal-matte' },
];

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // 1) Normalize all-caps Finish attr values (scoped to Orion)
    let finishFixed = 0;
    for (const [caps, canon] of Object.entries(FINISH_CANON)) {
      const r = await c.query(`
        UPDATE sku_attributes sa
        SET value = $2
        FROM attributes a, skus s, products p
        WHERE sa.attribute_id = a.id AND a.name = 'Finish'
          AND s.id = sa.sku_id AND p.id = s.product_id
          AND p.vendor_id = $3
          AND sa.value = $1
      `, [caps, canon, VENDOR_ID]);
      finishFixed += r.rowCount;
    }
    console.log(`Finish attr normalized: ${finishFixed}`);

    // 2) Backfill missing Size attrs
    let sizeBackfilled = 0;
    for (const [vsku, size] of Object.entries(SIZE_BACKFILL)) {
      const r = await c.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        SELECT s.id, $2, $3 FROM skus s JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $4 AND s.vendor_sku = $1
        ON CONFLICT (sku_id, attribute_id) DO NOTHING
      `, [vsku, SIZE_ATTR_ID, size, VENDOR_ID]);
      sizeBackfilled += r.rowCount;
    }
    console.log(`Size attr backfilled: ${sizeBackfilled}`);

    // 3) Rewrite variant_name = "{Finish} {Size}"
    let renamed = 0;
    const missing = [];
    for (const [vsku, name] of Object.entries(VARIANT_NAMES)) {
      const r = await c.query(`
        UPDATE skus s SET variant_name = $2
        FROM products p
        WHERE p.id = s.product_id AND p.vendor_id = $3
          AND s.vendor_sku = $1
          AND (s.variant_name IS DISTINCT FROM $2)
      `, [vsku, name, VENDOR_ID]);
      if (r.rowCount) renamed += r.rowCount;
      // detect vendor_sku that matched nothing (typo / data drift)
      const chk = await c.query(
        `SELECT 1 FROM skus s JOIN products p ON p.id=s.product_id
         WHERE p.vendor_id=$2 AND s.vendor_sku=$1`, [vsku, VENDOR_ID]);
      if (chk.rowCount === 0) missing.push(vsku);
    }
    console.log(`variant_name updated: ${renamed}`);
    if (missing.length) console.log(`  WARNING vendor_sku not found: ${missing.join(', ')}`);

    // 3b) Split-dupe merge: move media from `from` sku to `into` sku (only rows
    //     that don't collide), then deactivate `from`.
    let mergedMedia = 0, mergeFolded = 0;
    for (const { from, into } of FOLD_MERGE) {
      const ids = await c.query(`
        SELECT
          (SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id
             WHERE p.vendor_id=$2 AND s.vendor_sku=$1) AS from_id,
          (SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id
             WHERE p.vendor_id=$2 AND s.vendor_sku=$3) AS into_id
      `, [from, VENDOR_ID, into]);
      const { from_id, into_id } = ids.rows[0] || {};
      if (!from_id || !into_id) continue; // absent on this env → no-op
      const mv = await c.query(`
        UPDATE media_assets ma SET sku_id = $2
        WHERE ma.sku_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM media_assets x
            WHERE x.sku_id = $2 AND x.product_id = ma.product_id
              AND x.asset_type = ma.asset_type AND x.sort_order = ma.sort_order)
      `, [from_id, into_id]);
      mergedMedia += mv.rowCount;
      const fd = await c.query(
        `UPDATE skus SET status='inactive' WHERE id=$1 AND status<>'inactive'`, [from_id]);
      mergeFolded += fd.rowCount;
    }
    console.log(`Split-dupe media moved: ${mergedMedia}, dupes deactivated: ${mergeFolded}`);

    // 4) Fold true-dupe SKUs (deactivate)
    let folded = 0;
    for (const vsku of FOLD_INACTIVE) {
      const r = await c.query(`
        UPDATE skus s SET status = 'inactive'
        FROM products p
        WHERE p.id = s.product_id AND p.vendor_id = $2
          AND s.vendor_sku = $1 AND s.status <> 'inactive'
      `, [vsku, VENDOR_ID]);
      folded += r.rowCount;
    }
    console.log(`Dupe SKUs deactivated: ${folded}`);

    await c.query('COMMIT');
    console.log('\nDone.');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
