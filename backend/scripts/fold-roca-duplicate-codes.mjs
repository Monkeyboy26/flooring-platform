#!/usr/bin/env node
/**
 * fold-roca-duplicate-codes.mjs
 *
 * Folds Roca's remaining A/B letter options — duplicate vendor codes for the
 * SAME design (legacy code + "NEW SKU" SA replacement, or old/new code-system
 * pairs with identical price-book descriptions) — down to ONE buyable SKU per
 * design. Survivor chosen by warehouse stock (latest inventory snapshot),
 * then SA/new code, then book order; losers get status='inactive' (reversible,
 * pricing/packaging/media/history untouched).
 *
 * Special cases from the price book:
 *  - Color Collection White Ice "3X6" quartet = Bright (U081*) + Matte (U281*)
 *    series pairs → folds to "Bright 3X6" / "Matte 3X6" with Finish attrs
 *  - Statuary White A/B are NOT duplicates (B is rectified) → rename only
 *
 * import-roca.js now skips duplicate listings and preserves 'inactive' status
 * on upsert, so future price-book imports won't resurrect the folded codes.
 *
 * Idempotent. Dry-run by default; APPLY=1 executes.
 * Usage: node backend/scripts/fold-roca-duplicate-codes.mjs [APPLY=1]
 */
import pg from 'pg';

const APPLY = process.env.APPLY === '1';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
});

const VENDOR_ID = 'b898517d-1643-4158-a92f-bf494bb69ef0'; // Roca USA
const ATTR_FINISH = 'd50e8400-e29b-41d4-a716-446655440003';

// Losers: duplicate codes deactivated (survivor listed in KEEP for the same design).
// Survivor = higher latest qty_on_hand → SA code → sole U-prefix → book order (A).
const DEACTIVATE = [
  // CC Mosaics
  'UFCC161-12MT', 'UFCC111SABG', 'UFCC110SABG', 'UFCC126-12MT', 'UFCC117SABG',
  'UFCC127-12MT', 'UFCC124-12MT', 'UFCC143-SF12', 'UFCC119SABG', 'UFCC128SABG',
  'U081BV-12MT', 'UFCC118-12MT', 'UFCC166SAMG', 'UFCC164SAMG', 'UFCCBLW-12T',
  'UFCC114SAMG', 'UFCC131P-12MI', 'UFCC103-12MT', 'UFCC159SAMG', 'UFCC135-12MT',
  'UFCC141SAMG', 'UFCC116-12MT', 'UFCC106SAMG', 'UFCC101-12MT', 'UFCC112SAMG',
  'UFCC100-12MT', 'UFCC105-12MT', 'UFCC107SAMG', 'UFCC104-12MT', 'UFCC130P-12MI',
  'UFCC102SAMG', 'UFCC146-SF12', 'UFCC108-12MT',
  // CC Porcelain
  'U259CCI-12', 'U289CCISAMG',
  // Casablanca / Colonial / Crystal / Downtown
  'UCASAMG189I', 'GDV0H6O741', 'GDV0H6O011', 'ICFCR0N-2448PO', 'FJTE030011', 'FJTE030021',
  // Everglade / Mayne / Port Noir / Savoy / Palace / Trevi
  'UEVERGL1LCF', 'ICFEVE04-848', 'UEVERGL1LCI', 'UMAYNFN1LCF', 'F1K0A54161',
  'USAVFDN1LBU', 'USAVFDN1LBV', 'FDL01HS991', 'UTREVIU16BV', 'BTREV02-1224',
  // Limestone / Abbey (A6-code rows: identical desc to the stocked H6 plain rows)
  'FDB7R57371', 'FDB7R57011', 'FN80A6O021', 'FN80A6O141',
  // Lassa stale third code (not in current book) / White Ice 3X6 series dupes
  'FLWPPT3A31', 'U081-36-1P', 'U281-36NU',
];

// Survivors (and Statuary rename-only pair): vendor_sku → new variant_name [+ finish attr]
const KEEP = {
  'UFCC161SABG': { vn: '12X12' }, 'UFCC111-12MT': { vn: '12X12' }, 'UFCC110-12MT': { vn: '12X12' },
  'UFCC126SABG': { vn: '12X12' }, 'UFCC117-12MT': { vn: '12X12' }, 'UFCC127SABG': { vn: '12X12' },
  'UFCC124SABG': { vn: '12X12' }, 'UFCC143SABG': { vn: '12X12' }, 'UFCC119-12MT': { vn: '12X12' },
  'UFCC128-12MT': { vn: '12X12' }, 'U081BVSAGBG': { vn: '12X12' }, 'UFCC118SABG': { vn: '12X12' },
  'UFCC166-12MT': { vn: '12X12' }, 'UFCC164-12MT': { vn: '12X12' }, 'UFCCBLWSAMG': { vn: '12X12' },
  'UFCC114-12MT': { vn: '12X12' }, 'UFCC131SAMG': { vn: '12X12' }, 'UFCC103SAMG': { vn: '12X12' },
  'UFCC159-12MT': { vn: '12X12' }, 'UFCC135SAMG': { vn: '12X12' }, 'UFCC141-12MT': { vn: '12X12' },
  'UFCC116SAMG': { vn: '12X12' }, 'UFCC106-12MI': { vn: '12X12' }, 'UFCC101SAMG': { vn: '12X12' },
  'UFCC112-12MS': { vn: '12X12' }, 'UFCC100SAMG': { vn: '12X12' }, 'UFCC105SAMG': { vn: '12X12' },
  'UFCC107-12MS': { vn: '12X12' }, 'UFCC104SAMG': { vn: '12X12' }, 'UFCC130SAMG': { vn: '12X12' },
  'UFCC102-12MS': { vn: '12X12' }, 'UFCC146SAMG': { vn: '12X12' }, 'UFCC108SAMG': { vn: '12X12' },
  'U259CCISAMG': { vn: '12X12' }, 'U289CCI-12': { vn: '12X12' },
  'CAHYD012-89H': { vn: '8X9' },
  'GDV0A6O741': { vn: '8x48' }, 'GDV0A6O011': { vn: '8x48' },
  'ICFCR01-2448PO': { vn: '24X48' },
  'FJT7T30011': { vn: '12X12' }, 'FJT7T30021': { vn: '12X12' },
  'ICFEVE03-848': { vn: '8X48' }, 'UEVERGL1LCH': { vn: '8X48' }, 'ICFEVE02-848': { vn: '8X48' },
  'UMAYNFD1LCF': { vn: '8X48' },
  'F1K6A54161': { vn: '24X48' },
  'USAVFDX1LBU': { vn: '24X48' }, 'USAVFDX1LBV': { vn: '24X48' },
  'FDL05HS991': { vn: '48X98' },
  'BTREV01-1224': { vn: '12X24' }, 'UTREVIU16BI': { vn: '12X24' },
  'FDB0B57371': { vn: '12X24' }, 'FDB0A57011': { vn: '12X24' },
  'U081-36NU': { vn: 'Bright 3X6', finish: 'Bright' },
  'U281-36-1P': { vn: 'Matte 3X6', finish: 'Matte' },
  // Statuary White: not duplicates — B is the rectified-edge run
  'UFSTUP101-1224': { vn: '12X24' },
  'UFSTUR101-1224': { vn: 'Rectified 12X24' },
};

async function main() {
  const client = await pool.connect();
  const touched = new Set();
  try {
    await client.query('BEGIN');

    // Guard: warn on customer references to the codes being deactivated
    const refs = await client.query(`
      SELECT s.vendor_sku,
        (SELECT count(*) FROM cart_items ci WHERE ci.sku_id = s.id) AS carts,
        (SELECT count(*) FROM order_items oi WHERE oi.sku_id = s.id) AS orders
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.vendor_sku = ANY($2)`, [VENDOR_ID, DEACTIVATE]);
    for (const r of refs.rows) {
      if (+r.carts > 0 || +r.orders > 0) {
        console.log(`  ⚠ ${r.vendor_sku} referenced by carts=${r.carts} orders=${r.orders} (history keeps working; deactivating anyway)`);
      }
    }

    let off = 0;
    for (const vsku of DEACTIVATE) {
      const { rows } = await client.query(`
        SELECT s.id, s.status, s.variant_name, s.product_id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.vendor_sku = $2`, [VENDOR_ID, vsku]);
      if (!rows.length) { console.log(`  ⚠ missing sku ${vsku}`); continue; }
      const s = rows[0];
      if (s.status !== 'active') continue;
      console.log(`  fold away ${vsku} ("${s.variant_name}") → inactive`);
      if (APPLY) await client.query(`UPDATE skus SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [s.id]);
      touched.add(s.product_id);
      off++;
    }
    console.log(`Deactivated: ${off}`);

    let renamed = 0;
    for (const [vsku, spec] of Object.entries(KEEP)) {
      const { rows } = await client.query(`
        SELECT s.id, s.variant_name, s.product_id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.vendor_sku = $2`, [VENDOR_ID, vsku]);
      if (!rows.length) { console.log(`  ⚠ missing survivor ${vsku}`); continue; }
      const s = rows[0];
      if (s.variant_name !== spec.vn) {
        console.log(`  keep ${vsku}: "${s.variant_name}" → "${spec.vn}"`);
        if (APPLY) await client.query(`UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE id = $2`, [spec.vn, s.id]);
        renamed++;
      }
      if (spec.finish && APPLY) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
          [s.id, ATTR_FINISH, spec.finish]);
      }
      touched.add(s.product_id);
    }
    console.log(`Survivor renames: ${renamed}`);

    if (APPLY) {
      for (const pid of touched) await client.query('SELECT refresh_search_vectors($1)', [pid]);
      await client.query('COMMIT');
      console.log(`\nAPPLIED. ${touched.size} products touched.`);
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN (set APPLY=1 to execute).');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
