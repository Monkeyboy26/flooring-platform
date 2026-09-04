/**
 * fix-mosaic-underpriced-triage-2026-09.mjs — resolve the 36 open `mosaic-underpriced`
 * violations at BED / MSI / AZT / UN / THD (surfaced by the rule added 2026-09-03).
 *
 * Triage results (2026-09-04, per-vendor verification against vendor price lists,
 * vendor sites, and market retailers):
 *   - AZT (7), UN (5), MSI (10), BED Monet (6): FALSE POSITIVES — the "unit" is a
 *     single small tile/piece (4x8 hex, 8.5x10 hex, kit-kat strips, loose bricks,
 *     3x6 subway, 4x12 tiles), priced correctly per the vendor's own per-piece or
 *     per-sqft-converted list. → waive with evidence note.
 *   - BED Manhattan/Modni glass (6 flagged + 5 same-bug siblings): bedrosians.com
 *     CLEARANCE $/sqft rate got stored as the per-sheet price, cost=0, items are
 *     clearance or fully discontinued at the vendor, absent from the Q4-2025 book
 *     → no reliable price/cost source → deactivate.
 *   - THD Stage Grid Mosaic (2 flagged, all 8 colors THD0031-00410..00417 corrupt):
 *     sheets carrying stale/row-shifted prices from an old quarterly PDF; the whole
 *     block is ABSENT from backend/data/thd-q3-2026.pdf (likely discontinued)
 *     → deactivate all 8 pending a real THD price.
 *   - MSI stragglers found during verification:
 *       NURBNAVMIX4X12 (Urbano Navy 4x12 Mix) — per-PIECE price stored as per-sqft
 *       (box sells $23.16 vs $39.30 cost) → align with its 6 correctly-priced
 *       siblings: unit/per_unit, cost $1.31/pc, retail $2.39/pc.
 *       NMIX7X8HEX-N — discontinued in MSI's Jan-26 list → inactive.
 *       SMOT-CLATIL loose bricks (2) — missing packaging; MSI list: 0.145 sf/pc,
 *       50 pc / 7.25 sf per box.
 *
 * Idempotent. Dry-run unless --apply. Re-runs the scoped audit at the end
 * (deactivated rows auto-close; waived rows stay waived).
 */
import { pool } from '../db.js';
import { runQualityAudit } from '../quality/runner.js';

const APPLY = process.argv.includes('--apply');

const DEACTIVATE = {
  BED: [
    // flagged: clearance-rate-as-sheet-price, cost=0, clearance/discontinued at vendor
    'GLSMANFLARISGMCB', 'GLSMANSOHRIGMCB', 'GLSMANHEIBPGMC', 'GLSMANHEIRIGMC',
    'GLSMANCPKRIGMCB', '100001699',
    // same-bug siblings (cost 0, $4.99 clearance rate stored as price)
    'GLSMANASH28G', 'GLSMANMADRIGMC', 'GLSMANMNTRIGMC', 'GLSMANPZABPGMCB', 'GLSMANPLA416M',
  ],
  '406': [
    // THD Stage Grid Mosaic — all 8 colors, stale/corrupted, absent from Q3-2026 list
    'THD0031-00410', 'THD0031-00411', 'THD0031-00412', 'THD0031-00413',
    'THD0031-00414', 'THD0031-00415', 'THD0031-00416', 'THD0031-00417',
  ],
  MSI: [
    'NMIX7X8HEX-N', // discontinued in MSI Jan-26 price list
  ],
};

const WAIVE = {
  AZT: {
    skus: ['8708', '8720', '8707', '8700', '55245', '55239', '55233'],
    note: 'Verified correct per-piece 2026-09-04: single pressed tiles (4x8 long hex 0.1494 sf/pc, 8.5x10 hex 0.4424 sf/pc), cost = price-list $4.27/SF x piece area exactly; retail at/above market (LA Floor Coverings $6.83/sf, Floorzz $6.98/sf).',
  },
  UN: {
    skus: ['UN-TOUCH-GRIS2X-2X8', 'UN-TOUCH-CREMA2-2X16', 'UN-TOUCH-GRIS2X-2X16', 'UN-TOUCH-BLANCO-2X16', 'UN-TOUCH-GRIS4X-4X8'],
    note: 'Verified correct per-piece 2026-09-04: Unicorn Q4-2025 MSRP list prices these kit-kat pieces per EACH ($1.50-3.00); cost = 50% MSRP per import-unicorn.js design.',
  },
  MSI: {
    skus: ['SMOT-CLATIL-NOBRED2.25X7.5-N', 'SMOT-CLATIL-DOVGRA2.25X7.5', 'SMOT-PT-WW36',
      'NURBDUSMIX4X12', 'NURBWARCONMIX4X12', 'NURBINKMIX4X12', 'NURBCREMIX4X12',
      'NURBGRAMIX4X12', 'NURBPURMIX4X12', 'NMIX7X8HEX-N'],
    note: 'Verified correct per-piece 2026-09-04: MSI Jan-26 price list carries matching per-PIECE prices (loose bricks EACH $0.83-0.87; $/sqft x piece area for the rest); retails at/above market.',
  },
  BED: {
    skus: ['100001385', '100001387', '100001386', '100001381', '100001379', '100001380'],
    note: 'Verified correct per-piece 2026-09-04: Monet deco pieces; cost matches Bedrosians Q4-2025 book exactly ($10.91-12.35/SF / ~9 pcs per SF); retail 5-13% above bedrosians.com own per-sqft retail.',
  },
};

const vendors = Object.fromEntries(
  (await pool.query(`SELECT code, id FROM vendors WHERE code = ANY($1)`,
    [[...new Set([...Object.keys(DEACTIVATE), ...Object.keys(WAIVE)])]])).rows.map((r) => [r.code, r.id]));

// preview current state
for (const [code, skus] of Object.entries(DEACTIVATE)) {
  const { rows } = await pool.query(
    `SELECT s.vendor_sku, s.status, pr.cost, pr.retail_price FROM skus s
     JOIN products p ON p.id=s.product_id AND p.vendor_id=$1
     LEFT JOIN pricing pr ON pr.sku_id=s.id WHERE s.vendor_sku = ANY($2)`, [vendors[code], skus]);
  console.log(`${code}: deactivating ${rows.filter((r) => r.status === 'active').length} of ${skus.length} listed (rest already inactive/missing)`);
  for (const r of rows) console.log(`  ${r.status === 'active' ? 'DEACTIVATE' : 'skip(' + r.status + ')'} ${r.vendor_sku} cost=${r.cost} retail=${r.retail_price}`);
}
console.log('MSI: NURBNAVMIX4X12 → unit/per_unit cost 1.31 retail 2.39 (sibling parity); SMOT-CLATIL x2 packaging 7.25sf/50pc');

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [code, skus] of Object.entries(DEACTIVATE)) {
    await client.query(
      `UPDATE skus s SET status='inactive', updated_at=now()
       FROM products p WHERE p.id=s.product_id AND p.vendor_id=$1 AND s.vendor_sku=ANY($2) AND s.status='active'`,
      [vendors[code], skus]);
  }
  // MSI Urbano Navy: per-piece stored as per-sqft → sibling-parity per-piece pricing
  await client.query(
    `UPDATE pricing pr SET cost=1.31, retail_price=2.39, price_basis='per_unit'
     FROM skus s, products p WHERE pr.sku_id=s.id AND p.id=s.product_id
       AND p.vendor_id=$1 AND s.vendor_sku='NURBNAVMIX4X12' AND pr.retail_price < 4`, [vendors.MSI]);
  await client.query(
    `UPDATE skus s SET sell_by='unit', updated_at=now() FROM products p
     WHERE p.id=s.product_id AND p.vendor_id=$1 AND s.vendor_sku='NURBNAVMIX4X12'`, [vendors.MSI]);
  // loose-brick packaging (MSI Jan-26 list: 50 pc / 7.25 sf per box)
  for (const sku of ['SMOT-CLATIL-NOBRED2.25X7.5-N', 'SMOT-CLATIL-DOVGRA2.25X7.5']) {
    await client.query(
      `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
       SELECT s.id, 7.25, 50 FROM skus s JOIN products p ON p.id=s.product_id
       WHERE p.vendor_id=$1 AND s.vendor_sku=$2
       ON CONFLICT (sku_id) DO UPDATE SET
         sqft_per_box=COALESCE(packaging.sqft_per_box, EXCLUDED.sqft_per_box),
         pieces_per_box=COALESCE(packaging.pieces_per_box, EXCLUDED.pieces_per_box)`,
      [vendors.MSI, sku]);
  }
  // waive verified false positives
  for (const [code, w] of Object.entries(WAIVE)) {
    const { rowCount } = await client.query(
      `UPDATE quality_violations qv SET status='waived', waived_by='fix-mosaic-underpriced-triage-2026-09',
         waived_at=now(), waive_note=$3
       FROM skus s WHERE s.id=qv.sku_id AND qv.rule_key='mosaic-underpriced' AND qv.status='open'
         AND qv.vendor_id=$1 AND s.vendor_sku=ANY($2)`, [vendors[code], w.skus, w.note]);
    console.log(`${code}: waived ${rowCount}`);
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }

await runQualityAudit(pool, { triggeredBy: 'fix-mosaic-underpriced-triage-2026-09', ruleKeys: ['mosaic-underpriced'] });
console.log('APPLIED + audit re-run');
await pool.end();
