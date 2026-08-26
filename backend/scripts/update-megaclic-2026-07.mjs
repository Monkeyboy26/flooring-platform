/**
 * MegaClic / AJ Trading price-list update — "AJ Trading Megaclic Price List 071326.pdf"
 * (Effective July 13, 2026.)
 *
 * INPUT: pdftotext -layout dump of the PDF, passed as argv (default
 * data/megaclic-pricelist-2026-07.txt). Rows: `MCxx-#### Color sqft/box $price`.
 *
 * - Repriced items: cost = list Price/Sqft, retail = round-down-.x9(cost×1.6)
 *   with covering floor; packaging.sqft_per_box refreshed.
 * - Discontinued: DB MC*-prefixed base SKUs absent from the list → inactive,
 *   along with their molding siblings (-EC/-FSN/-QR/-RD/-TM) and products left
 *   without active SKUs. (Entire Athens/MCGL line dropped in this list.)
 * - MSR-* SKUs (Northam / Monet lines) are NOT covered by this "Regular" list
 *   and are left untouched — confirm separately with AJ Trading.
 * - New items on the list but not in DB (Novelle MCNL, Santerra MCST) are
 *   reported only; onboarding them is a separate import.
 * - Molding + underlayment prices verified unchanged against DB (Jul 2026).
 *
 * Usage:
 *   node backend/scripts/update-megaclic-2026-07.mjs [pricelist.txt]           # dry run
 *   node backend/scripts/update-megaclic-2026-07.mjs [pricelist.txt] --apply
 */
import pg from 'pg';
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const TXT = process.argv.find(a => a.endsWith('.txt')) || 'data/megaclic-pricelist-2026-07.txt';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const nineDown = (v) => {
  const cents = Math.round(Number(v) * 100);
  return Math.max(9, Math.floor((cents - 9) / 10) * 10 + 9) / 100;
};
const keystone = (cost) => {
  const floorMin = cost + 0.99;
  let nine = nineDown(Math.max(cost * 1.6, floorMin));
  if (nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
};

const MOLDING_SUFFIX = /-(EC|FSN|QR|RD|TM|SN)$/;

// ---- parse the list ----
const rows = [];
for (const line of fs.readFileSync(TXT, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(MC[A-Z]*-\d+)\s+(.+?)\s+([\d.]+)\s+\$([\d.]+)/);
  if (m) rows.push({ code: m[1], color: m[2].trim(), sqftBox: +m[3], cost: +m[4] });
}
const listByCode = new Map(rows.map(r => [r.code, r]));

const { rows: dbSkus } = await pool.query(`
  SELECT s.id, s.vendor_sku, s.status, p.id AS product_id, p.name, p.collection,
         pr.cost, pr.retail_price, pk.sqft_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id AND v.code = 'MGC'
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  ORDER BY s.vendor_sku
`);

const updates = [];       // matched base skus with price/packaging change
const discontinued = [];  // MC* base skus absent from list (+ molding siblings)
const baseByCode = new Map();
for (const s of dbSkus) {
  if (!MOLDING_SUFFIX.test(s.vendor_sku)) baseByCode.set(s.vendor_sku, s);
}

for (const [code, s] of baseByCode) {
  if (!/^MC[A-Z]*-\d+$/.test(code)) continue;          // MSR-* etc: not this list
  const item = listByCode.get(code);
  if (!item) {
    if (s.status === 'active' || s.status === 'draft') {
      discontinued.push(s);
      for (const m of dbSkus) {
        if (m.vendor_sku.startsWith(code + '-') && MOLDING_SUFFIX.test(m.vendor_sku)
            && (m.status === 'active' || m.status === 'draft')) discontinued.push(m);
      }
    }
    continue;
  }
  const retail = keystone(item.cost);
  if (+s.cost !== item.cost || +s.retail_price !== retail || +(s.sqft_per_box || 0) !== item.sqftBox) {
    updates.push({ ...s, newCost: item.cost, newRetail: retail, newSqft: item.sqftBox });
  }
}

const newOnList = rows.filter(r => !baseByCode.has(r.code));

console.log(`List rows parsed: ${rows.length}`);
console.log(`\nPrice/packaging updates: ${updates.length}`);
for (const u of updates) console.log(`  ${u.vendor_sku.padEnd(12)} cost ${String(u.cost).padStart(6)} -> ${String(u.newCost).padStart(6)}  retail ${String(u.retail_price).padStart(7)} -> ${String(u.newRetail).padStart(7)}  sqft/bx ${u.sqft_per_box} -> ${u.newSqft}`);
console.log(`\nDiscontinued (absent from list, incl. molding siblings): ${discontinued.length}`);
console.log('  ' + discontinued.map(d => d.vendor_sku).join(', '));
console.log(`\nNew on list, not in DB (NOT added — separate onboarding): ${newOnList.length}`);
console.log('  ' + newOnList.map(r => `${r.code} ${r.color} $${r.cost}`).join('\n  '));

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const u of updates) {
    await client.query(`
      INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,'per_sqft')
      ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price`,
      [u.id, u.newCost, u.newRetail]);
    await client.query(`
      INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
      ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box`,
      [u.id, u.newSqft]);
  }
  for (const d of discontinued) {
    await client.query(`UPDATE skus SET status='inactive', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [d.id]);
  }
  const { rows: emptied } = await client.query(`
    UPDATE products p SET status='inactive', updated_at=CURRENT_TIMESTAMP
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE code='MGC') AND p.status='active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id AND s.status='active')
    RETURNING p.name`);
  await client.query('COMMIT');
  console.log(`\nAPPLIED. Products fully deactivated: ${emptied.length} (${emptied.map(r => r.name).join(', ')})`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
await pool.end();
