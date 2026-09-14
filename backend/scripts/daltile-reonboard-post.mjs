/**
 * daltile-reonboard-post.mjs
 *
 * Post-processing for a daltile-unified clean-slate re-onboard:
 *   1. Price carry-over — SKUs the EDI matcher missed inherit their verified
 *      price (cost/retail/sell_by) from the pre-wipe backup JSON that
 *      daltile-unified wrote, matched by exact vendor_sku. These are prices the
 *      old catalog earned through the 2026-09 crosswalk-verify work; the
 *      6-hourly daltile-edi-overlay keeps them fresh afterwards.
 *   2. Activation — SKU goes active iff priced (>0) AND imaged; product goes
 *      active iff it has ≥1 active SKU. Everything else stays draft.
 *   3. Husk cleanup — deletes 0-SKU products (cross-brand SKU collisions used
 *      to leave these; harmless to delete, they were created this run).
 *
 * Usage:
 *   node backend/scripts/daltile-reonboard-post.mjs            # dry run
 *   node backend/scripts/daltile-reonboard-post.mjs --commit
 *   node backend/scripts/daltile-reonboard-post.mjs --commit --backup=path/to/backup.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const backupArg = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1];

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const { rows: vrows } = await pool.query(`SELECT id FROM vendors WHERE code='DAL'`);
if (!vrows.length) { console.error('DAL vendor not found'); process.exit(1); }
const DAL = vrows[0].id;

// ── Locate the newest re-onboard backup ─────────────────────────────────────
let backupPath = backupArg;
if (!backupPath) {
  const dataDir = path.join(__dirname, '..', 'data');
  const candidates = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('daltile-reonboard-backup-') && f.endsWith('.json'))
    .sort();
  if (!candidates.length) { console.error('No daltile-reonboard-backup-*.json found'); process.exit(1); }
  backupPath = path.join(dataDir, candidates[candidates.length - 1]);
}
console.log(`Backup: ${backupPath}`);
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

// vendor_sku → best old row (prefer active > inactive > draft rows)
const rank = { active: 0, inactive: 1, draft: 2 };
const oldPrice = new Map();   // priced rows: cost/retail/basis/sell_by
const oldSelling = new Map(); // any row with packaging or a sell_by (packaging carry)
for (const s of backup.skus || []) {
  const vs = (s.vendor_sku || '').toUpperCase();
  if (!vs) continue;
  const better = (map) => { const prev = map.get(vs); return !prev || (rank[s.status] ?? 3) < (rank[prev.status] ?? 3); };
  const rp = parseFloat(s.retail_price || 0);
  if (rp > 0 && better(oldPrice)) {
    oldPrice.set(vs, { cost: parseFloat(s.cost || 0), retail: rp, sell_by: s.sell_by || null, price_basis: s.price_basis || null, status: s.status });
  }
  if ((s.sqft_per_box || s.pieces_per_box || s.weight_per_box_lbs || s.sell_by) && better(oldSelling)) {
    oldSelling.set(vs, {
      sell_by: s.sell_by || null,
      sqft_per_box: s.sqft_per_box || null, pieces_per_box: s.pieces_per_box || null,
      weight_per_box_lbs: s.weight_per_box_lbs || null, boxes_per_pallet: s.boxes_per_pallet || null,
      sqft_per_pallet: s.sqft_per_pallet || null, status: s.status,
    });
  }
}
console.log(`Old priced vendor_skus in backup: ${oldPrice.size}; with packaging/selling: ${oldSelling.size}`);

// ── 1. Price carry-over ──────────────────────────────────────────────────────
const { rows: unpriced } = await pool.query(`
  SELECT s.id, upper(s.vendor_sku) AS vs, s.sell_by
  FROM skus s JOIN products p ON p.id = s.product_id
  WHERE p.vendor_id = $1
    AND NOT EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id AND pr.retail_price > 0)`, [DAL]);
const carries = unpriced.filter(r => oldPrice.has(r.vs));
console.log(`Unpriced SKUs: ${unpriced.length}, carry-over matches: ${carries.length}`);

if (COMMIT) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of carries) {
      const o = oldPrice.get(r.vs);
      await client.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis`,
        [r.id, o.cost, o.retail, o.price_basis || (o.sell_by === 'unit' ? 'per_unit' : 'per_sqft')]);
      if (o.sell_by && o.sell_by !== r.sell_by) {
        await client.query(`UPDATE skus SET sell_by = $1, updated_at = now() WHERE id = $2`, [o.sell_by, r.id]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  console.log(`Carried ${carries.length} prices.`);

  // ── 1b. Packaging carry-over + per-sheet selling restore ──
  // EDI packaging only reaches ~25% of SKUs; the rest inherited box coverage
  // from the old catalog. Also restore the crosswalk-era per-sheet selling for
  // mosaics/stacked-stone (sell_by=unit + per-unit price) that EDI's per-SF
  // quote would otherwise regress.
  const { rows: allSkus } = await pool.query(`
    SELECT s.id, upper(s.vendor_sku) AS vs, s.sell_by, c.slug AS cat,
      (pk.sku_id IS NOT NULL) AS has_pkg, pr.price_basis
    FROM skus s JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1`, [DAL]);
  let pkgCarried = 0, sheetRestored = 0;
  const SHEET_CATS = new Set(['mosaic-tile', 'stacked-stone', 'backsplash-wall']);
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    for (const r of allSkus) {
      const o = oldSelling.get(r.vs);
      if (!o) continue;
      if (!r.has_pkg && (o.sqft_per_box || o.pieces_per_box || o.weight_per_box_lbs)) {
        await client2.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sku_id) DO NOTHING`,
          [r.id, o.sqft_per_box, o.pieces_per_box, o.weight_per_box_lbs, o.boxes_per_pallet, o.sqft_per_pallet]);
        pkgCarried++;
      }
      if (SHEET_CATS.has(r.cat) && o.sell_by === 'unit' && r.sell_by === 'box') {
        await client2.query(`UPDATE skus SET sell_by = 'unit', updated_at = now() WHERE id = $1`, [r.id]);
        const op = oldPrice.get(r.vs);
        if (op && op.price_basis === 'per_unit') {
          await client2.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1, $2, $3, 'per_unit')
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price, price_basis = 'per_unit'`,
            [r.id, op.cost, op.retail]);
        }
        sheetRestored++;
      }
    }
    await client2.query('COMMIT');
  } catch (e) { await client2.query('ROLLBACK'); throw e; }
  finally { client2.release(); }
  console.log(`Carried ${pkgCarried} packaging rows; restored per-sheet selling on ${sheetRestored} SKUs.`);
}

// ── 2. Activation ────────────────────────────────────────────────────────────
if (COMMIT) {
  const r1 = await pool.query(`
    UPDATE skus s SET status = 'active', updated_at = now()
    FROM products p WHERE p.id = s.product_id AND p.vendor_id = $1 AND s.status <> 'active'
      AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id AND pr.retail_price > 0)
      AND EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id)`, [DAL]);
  const r2 = await pool.query(`
    UPDATE skus s SET status = 'draft', updated_at = now()
    FROM products p WHERE p.id = s.product_id AND p.vendor_id = $1 AND s.status = 'active'
      AND NOT (EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id AND pr.retail_price > 0)
        AND EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id))`, [DAL]);
  // Slabs/countertops sell quote-only — the storefront renders "Call for Price"
  // when no pricing row exists. The pre-re-onboard catalog listed these active
  // without prices; mirror that so the slab galleries don't go dark.
  const rSlab = await pool.query(`
    UPDATE skus s SET status = 'active', updated_at = now()
    FROM products p, categories c
    WHERE p.id = s.product_id AND c.id = p.category_id AND p.vendor_id = $1 AND s.status <> 'active'
      AND c.slug IN ('quartz-countertops','granite-countertops','quartzite-countertops',
                     'marble-countertops','soapstone-countertops','porcelain-slabs')
      AND EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id)`, [DAL]);
  console.log(`Activated ${rSlab.rowCount} quote-only slab/countertop SKUs.`);
  const r3 = await pool.query(`
    UPDATE products p SET status = 'active', updated_at = now()
    WHERE p.vendor_id = $1 AND p.status <> 'active'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')`, [DAL]);
  const r4 = await pool.query(`
    UPDATE products p SET status = 'draft', updated_at = now()
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')`, [DAL]);
  console.log(`Activated ${r1.rowCount} SKUs (drafted ${r2.rowCount}); activated ${r3.rowCount} products (drafted ${r4.rowCount}).`);

  // ── 3. Husk cleanup ──
  const r5 = await pool.query(`
    DELETE FROM products p WHERE p.vendor_id = $1
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)`, [DAL]);
  console.log(`Deleted ${r5.rowCount} 0-SKU husk products.`);

  // ── 4. Slug aliases — 301 retired slugs (doubled-slug bug, brand-prefixed
  // formats) to the live product. Scans EVERY re-onboard backup so slugs from
  // earlier catalog generations stay covered. Match by normalized name.
  const nameKey = (n) => (n || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const dataDir = path.join(__dirname, '..', 'data');
  const oldPairs = new Map(); // old_slug → nameKey
  for (const f of fs.readdirSync(dataDir).filter(f => f.startsWith('daltile-reonboard-backup-') && f.endsWith('.json'))) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf-8'));
      for (const p of b.products || []) {
        if (p.slug && p.name && p.status === 'active') oldPairs.set(p.slug, nameKey(p.name));
      }
    } catch { /* unreadable backup — skip */ }
  }
  const { rows: live } = await pool.query(
    `SELECT id, slug, lower(regexp_replace(name, '\\s+', ' ', 'g')) AS nk
     FROM products WHERE vendor_id = $1 AND status = 'active'`, [DAL]);
  const liveSlugs = new Set(live.map(r => r.slug).filter(Boolean));
  const liveByName = new Map(live.map(r => [r.nk, r.id]));
  let aliased = 0;
  for (const [oldSlug, nk] of oldPairs) {
    if (liveSlugs.has(oldSlug)) continue;           // slug still live — no alias needed
    const pid = liveByName.get(nk);
    if (!pid) continue;                             // product genuinely gone
    await pool.query(`
      INSERT INTO slug_aliases (old_slug, product_id) VALUES ($1, $2)
      ON CONFLICT (old_slug) DO UPDATE SET product_id = EXCLUDED.product_id`,
      [oldSlug, pid]);
    aliased++;
  }
  console.log(`Slug aliases upserted: ${aliased} (from ${oldPairs.size} historical active slugs).`);

  // Refresh search vectors for active products
  const { rows: act } = await pool.query(`SELECT id FROM products WHERE vendor_id = $1 AND status = 'active'`, [DAL]);
  for (const p of act) await pool.query('SELECT refresh_search_vectors($1)', [p.id]).catch(() => {});
  console.log(`Refreshed search vectors (${act.length}).`);
}

// ── Stats ────────────────────────────────────────────────────────────────────
const { rows: stats } = await pool.query(`
  SELECT p.status, count(DISTINCT p.id) AS products,
         count(s.id) FILTER (WHERE s.status = 'active') AS active_skus
  FROM products p LEFT JOIN skus s ON s.product_id = p.id
  WHERE p.vendor_id = $1 GROUP BY p.status ORDER BY p.status`, [DAL]);
console.table(stats);
if (!COMMIT) console.log('Dry run — re-run with --commit.');
await pool.end();
