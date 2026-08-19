#!/usr/bin/env node
/**
 * convert-natural-stone-per-piece.cjs
 *
 * Many natural-stone products are sold BY THE PIECE (one tile / one slab), not by
 * the box or by loose sqft. Because they were imported with sell_by='sqft' (or
 * sell_by='box' with no packaging), the storefront couldn't compute a piece price
 * and fell back to the "Call for Price & Stock" banner (or a bare sqft calculator).
 *
 * The platform already has a working per-piece model:
 *     sell_by = 'unit'  +  pricing.price_basis = 'per_sqft'  +  packaging.sqft_per_box = <area of ONE piece>
 * Storefront displayPrice() and cart.js both compute piece price = retail_price * sqft_per_box.
 *
 * This migration flips qualifying natural-stone SKUs onto that model WITHOUT
 * touching the pricing table's dollar amounts (the per-sqft rate is preserved,
 * so margin floors and re-imports stay honest). It only:
 *   - sets skus.sell_by = 'unit'
 *   - ensures pricing.price_basis = 'per_sqft'
 *   - inserts/updates packaging(sqft_per_box = piece area from the size, pieces_per_box = 1)
 *
 * The piece area is derived from the SKU's `size` attribute (e.g. 12"x24") with a
 * fallback to the variant_name. Anything without a clean rectangular size
 * (mosaics, "Versailles Pattern", split-face ranges, moldings) is SKIPPED and
 * left as-is so it stays call-for-price rather than getting a bogus area.
 *
 * Usage:
 *   node scripts/convert-natural-stone-per-piece.cjs           # dry run (default) — prints plan
 *   node scripts/convert-natural-stone-per-piece.cjs --apply   # writes changes in a transaction
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const APPLY = process.argv.includes('--apply');
const STONE_CATEGORIES = ['natural-stone', 'stacked-stone', 'porcelain-slabs', 'soapstone-countertops'];

// ---- size parsing -------------------------------------------------------
// Turn a fraction/whole-number token ("3/4", "1-1/4", "12", "12.5") into inches.
function toInches(tok) {
  if (!tok) return NaN;
  const s = String(tok).replace(/["″\s]/g, '').trim();
  const wf = s.match(/^(\d+)[-](\d+)\/(\d+)$/);           // 1-1/4
  if (wf) return parseInt(wf[1]) + parseInt(wf[2]) / parseInt(wf[3]);
  const f = s.match(/^(\d+)\/(\d+)$/);                    // 3/4
  if (f) return parseInt(f[1]) / parseInt(f[2]);
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

// Extract a rectangular piece area (sqft) from a size string. Returns null when
// the value isn't a clean W x H in inches. Rejects patterns/meshes/ranges.
function pieceAreaFromSize(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Kill obvious non-rectangular formats up front.
  if (/mesh|pattern|random|free\s*length|split|chevron|herringbone|versailles/i.test(s)) return null;
  if (/\d\s*[-]\s*\d+\s*[-]\s*\d+/.test(s)) return null;   // "4-6-8" random strip
  // Strip a trailing finish descriptor after a separator ("12\"x24\" · Honed").
  s = s.split(/[·,|]/)[0];
  // Normalise the separator and quotes, then match W x H at the start.
  const m = s.replace(/[×X]/g, 'x').match(/^\s*([\d.\/\-]+)"?\s*x\s*([\d.\/\-]+)"?/);
  if (!m) return null;
  const w = toInches(m[1]);
  const h = toInches(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  const area = (w * h) / 144;
  // Guard: ignore implausibly tiny (trim/pencil, < ~0.02 sqft) results.
  if (area < 0.02) return null;
  return Math.round(area * 10000) / 10000;
}

async function main() {
  console.log(`\n=== Natural stone → per-piece  (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows } = await pool.query(
    `SELECT s.id AS sku_id, s.sell_by, s.variant_name, p.name AS product_name,
            pr.price_basis, pr.retail_price,
            (SELECT sa.value FROM sku_attributes sa
               JOIN attributes a ON a.id = sa.attribute_id
              WHERE sa.sku_id = s.id AND a.slug = 'size' LIMIT 1) AS size_attr
       FROM skus s
       JOIN products p  ON p.id = s.product_id
       JOIN pricing pr  ON pr.sku_id = s.id
       LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.category_id IN (SELECT id FROM categories WHERE slug = ANY($1))
        AND s.status = 'active'
        AND s.sell_by IN ('sqft', 'box', 'unit')
        AND (pk.sqft_per_box IS NULL OR pk.sqft_per_box <= 0)
        AND pr.retail_price > 0`,
    [STONE_CATEGORIES]
  );

  const plan = [];
  const skipped = [];
  for (const r of rows) {
    const area = pieceAreaFromSize(r.size_attr) || pieceAreaFromSize(r.variant_name);
    if (area == null) {
      skipped.push(r);
      continue;
    }
    plan.push({ ...r, area });
  }

  // Preview
  console.log(`Candidates (active stone, no usable area, priced): ${rows.length}`);
  console.log(`  → convertible to per-piece: ${plan.length}`);
  console.log(`  → skipped (no clean size):  ${skipped.length}\n`);

  const bySize = {};
  for (const p of plan) { const k = (p.size_attr || p.variant_name || '?').trim(); bySize[k] = (bySize[k] || 0) + 1; }
  console.log('Sample of conversions:');
  plan.slice(0, 12).forEach(p => {
    const piecePrice = (parseFloat(p.retail_price) * p.area).toFixed(2);
    console.log(`  ${p.product_name} — ${p.variant_name || p.size_attr}  |  ${p.area} sqft/pc  |  $${p.retail_price}/sqft → $${piecePrice}/pc`);
  });
  if (skipped.length) {
    console.log('\nSkipped (left call-for-price — no clean rectangular size):');
    const seen = new Set();
    skipped.forEach(s => { const k = (s.size_attr || s.variant_name || '(none)').trim(); if (!seen.has(k)) { seen.add(k); console.log(`  · ${k}`); } });
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write these changes.\n');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(`UPDATE skus SET sell_by = 'unit', updated_at = now() WHERE id = $1`, [p.sku_id]);
      // Preserve the per-sqft rate; only guarantee the basis is set so displayPrice multiplies.
      await client.query(`UPDATE pricing SET price_basis = 'per_sqft' WHERE sku_id = $1 AND (price_basis IS NULL OR price_basis IN ('sqft','per_sqft'))`, [p.sku_id]);
      await client.query(
        `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
              VALUES ($1, $2, 1)
         ON CONFLICT (sku_id) DO UPDATE
              SET sqft_per_box = EXCLUDED.sqft_per_box, pieces_per_box = 1`,
        [p.sku_id, p.area]
      );
      updated++;
    }
    await client.query('COMMIT');
    console.log(`\n✔ Applied. ${updated} SKUs converted to per-piece.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n✗ Rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
