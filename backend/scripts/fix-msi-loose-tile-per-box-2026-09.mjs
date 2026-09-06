/**
 * fix-msi-loose-tile-per-box-2026-09.mjs — sell MSI loose small-format tile per
 * BOX, not per piece (owner, 2026-09-05: "Urbano Navy shows price per each —
 * should be per box").
 *
 * Root cause: MSI's web taxonomy files loose small-format tile under
 * "ceramic-mosaics" (Urbano 3D Mix 4x12 @ 30 pcs/box, PT 3x6 subway @ 8 pcs/box,
 * Tetris deco 6x6 @ 20 pcs/box), landing them in mosaic categories. The
 * per-sheet selling rule then converted their SQFT price-list rate to a
 * per-piece price ($2.39/ea for a 4x12 tile) even though MSI prices these SQFT
 * and sells them by real cartons ($39.30/box). The 2026-09-04 mosaic-underpriced
 * triage cemented that presentation (waived as "correct per-piece").
 *
 * scrapers/msi-unified.js now guards this at the source (_looseSmallPiece: a
 * known multi-piece carton whose piece is under 0.5 sqft is loose tile, never a
 * mesh sheet). This script converts the existing rows to match what a re-scrape
 * writes:
 *   - sell_by 'box', price_basis 'per_sqft', cost/retail as SF rates (derived
 *     from the stored per-piece dollars ÷ piece area, cross-checked ±2% against
 *     the Jan-26 price list PRICE/UOM; mismatches are skipped and reported)
 *   - real carton packaging from data/msi/carton-packaging.json
 *   - products stranded in mosaic categories move to their family's leaf,
 *     pinned category_source='manual' so the classifier can't move them back
 *   - stale "verified correct per-piece" waivers reopened, then the scoped
 *     audit re-run so they close as fixed
 *
 * Idempotent (converted rows no longer match the per_unit candidate filter).
 * Dry-run unless --apply.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { upsertPricing, upsertPackaging, isTrimPiece } from '../scrapers/base.js';
import { runQualityAudit } from '../quality/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const r2 = (v) => Math.round(v * 100) / 100;

const REF = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/msi/carton-packaging.json'), 'utf-8')).items;

// Jan-26 dealer price list — cross-check that the derived SF rate is real
const XLSX = (await import('xlsx')).default;
const wb = XLSX.readFile(path.join(__dirname, '../data/msi-pricelist-jan26.xlsb'));
const plSheet = wb.Sheets[wb.SheetNames.find((n) => /price/i.test(n)) || wb.SheetNames[0]];
const plRows = XLSX.utils.sheet_to_json(plSheet, { header: 1 });
const plHeaderIdx = plRows.findIndex((r) => r && r.some((c) => String(c).toUpperCase().includes('ITEM NUMBER')));
const plHeaders = plRows[plHeaderIdx].map((h) => String(h || '').trim().toUpperCase());
const colItem = plHeaders.indexOf('ITEM NUMBER');
const colPriceUom = plHeaders.indexOf('PRICE/UOM');
const listRate = new Map();
for (let i = plHeaderIdx + 1; i < plRows.length; i++) {
  const r = plRows[i];
  if (r && r[colItem]) listRate.set(String(r[colItem]).trim().toUpperCase(), Number(r[colPriceUom]) || null);
}

// Family-correct leaves for products stranded in mosaic categories
const CATEGORY_MOVES = [
  { skuRe: /^NURB\w*MIX4X12$/, slug: 'backsplash-wall' }, // Urbano 3D Mix — field siblings live here
  { skuRe: /^SMOT-PT-WW36$/, slug: 'ceramic-tile' },      // Whisper White 3x6 — SMOT-PT siblings live here
  { skuRe: /^TTETBLANCO66$/, slug: 'natural-stone' },     // Tetris Florita 6x6 marble deco
];

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, p.id AS product_id, p.name AS product,
         c.slug AS category, p.category_source,
         pr.cost, pr.retail_price, pr.map_price, pk.sqft_per_box, pk.pieces_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE v.code = 'MSI' AND s.status = 'active' AND s.sell_by = 'unit'
    AND pr.price_basis = 'per_unit' AND pr.cost > 0
    AND COALESCE(s.variant_type, '') <> 'accessory'
`);

const convert = [];
const skipped = [];
for (const r of rows) {
  const ref = REF[(r.vendor_sku || '').toUpperCase()];
  if (!ref || ref.price_uom !== 'SQFT' || !(ref.pieces_per_box > 1) || !(ref.sqft_per_box > 0)) continue;
  const pieceSf = ref.sqft_per_piece || ref.sqft_per_box / ref.pieces_per_box;
  if (!(pieceSf > 0) || pieceSf >= 0.5) continue; // sheet-like → legitimately per-sheet
  if (isTrimPiece(`${r.product} ${r.variant_name || ''}`)) continue;

  const costRate = r2(Number(r.cost) / pieceSf);
  const retailRate = r2(Number(r.retail_price) / pieceSf);
  const list = listRate.get(r.vendor_sku.toUpperCase());
  if (list && Math.abs(costRate - list) > 0.02 * list) {
    skipped.push({ ...r, costRate, list });
    continue;
  }
  convert.push({ ...r, ref, pieceSf, costRate, retailRate, listRate: list });
}

console.log(`\n=== MSI loose-tile per-box conversion (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
console.log(`candidates converted: ${convert.length}, skipped (cost ≠ Jan-26 list ±2%): ${skipped.length}\n`);
for (const s of skipped) {
  console.log(`  SKIP ${s.vendor_sku} "${s.product}" derived $${s.costRate}/sf vs list $${s.list}/sf`);
}
for (const cvt of convert) {
  console.log(`  ${cvt.vendor_sku} "${cvt.product}" [${cvt.category}] ` +
    `$${cvt.cost}/pc → box $${cvt.costRate}/sf cost, $${cvt.retailRate}/sf retail pre-policy ` +
    `(list $${cvt.listRate ?? 'n/a'}/sf, ${cvt.ref.pieces_per_box} pc / ${cvt.ref.sqft_per_box} sf)`);
}

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); await pool.end(); process.exit(0); }
if (!convert.length) { console.log('nothing to convert'); await pool.end(); process.exit(0); }

const skuIds = convert.map((c) => c.sku_id);
await pool.query(`UPDATE skus SET sell_by = 'box', updated_at = now() WHERE id = ANY($1)`, [skuIds]);
for (const cvt of convert) {
  // upsertPricing applies store policy (keystone band → 1.6×, nine-ending,
  // covering floor) exactly as a re-scrape would
  await upsertPricing(pool, cvt.sku_id, {
    cost: cvt.costRate, retail_price: cvt.retailRate,
    price_basis: 'per_sqft', map_price: cvt.map_price || null,
  });
  await upsertPackaging(pool, cvt.sku_id, {
    sqft_per_box: cvt.ref.sqft_per_box, pieces_per_box: cvt.ref.pieces_per_box,
  });
}

// Move stranded products to their family leaf and pin against the classifier
for (const cvt of convert) {
  const move = CATEGORY_MOVES.find((m) => m.skuRe.test(cvt.vendor_sku.toUpperCase()));
  if (!move || cvt.category === move.slug) continue;
  const { rowCount } = await pool.query(`
    UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = $2),
           category_source = 'manual', category_needs_review = false, updated_at = now()
    WHERE id = $1 AND EXISTS (SELECT 1 FROM categories WHERE slug = $2)`,
    [cvt.product_id, move.slug]);
  if (rowCount) console.log(`  recategorized "${cvt.product}" ${cvt.category} → ${move.slug} (pinned)`);
}

// The 2026-09-04 triage waived these as "verified correct per-piece" — that
// presentation is now overridden. Reopen so the scoped audit closes them as fixed.
const { rowCount: reopened } = await pool.query(`
  UPDATE quality_violations SET status = 'open', waived_by = NULL, waived_at = NULL,
         waive_note = NULL
  WHERE sku_id = ANY($1) AND rule_key = 'mosaic-underpriced' AND status = 'waived'`, [skuIds]);
console.log(`\nreopened ${reopened} stale per-piece waivers`);

await runQualityAudit(pool, {
  triggeredBy: 'fix-msi-loose-tile-per-box-2026-09',
  ruleKeys: ['mosaic-underpriced', 'mosaic-not-per-sheet'],
});
console.log('APPLIED + scoped audit re-run');
await pool.end();
