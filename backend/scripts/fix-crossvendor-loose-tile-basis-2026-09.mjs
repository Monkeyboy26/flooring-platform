/**
 * fix-crossvendor-loose-tile-basis-2026-09.mjs — part 2 of the loose-tile
 * per-box sweep (owner, 2026-09-05: "Urbano Navy shows per each — should be
 * per box. Root out the issue elsewhere.").
 *
 * fix-msi-loose-tile-per-box-2026-09.mjs handled MSI. This applies the verified
 * findings for the other vendors (each checked against its own price source):
 *
 * AZT — Arizona Tile's list quotes SF (not EA) for loose small-format tile the
 *   catalog filed under mosaic/stacked-stone (Paloma 4x8 hex, Paros & Cotto
 *   Toscano 8.5x10 hex, Calacatta Umber 8x8 hex + 3x12, Sahara 8" hex); the
 *   UNIT_CATEGORIES branch per-pieced them (arizona.js now has the
 *   looseSmallPiece guard). Convert to box @ list SF rate, keystone retail.
 *   Also fixes Paloma's 2.64x per-piece overmargin. Pure-loose products move
 *   to their family leaf (pinned); loose SKUs inside mixed mesh products stay
 *   put and get an evidence waiver on mosaic-not-per-sheet.
 *
 * BED — Bedrosians Q4-2025 book prices Ferrara 3x6 / Lantern 3x8 / Allora
 *   decos in S/F, but the rates were stored as per-piece dollars (a $19.99
 *   Ferrara subway PIECE = $161/sf). Flip to box/per_sqft keeping the dollars
 *   as SF rates; correct costs to book nets; per-sheet reprice the Ferrara 1x1
 *   mosaic/chevron sheets (rate x sheet area, were ~4-11% high); deactivate the
 *   2 rhomboid SKUs the book marks discontinued (one has cost=0); move the
 *   deco products out of mosaic-tile (pinned).
 *
 * EMS — Borigni Black/Beige packaging corrupted (0.946 sf/box = ONE sheet's
 *   area; White/Gray twins carry the true 5.676 sf / 6 sheets). Pricing is
 *   correct per-sheet ($40.69 matches market). Packaging fix only.
 *
 * Verified clean, no change: ELY (vendor sells per piece, site-confirmed),
 * WPT Bloom Sea Deco / MSI clay bricks / SMOT-CLATIL (vendor EA pricing),
 * ADEX hand-painted decos, Stanza standing pebble, ROCA rope/skirt trim.
 * DAL Color Wheel glossy trim is a different bug (right basis, smeared
 * dollars) — separate fix.
 *
 * Idempotent. Dry-run unless --apply.
 */
import { pool } from '../db.js';
import { upsertPricing, upsertPackaging } from '../scrapers/base.js';
import { runQualityAudit } from '../quality/runner.js';

const APPLY = process.argv.includes('--apply');
const r2 = (v) => Math.round(v * 100) / 100;

// ── AZT: list SF rates from backend/data/arizona/tile-prices.xlsx ("Price
// List" sheet, Unit=SF rows; verified 2026-09-05) ───────────────────────────
const AZT_RATES = {
  8700: 4.27, 8707: 4.27, 8708: 4.27, 8720: 4.27,       // Paloma long hex 4x8
  55233: 4.27, 55239: 4.27, 55245: 4.27,                 // Paros hex 8.5x10
  341283: 5.21, 341289: 5.21,                            // Cotto Toscano hex 8.5x10
  117938: 12.58,                                         // Calacatta Umber 8x8 hex
  117948: 10.47,                                         // Calacatta Umber 3x12
  340670: 15.26,                                         // Sahara 8" hex
};
// Pure-loose products move to the family leaf; mixed mesh products keep their
// category and the loose SKU gets a waiver instead.
const AZT_CATEGORY_MOVES = {
  'Paloma Cloud Hex': 'backsplash-wall',
  'Paloma Cotton Hex': 'backsplash-wall',
  'Paloma Pumice Hex': 'backsplash-wall',
  'Cotto Toscano Bruciato Hex': 'porcelain-tile',
  'Cotto Toscano Tabacco Hex': 'porcelain-tile',
};
const AZT_WAIVE_SKUS = ['117938', '117948', '340670', '55233', '55239', '55245'];
const AZT_WAIVE_NOTE = 'Loose small-format tile sold per box at the AZT list SF rate '
  + '(owner rule 2026-09-05, arizona.js looseSmallPiece guard); stays in the mosaic/stacked '
  + 'category because sibling SKUs are genuine mesh sheets.';

// ── BED: Q4-2025 book S/F nets (pdftotext of the book in uploads/pricelists;
// verified 2026-09-05). retail:null = keep current stored retail as the SF
// retail (already nine-ending at sane margins). ─────────────────────────────
const BED_FLIPS = {
  DECFERARG36H: { cost: 11.63 }, DECFERBIA36H: { cost: 12.35 }, DECFERNER36H: { cost: 10.85 },
  DECFERARG36DECOH: { cost: 26.39 }, DECFERBIA36DECOH: { cost: 27.11 }, DECFERNER36DECOH: { cost: 25.67 },
  100008844: { cost: 12.35 }, 100008845: { cost: 12.35 }, 100008846: { cost: 12.35 }, 100008847: { cost: 12.35 },
  DECALLFIODECOM: { cost: 4.55 }, DECALLBLA324M: { cost: 4.73 }, DECALLBLAHEXM: { cost: 4.37 },
  DECALLGRE324M: { cost: 4.73 }, DECALLGREHEXM: { cost: 4.37 },
  DECALLWHI324M: { cost: 4.73 }, DECALLWHIHEXM: { cost: 4.37 },
  DECALLSTEDECOM: { cost: 4.55 }, DECALLTELDECOM: { cost: 4.55 },
};
// Ferrara mesh sheets: keep per-sheet selling, reprice sheet = book rate x
// sheet area (sqft_per_box / pieces_per_box from packaging).
const BED_SHEET_RATES = {
  DECFERARG11MOH: 27.35, DECFERBIA11MOH: 28.13, DECFERNER11MOH: 25.19,
  DECFERARGCHEMOH: 28.97, DECFERBIACHEMOH: 29.75, DECFERNERCHEMOH: 26.39,
};
const BED_DEACTIVATE = ['DECALLBLARHOM', 'DECALLGRERHOM']; // book: rhomboid discontinued
const BED_CATEGORY_MOVES = {
  'Ferrara Argento': 'natural-stone', 'Ferrara BIANCO': 'natural-stone', 'Ferrara Nero': 'natural-stone',
  'Lantern White': 'backsplash-wall', 'Lantern Moss': 'backsplash-wall',
  'Lantern Ochre': 'backsplash-wall', 'Lantern Cobalt': 'backsplash-wall',
  'Allora Fiore': 'porcelain-tile', 'Allora Stella': 'porcelain-tile', 'Allora Telaio': 'porcelain-tile',
  'Allora Solid Black': 'porcelain-tile', 'Allora Solid Grey': 'porcelain-tile', 'Allora Solid White': 'porcelain-tile',
};

async function fetchSkus(vendorCode, vendorSkus) {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.sell_by, s.status, p.id AS product_id, p.name AS product,
           c.slug AS category, pr.cost, pr.retail_price, pr.price_basis, pr.map_price,
           pk.sqft_per_box, pk.pieces_per_box
    FROM skus s JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = $1 AND s.vendor_sku = ANY($2)`, [vendorCode, vendorSkus]);
  return new Map(rows.map((r) => [r.vendor_sku, r]));
}

async function moveCategory(productId, name, fromSlug, toSlug) {
  if (fromSlug === toSlug) return;
  const { rowCount } = await pool.query(`
    UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = $2),
           category_source = 'manual', category_needs_review = false, updated_at = now()
    WHERE id = $1 AND EXISTS (SELECT 1 FROM categories WHERE slug = $2)`, [productId, toSlug]);
  if (rowCount) console.log(`  recategorized "${name}" ${fromSlug} → ${toSlug} (pinned)`);
}

console.log(`\n=== Cross-vendor loose-tile basis fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

// ── AZT ─────────────────────────────────────────────────────────────────────
const aztRows = await fetchSkus('AZT', Object.keys(AZT_RATES));
const aztConvert = [];
console.log('— AZT —');
for (const [sku, rate] of Object.entries(AZT_RATES)) {
  const r = aztRows.get(sku);
  if (!r) { console.log(`  MISSING ${sku}`); continue; }
  if (r.sell_by === 'box' && r.price_basis === 'per_sqft') { console.log(`  ok ${sku} already box/per_sqft`); continue; }
  const pieceSf = r.sqft_per_box && r.pieces_per_box ? r.sqft_per_box / r.pieces_per_box : null;
  const derived = pieceSf ? r2(Number(r.cost) / pieceSf) : null;
  if (derived != null && Math.abs(derived - rate) > 0.02 * rate) {
    console.log(`  SKIP ${sku} stored cost ≠ list rate (derived $${derived}/sf vs $${rate}/sf)`); continue;
  }
  aztConvert.push({ ...r, rate });
  console.log(`  ${sku} "${r.product}" [${r.category}] $${r.cost}/pc → box $${rate}/sf (retail ~$${r2(rate * 1.6)}/sf pre-nine)`);
}

// ── BED ─────────────────────────────────────────────────────────────────────
const bedRows = await fetchSkus('BED',
  [...Object.keys(BED_FLIPS), ...Object.keys(BED_SHEET_RATES), ...BED_DEACTIVATE]);
const bedFlip = [], bedSheets = [];
console.log('— BED —');
for (const [sku, spec] of Object.entries(BED_FLIPS)) {
  const r = bedRows.get(sku);
  if (!r) { console.log(`  MISSING ${sku}`); continue; }
  if (r.sell_by === 'box' && r.price_basis === 'per_sqft') { console.log(`  ok ${sku} already box/per_sqft`); continue; }
  bedFlip.push({ ...r, cost: spec.cost });
  console.log(`  ${sku} "${r.product}" $${r.cost}/pc → box $${spec.cost}/sf cost, retail $${r.retail_price}/sf`);
}
for (const [sku, rate] of Object.entries(BED_SHEET_RATES)) {
  const r = bedRows.get(sku);
  if (!r || !r.sqft_per_box || !r.pieces_per_box) { console.log(`  MISSING/no-pack ${sku}`); continue; }
  const sheetSf = Number(r.sqft_per_box) / Number(r.pieces_per_box);
  const cost = r2(rate * sheetSf);
  if (Math.abs(cost - Number(r.cost)) < 0.02) { console.log(`  ok ${sku} sheet price already book-exact`); continue; }
  bedSheets.push({ ...r, cost });
  console.log(`  ${sku} "${r.product}" sheet $${r.cost} → $${cost} (book $${rate}/sf × ${sheetSf.toFixed(3)} sf/sheet)`);
}
for (const sku of BED_DEACTIVATE) {
  const r = bedRows.get(sku);
  console.log(`  ${r && r.status === 'active' ? 'DEACTIVATE' : 'skip'} ${sku} (book: rhomboid discontinued${r && Number(r.cost) === 0 ? ', cost=0' : ''})`);
}

// ── EMS ─────────────────────────────────────────────────────────────────────
console.log('— EMS —');
console.log('  A41BORIBK1212MO2 + A41BORIBE1212MO2 packaging → 5.676 sf / 6 sheets (match White/Gray twins)');

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }

// AZT apply
for (const c of aztConvert) {
  await pool.query(`UPDATE skus SET sell_by='box', updated_at=now() WHERE id=$1`, [c.sku_id]);
  await upsertPricing(pool, c.sku_id, {
    cost: c.rate, retail_price: r2(c.rate * 1.6), price_basis: 'per_sqft', map_price: c.map_price || null,
  });
  const move = AZT_CATEGORY_MOVES[c.product];
  if (move) await moveCategory(c.product_id, c.product, c.category, move);
}

// BED apply
for (const c of bedFlip) {
  await pool.query(`UPDATE skus SET sell_by='box', updated_at=now() WHERE id=$1`, [c.sku_id]);
  await upsertPricing(pool, c.sku_id, {
    cost: c.cost, retail_price: Number(c.retail_price), price_basis: 'per_sqft', map_price: c.map_price || null,
  });
}
for (const c of bedSheets) {
  await upsertPricing(pool, c.sku_id, {
    cost: c.cost, retail_price: r2(c.cost * 1.6), price_basis: 'per_unit', map_price: c.map_price || null,
  }, { coveringFloor: true });
}
await pool.query(`
  UPDATE skus s SET status='inactive', updated_at=now()
  FROM products p WHERE p.id=s.product_id
    AND p.vendor_id=(SELECT id FROM vendors WHERE code='BED')
    AND s.vendor_sku=ANY($1) AND s.status='active'`, [BED_DEACTIVATE]);
for (const [name, slug] of Object.entries(BED_CATEGORY_MOVES)) {
  const { rows } = await pool.query(`
    SELECT p.id, c.slug FROM products p
    JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    WHERE v.code='BED' AND p.name=$1`, [name]);
  for (const p of rows) await moveCategory(p.id, name, p.slug, slug);
}

// EMS apply
await pool.query(`
  UPDATE packaging pk SET sqft_per_box=5.6760, pieces_per_box=6
  FROM skus s, products p WHERE pk.sku_id=s.id AND p.id=s.product_id
    AND p.vendor_id=(SELECT id FROM vendors WHERE code='EMS')
    AND s.vendor_sku IN ('A41BORIBK1212MO2','A41BORIBE1212MO2')`);

// Reopen any stale "verified correct per-piece" waivers on converted AZT SKUs,
// re-audit, then waive the loose SKUs that stay inside mixed mesh products.
const convertedIds = [...aztConvert, ...bedFlip].map((c) => c.sku_id);
await pool.query(`
  UPDATE quality_violations SET status='open', waived_by=NULL, waived_at=NULL, waive_note=NULL
  WHERE sku_id=ANY($1) AND rule_key='mosaic-underpriced' AND status='waived'`, [convertedIds]);
await runQualityAudit(pool, {
  triggeredBy: 'fix-crossvendor-loose-tile-basis-2026-09',
  ruleKeys: ['mosaic-underpriced', 'mosaic-not-per-sheet', 'field-tile-sold-per-piece'],
});
const { rowCount: waived } = await pool.query(`
  UPDATE quality_violations qv SET status='waived',
    waived_by='fix-crossvendor-loose-tile-basis-2026-09', waived_at=now(), waive_note=$2
  FROM skus s, products p, vendors v
  WHERE s.id=qv.sku_id AND p.id=s.product_id AND v.id=p.vendor_id
    AND v.code='AZT' AND s.vendor_sku=ANY($1)
    AND qv.rule_key='mosaic-not-per-sheet' AND qv.status='open'`,
  [AZT_WAIVE_SKUS, AZT_WAIVE_NOTE]);
console.log(`\nwaived ${waived} mixed-product loose SKUs on mosaic-not-per-sheet`);

// The audit runner flips 'fixed' rows back to 'open' when a condition
// reappears — which resurrects the 2026-09-04 verified-per-piece items (their
// waived rows had cycled through 'fixed'). Restore those waivers with their
// original evidence notes.
const RESTORE_WAIVERS = [
  ['MSI', ['SMOT-CLATIL-NOBRED2.25X7.5-N', 'SMOT-CLATIL-DOVGRA2.25X7.5'],
    'Verified correct per-piece 2026-09-04 (restored 2026-09-05 after audit flip): MSI Jan-26 list prices these loose bricks per EACH ($0.83-0.87).'],
  ['UN', ['UN-TOUCH-GRIS2X-2X8', 'UN-TOUCH-CREMA2-2X16', 'UN-TOUCH-GRIS2X-2X16', 'UN-TOUCH-BLANCO-2X16', 'UN-TOUCH-GRIS4X-4X8'],
    'Verified correct per-piece 2026-09-04 (restored 2026-09-05 after audit flip): Unicorn Q4-2025 MSRP list prices these kit-kat pieces per EACH ($1.50-3.00); cost = 50% MSRP per import-unicorn.js design.'],
  ['BED', ['100001385', '100001387', '100001386', '100001381', '100001379', '100001380'],
    'Verified correct per-piece 2026-09-04 (restored 2026-09-05 after audit flip): Monet deco pieces; cost matches Bedrosians Q4-2025 book exactly ($10.91-12.35/SF / ~9 pcs per SF); retail 5-13% above bedrosians.com own per-sqft retail.'],
];
for (const [code, skus, note] of RESTORE_WAIVERS) {
  const { rowCount } = await pool.query(`
    UPDATE quality_violations qv SET status='waived',
      waived_by='fix-crossvendor-loose-tile-basis-2026-09', waived_at=now(), waive_note=$3
    FROM skus s, products p, vendors v
    WHERE s.id=qv.sku_id AND p.id=s.product_id AND v.id=p.vendor_id
      AND v.code=$1 AND s.vendor_sku=ANY($2)
      AND qv.rule_key='mosaic-underpriced' AND qv.status='open'`, [code, skus, note]);
  if (rowCount) console.log(`restored ${rowCount} ${code} per-piece waivers`);
}
console.log('APPLIED + scoped audit re-run');
await pool.end();
