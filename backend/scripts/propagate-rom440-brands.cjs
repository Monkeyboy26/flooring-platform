#!/usr/bin/env node

/**
 * ROM440 — Collection-level brand propagation
 *
 * Hardware Resources collections belong to exactly one brand, so any
 * collection where backfill-rom440-brands.cjs has already scraped ≥1
 * product tells us the brand of every other product in that collection.
 *
 * Collection sources (products.collection is empty for ~4,900 ROM440
 * products): the vendor price-list CSVs in /app/data/ROM440 map every
 * vendor_sku to (Master Class, Collection). We key on class|collection
 * to avoid cross-class name collisions.
 *
 * For each unprocessed product whose collection maps to a unanimous
 * scraped brand, we set products.brand_id and record the product in
 * brand-backfill-state.json so the scraper skips it on its next run.
 * Collections with conflicting scraped brands are left to the scraper.
 *
 * Usage:
 *   docker compose exec -T api node scripts/propagate-rom440-brands.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = process.env.ROM440_DIR || '/app/data/ROM440';
const STATE_FILE = path.join(DATA_DIR, 'brand-backfill-state.json');
const HR_VENDOR_ID = 'c94f3624-6796-4b3b-b5d7-0f5e544955a5';

const CSVS = [
  { file: 'price_list_ROM440_decorative_hardware.csv', masterClass: 'Decorative Hardware' },
  { file: 'price_list_ROM440_bath_hardware.csv',       masterClass: 'Bath Hardware' },
  { file: 'price_list_ROM440_functional_hardware.csv', masterClass: 'Functional Hardware' },
  { file: 'price_list_ROM440_carved_wood.csv',         masterClass: 'Carved Wood' },
  { file: 'price_list_ROM440_moulding.csv',            masterClass: 'Moulding' },
  { file: 'price_list_ROM440_light_power.csv',         masterClass: 'Light & Power' },
  { file: 'price_list_ROM440_organizers.csv',          masterClass: 'Organizers' },
  { file: 'price_list_ROM440_sinks.csv',               masterClass: 'Sinks' },
  { file: 'price_list_ROM440_vanity.csv',              masterClass: 'Vanity' },
];

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Char-level CSV parse — descriptions contain quoted commas/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function collKey(masterClass, collection) {
  return masterClass + '|' + String(collection || '').trim().toUpperCase();
}

async function main() {
  console.log('ROM440 collection-level brand propagation' + (DRY_RUN ? ' (DRY RUN)' : ''));

  // 1. vendor_sku → class|collection from the price CSVs
  const skuToColl = new Map();
  for (const { file, masterClass } of CSVS) {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) { console.warn(`  [skip] missing ${file}`); continue; }
    const rows = parseCsv(fs.readFileSync(p, 'utf8'));
    const header = rows[0].map(h => h.trim().toLowerCase());
    const iSku = header.indexOf('product');
    const iColl = header.indexOf('collection');
    for (const r of rows.slice(1)) {
      const sku = (r[iSku] || '').trim().toUpperCase();
      const coll = (r[iColl] || '').trim();
      if (sku && coll) skuToColl.set(sku, collKey(masterClass, coll));
    }
  }
  console.log(`CSV sku→collection entries: ${skuToColl.size}`);

  // 2. Load state + products
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const { rows: prods } = await pool.query(`
    SELECT p.id, p.collection AS db_collection, c.name AS category,
           array_agg(s.vendor_sku) AS vendor_skus
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.collection, c.name
  `, [HR_VENDOR_ID]);

  // Effective collection per product: DB value first, else CSV lookup by sku
  const prodColl = new Map();
  for (const p of prods) {
    let key = null;
    if (p.db_collection && p.db_collection.trim()) {
      key = collKey(p.category || '', p.db_collection);
    } else {
      for (const vs of p.vendor_skus) {
        const k = skuToColl.get(String(vs).toUpperCase());
        if (k) { key = k; break; }
      }
    }
    if (key) prodColl.set(p.id, key);
  }
  console.log(`Products with a resolvable collection: ${prodColl.size}/${prods.length}`);

  // 3. collection → brands seen among scraped 'ok' results
  const collBrands = new Map();
  for (const [pid, entry] of Object.entries(state.products)) {
    if (entry.status !== 'ok' || !entry.brand || entry.via) continue; // scraped only
    const key = prodColl.get(pid);
    if (!key) continue;
    if (!collBrands.has(key)) collBrands.set(key, new Map());
    const m = collBrands.get(key);
    m.set(entry.brand, (m.get(entry.brand) || 0) + 1);
  }
  const unanimous = new Map();
  let conflicted = 0;
  for (const [key, m] of collBrands) {
    if (m.size === 1) unanimous.set(key, [...m.keys()][0]);
    else { conflicted++; console.warn(`  [conflict] ${key}: ${JSON.stringify([...m.entries()])}`); }
  }
  console.log(`Collections with known brand: ${unanimous.size} (conflicted, left to scraper: ${conflicted})`);

  // 4. Assign unprocessed products in known collections
  const brandIds = new Map();
  async function brandId(name) {
    if (brandIds.has(name)) return brandIds.get(name);
    const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const r = await pool.query(
      'INSERT INTO brands (name, code) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [name, code]
    );
    await pool.query(
      'INSERT INTO vendor_brands (vendor_id, brand_id, is_primary) VALUES ($1, $2, false) ON CONFLICT DO NOTHING',
      [HR_VENDOR_ID, r.rows[0].id]
    );
    brandIds.set(name, r.rows[0].id);
    return r.rows[0].id;
  }

  const counts = {};
  let assigned = 0, skippedDone = 0, noColl = 0, unknownColl = 0;
  for (const p of prods) {
    if (state.products[p.id]) { skippedDone++; continue; }
    const key = prodColl.get(p.id);
    if (!key) { noColl++; continue; }
    const brand = unanimous.get(key);
    if (!brand) { unknownColl++; continue; }
    counts[brand] = (counts[brand] || 0) + 1;
    assigned++;
    if (!DRY_RUN) {
      const bid = await brandId(brand);
      await pool.query('UPDATE products SET brand_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [bid, p.id]);
      state.products[p.id] = { status: 'ok', brand, via: 'collection-propagation' };
    }
  }
  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state));

  console.log('\n==================== Summary ====================');
  console.log(`Already processed (state):   ${skippedDone}`);
  console.log(`Propagated${DRY_RUN ? ' (dry run)' : ''}:        ${assigned}`);
  console.log(`No resolvable collection:    ${noColl}  (scraper will handle)`);
  console.log(`Collection brand unknown:    ${unknownColl}  (scraper will handle)`);
  console.log('Propagated brand counts:');
  for (const [b, n] of Object.entries(counts).sort((a, z) => z[1] - a[1])) console.log(`  ${b}: ${n}`);
  await pool.end();
}

main().catch(async (e) => { console.error('FATAL:', e); try { await pool.end(); } catch {} process.exit(1); });
