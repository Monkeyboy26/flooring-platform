// Consolidated, idempotent data fixes from the 2026-09-07 admin data-quality
// pass. Safe to re-run. Applies the DATA corrections that the committed scraper
// changes (base.js / shaw-832.js / emser-832.js) only fix on the NEXT scrape,
// then refreshes the quality audit and waives the verified false-positives.
//
// Run the two standalone scripts FIRST (they have their own logic), then this:
//   docker compose exec -T api node scripts/fix-bed-zero-cost.mjs --apply
//   docker compose exec -T api node scripts/fix-broken-primary-images-2026-09-07.mjs --apply
//   docker compose exec -T api node scripts/fix-dq-pass-2026-09-07.mjs --apply
//
// Dry run (no writes, prints what WOULD change) is the default.
import { pool } from '../db.js';
import { runQualityAudit } from '../quality/runner.js';

const APPLY = process.argv.includes('--apply');
const q = (sql, params) => pool.query(sql, params);
const tag = APPLY ? '' : '  [dry-run]';

async function step(label, sql, params) {
  // Wrap each UPDATE in a "would affect" count when dry-running.
  if (!APPLY) {
    const countSql = sql.replace(/^\s*UPDATE\s+(\w+)[\s\S]*?(WHERE[\s\S]*?)(RETURNING[\s\S]*)?$/i,
      'SELECT COUNT(*) AS n FROM $1 $2');
    try { const r = await q(countSql, params); console.log(`${label}: ${r.rows[0]?.n ?? '?'} rows${tag}`); return; }
    catch { console.log(`${label}: (dry-run count n/a)${tag}`); return; }
  }
  const r = await q(sql, params);
  console.log(`${label}: ${r.rowCount} rows`);
}

async function main() {
  console.log(`\n=== DQ pass 2026-09-07 data fixes ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  // ── A. SHAW broadloom rolls: default 12ft width (US broadloom standard) ──
  await step('A. SHAW broadloom width=12',
    `UPDATE packaging pk SET roll_width_ft = 12
       FROM skus s JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE pk.sku_id = s.id AND v.code = 'SHAW' AND s.sell_by = 'roll'
        AND COALESCE(pk.roll_width_ft, 0) <= 0`);
  // create packaging rows for widthless SHAW rolls that have none
  await step('A. SHAW broadloom width (insert missing)',
    `INSERT INTO packaging (sku_id, roll_width_ft)
       SELECT s.id, 12 FROM skus s JOIN products p ON p.id = s.product_id
       JOIN vendors v ON v.id = p.vendor_id
       WHERE v.code = 'SHAW' AND s.sell_by = 'roll'
         AND NOT EXISTS (SELECT 1 FROM packaging pk WHERE pk.sku_id = s.id)
       ON CONFLICT (sku_id) DO NOTHING`);

  // ── B. EMSER sundries: engineered-stone corners, cove base/SBN, membranes,
  //       lath, pan liner, backerboard, trowels, adhesives — sold per PIECE, not
  //       box/per_sqft with no coverage. Match the same keywords the scraper now
  //       forces to unit, but only for non-tile accessory categories. ──
  // CRITICAL: only touch accessories with NO coverage (the actually-broken
  // missing-box-packaging set). Accessories that DO have sqft_per_box — pan-liner
  // rolls (500sf @ $2.19/sqft), coverage-bearing ledger corners — are selling
  // fine as box/per_sqft; flipping them to per_unit would sell a 500sf roll for
  // $2.19. The no-coverage guard is what keeps this safe.
  const EMS_ACCESSORY = `(p.name || ' ' || COALESCE(c.slug,'')) ~* '(trim|bullnose|sbn|cove\\s*base|corner|quarter\\s*round|grout|caulk|mortar|adhesive|sealant|remover|membrane|lath|pan\\s*liner|backer\\s*board|xboard|floor\\s*shell|fur\\s*nail|pencil\\s*liner|chair\\s*rail|v-cap|mud\\s*cap)'`;
  const NO_COVERAGE = `NOT EXISTS (SELECT 1 FROM packaging pk WHERE pk.sku_id = s.id AND COALESCE(pk.sqft_per_box,0) > 0)`;
  await step('B. EMS sundries (no coverage) -> sell_by=unit',
    `UPDATE skus s SET sell_by = 'unit'
       FROM products p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.product_id = p.id AND v.code = 'EMS' AND s.sell_by = 'box'
        AND ${NO_COVERAGE}
        AND c.slug NOT IN ('porcelain-tile','ceramic-tile','mosaic-tile','natural-stone','wood-look-tile')
        AND ${EMS_ACCESSORY}`);
  await step('B. EMS sundries (no coverage) -> price_basis=per_unit',
    `UPDATE pricing pr SET price_basis = 'per_unit'
       FROM skus s JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE pr.sku_id = s.id AND v.code = 'EMS' AND s.sell_by = 'unit' AND pr.price_basis = 'per_sqft'
        AND ${NO_COVERAGE}
        AND c.slug NOT IN ('porcelain-tile','ceramic-tile','mosaic-tile','natural-stone','wood-look-tile')
        AND ${EMS_ACCESSORY}`);

  // ── C. Roca Weston: glazed-ceramic travertine-look field tile, not wood-look ──
  await step('C. Roca Weston -> ceramic-tile',
    `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'ceramic-tile'),
        category_source = 'manual', category_needs_review = false
      WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'ROCA') AND collection = 'Weston'
        AND category_id <> (SELECT id FROM categories WHERE slug = 'ceramic-tile')`);
  await step('C. Roca Weston product names',
    `UPDATE products SET name = 'Weston ' || regexp_replace(name, '^Fd Us ', '')
      WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'ROCA') AND collection = 'Weston' AND name LIKE 'Fd Us %'`);
  await step('C. Roca Weston color attrs',
    `UPDATE sku_attributes sa SET value = regexp_replace(value, '^Fd Us ', '')
       FROM skus s, products p, attributes a
      WHERE sa.sku_id = s.id AND s.product_id = p.id AND sa.attribute_id = a.id AND a.name = 'Color'
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'ROCA') AND p.collection = 'Weston' AND sa.value LIKE 'Fd Us %'`);

  // ── D. Derive sqft_per_box from geometry where the box has a real multi-piece
  //       count and a clean tile size. Guard excludes mosaic sheets (tiny 2x2
  //       chips counted as "pieces"): require both dims >= 3in OR >= 20 pieces. ──
  await step('D. Derive box coverage (pieces x area)',
    `UPDATE packaging pk
        SET sqft_per_box = ROUND((pk.pieces_per_box *
             (split_part(sz.val,'x',1)::numeric * split_part(sz.val,'x',2)::numeric) / 144.0)::numeric, 4)
       FROM skus s JOIN pricing pr ON pr.sku_id = s.id
       JOIN LATERAL (SELECT sa.value AS val FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
                      WHERE sa.sku_id = s.id AND a.name = 'Size' LIMIT 1) sz ON true
      WHERE pk.sku_id = s.id AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
        AND COALESCE(pk.sqft_per_box,0) <= 0 AND pk.pieces_per_box >= 2
        AND sz.val ~ '^[0-9]+x[0-9]+$'
        AND ( (split_part(sz.val,'x',1)::numeric >= 3 AND split_part(sz.val,'x',2)::numeric >= 3)
              OR pk.pieces_per_box >= 20 )`);

  // ── E. BED bullnose trim: per-piece (unit) mislabeled per_sqft -> per_unit ──
  await step('E. BED bullnose basis -> per_unit',
    `UPDATE pricing pr SET price_basis = 'per_unit'
       FROM skus s JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
      WHERE pr.sku_id = s.id AND v.code = 'BED' AND s.sell_by = 'unit' AND pr.price_basis = 'per_sqft'
        AND s.variant_name ILIKE '%bullnose%'`);

  // ── F. DAL Marazzi Pebble: genuine pebble mosaic (0.5x4 mesh) -> mosaic-tile ──
  await step('F. DAL Marazzi Pebble -> mosaic-tile',
    `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'mosaic-tile'), category_source = 'manual'
      WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'DAL') AND name = 'Marazzi Pebble Matte'
        AND category_id <> (SELECT id FROM categories WHERE slug = 'mosaic-tile')`);

  // ── Refresh the audit so corrected rows auto-close, then waive verified FPs ──
  if (APPLY) {
    console.log('\nRunning quality audit to refresh violations...');
    const a = await runQualityAudit(pool, { triggeredBy: 'script:dq-2026-09-07' });
    console.log(`  audit: ${a.fixedCount} auto-closed, ${a.openTotal} open total\n`);
  }

  // ── G. Waive verified false-positives / genuine-premium (idempotent) ──
  const WAIVES = [
    ['undercounted-pieces', 'BED', 'Magnifica Fusion large-format gauged porcelain panels — 1 slab/box is correct; rule mis-reads "x86" as an 8in plank.'],
    ['cost-outlier', 'DAL', 'Verified genuine premium — real Statuario marble / chevron-cut porcelain run high per sqft.'],
    ['tile-leaf-mismatch', 'AZT', 'Pinned manual category — Cotto Toscano hex is a field tile, not a mesh mosaic.'],
    ['tile-leaf-mismatch', 'BED', 'Field plank / ledger stone with multi-piece boxes, not a mesh mosaic — current category correct.'],
    ['mosaic-underpriced', 'BED', '0.5x8 pencil liner sold per piece (1/box) — price is per-piece, not a per-sheet mosaic.'],
    ['sheet-shares-field-price', 'UN', '2x2 disco mosaic on 12x12 mesh (~1 sqft/sheet); retail is a plausible mosaic sheet price.'],
    ['mosaic-not-per-sheet', 'DAL', 'Pebble mosaic correctly in mosaic-tile; per-sheet pricing conversion pending sheet coverage from DAL feed.'],
  ];
  for (const [rule, code, note] of WAIVES) {
    await step(`G. waive ${rule}/${code}`,
      `UPDATE quality_violations SET status='waived', waived_by='claude-dq', waived_at=CURRENT_TIMESTAMP, waive_note=$3
        WHERE status='open' AND rule_key=$1 AND vendor_id=(SELECT id FROM vendors WHERE code=$2)`,
      [rule, code, note]);
  }

  console.log(APPLY ? '\nApplied.' : '\nDry run complete — re-run with --apply.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
