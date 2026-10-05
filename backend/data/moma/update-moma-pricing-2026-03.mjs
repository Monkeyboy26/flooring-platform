/**
 * Moma Ceramiche — apply MARCH 2026 (v45) net-price list to live pricing.
 *
 * The live Moma vendor is code 896 (SKUs prefixed MOMA-); import-moma.js targets a
 * stale code "MOMA" and recomputes retail at 1.60x, so it is NOT the right tool —
 * live retail has since been repriced to the house 1.70x + category-floor model.
 * This script updates COST ONLY for the size/finish rows whose net price changed,
 * then calls base.js upsertPricing so retail is recomputed exactly like every other
 * vendor (keystone 1.70x → charm 9-ending → tile margin floor). All colour SKUs of a
 * (collection,size,finish) share one net price, so we match role-agnostically on
 * collection + nominal size + finish.
 *
 * Trims (local-sourced courtesy bullnose/mosaic) are NOT in the net list and unchanged.
 * New sizes/collections in the March list (Moonlight, Chalet 24x48/36x36, Marmi Lux
 * 8x48/12x48, PL 24x48 R11) are additive onboarding — deliberately OUT OF SCOPE here.
 *
 * Dry-run by default. Set APPLY=1 to write (backs up current pricing first).
 * Run inside the api container:  docker exec -e APPLY=1 flooring-api node backend/data/moma/update-moma-pricing-2026-03.mjs
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing } from '../../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.env.APPLY === '1';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: process.env.DB_PASSWORD || 'postgres',
});

const txt = fs.readFileSync(path.join(__dirname, 'pricelist-2026-03.txt'), 'utf8').split('\n');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json')));

const NAME2SLUG = {}, SLUG2NAME = {};
for (const c of catalog.collections) { NAME2SLUG[c.name.toUpperCase()] = c.slug; SLUG2NAME[c.slug] = c.name; }
const HEADERS = Object.keys(NAME2SLUG).sort((a, b) => b.length - a.length);
const FINMAP = { NAT:'Natural', N:'Natural', POL:'Polished', P:'Polished', R11:'R11', STR:'Structured', LIN:'Lineal',
  Natural:'Natural', Polished:'Polished', Structured:'Structured', Lineal:'Lineal' };
const nominal = (s) => { const [a, b] = s.split('x'); return `${a}"x${b}"`; };

function parseRow(line) {
  const m = line.match(/^\s*(2CM\s+PAVER|PAVER|FIELD|WALL)\s+(\d+x\d+)\s+(.*?)\$\s*([0-9]+)[,.]([0-9]{2})/);
  if (!m) return null;
  const [, roleRaw, size, mid, dol, cents] = m;
  const role = /PAVER/.test(roleRaw) ? 'paver' : roleRaw.toLowerCase();
  const w = mid.match(/\b(Natural|Polished|Structured|Lineal|R11)\b/);
  const paren = mid.match(/\((NAT|POL|R11|STR|LIN|N|P)\)/);
  const finish = w ? FINMAP[w[1]] : paren ? FINMAP[paren[1]] : 'Natural';
  return { role, size, finish, price: parseFloat(`${dol}.${cents}`) };
}

// parse PDF → price map keyed by slug|size|finish (first wins)
const pdf = new Map(); let curSlug = null;
for (const line of txt) {
  const trimmed = line.trim();
  for (const h of HEADERS) {
    if (line.search(/\S/) < 6 && trimmed.toUpperCase().startsWith(h)) {
      const after = trimmed.toUpperCase().slice(h.length, h.length + 1);
      if (after === '' || after === ' ' || after === '\t') { curSlug = NAME2SLUG[h]; break; }
    }
  }
  const r = parseRow(line);
  if (r && curSlug) { const k = `${curSlug}|${r.size}|${r.finish}`; if (!pdf.has(k)) pdf.set(k, r.price); }
}

// Enumerate every (collection,size,finish) the PDF prices, with the target net cost.
// DB-driven: we compare each LIVE sku's current cost to this target (NOT catalog.json,
// which may already be synced) so the run is idempotent — a no-op once applied.
const targets = [];
const seen = new Set();
for (const col of catalog.collections) for (const p of col.products) {
  const np = pdf.get(`${col.slug}|${p.size}|${p.finish}`);
  if (np == null) continue;
  const k = `${col.name}|${p.size}|${p.finish}`;
  if (seen.has(k)) continue; seen.add(k);
  targets.push({ name: col.name, size: p.size, finish: p.finish, newCost: np });
}

async function main() {
  console.log(`=== Moma March-2026 price update (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`${targets.length} (collection,size,finish) target rows from the PDF\n`);

  // backup current live Moma pricing
  const cur = await pool.query(`
    SELECT s.id sku_id, s.internal_sku, pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN pricing pr ON pr.sku_id=s.id WHERE v.code='896'`);
  if (APPLY) {
    const bk = path.join(__dirname, `pricing-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(bk, JSON.stringify(cur.rows, null, 2));
    console.log(`Backed up ${cur.rows.length} live pricing rows -> ${path.basename(bk)}\n`);
  }

  let skusTouched = 0, rowsWithChanges = 0;
  for (const t of targets) {
    const sz = nominal(t.size);
    const rows = await pool.query(`
      SELECT s.id, s.internal_sku, pr.cost, pr.price_basis
      FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      JOIN pricing pr ON pr.sku_id=s.id
      WHERE v.code='896' AND p.collection=$1
        AND EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=s.id AND a.slug='size' AND sa.value=$2)
        AND EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=s.id AND a.slug='finish' AND sa.value=$3)
      ORDER BY s.internal_sku`, [t.name, sz, t.finish]);
    const stale = rows.rows.filter(r => Math.abs(Number(r.cost) - t.newCost) > 0.001);
    if (!stale.length) continue; // already at target → skip (idempotent)
    rowsWithChanges++;
    const oldCost = stale[0].cost;
    console.log(`${t.name} ${t.size} ${t.finish}: cost ${oldCost} -> ${t.newCost}  (${stale.length}/${rows.rows.length} SKU need update)`);
    for (const r of stale) {
      if (APPLY) await upsertPricing(pool, r.id, { cost: t.newCost, retail_price: +(t.newCost * 2).toFixed(2), price_basis: r.price_basis });
      skusTouched++;
    }
  }
  if (!rowsWithChanges) console.log('All live Moma costs already match the March-2026 list — nothing to do.');
  console.log(`\n${APPLY ? 'Updated' : 'Would update'} ${skusTouched} SKUs across ${rowsWithChanges} rows.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
