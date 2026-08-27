/**
 * Siena Decor — Q4-2025 catalog re-onboard
 *
 * Source of truth: backend/data/siena/catalog-q4-2025.json (via backend/lib/sienaCatalog.mjs),
 * transcribed from "Siena Decor Q-4-2025.pdf" (Rev 8/28/2025 wholesale price list).
 *
 * The 2024 PDF the scraper was built from is ~2 years stale: colors renamed/replaced and
 * most collections moved to larger formats. This rebuilds Siena to the current list and
 * DEACTIVATES SKUs/products that no longer exist (status='inactive', NOT deleted — order
 * history stays intact).
 *
 * Usage:
 *   node backend/import-siena-q4-2025.mjs            # dry run (no writes) — prints the diff
 *   node backend/import-siena-q4-2025.mjs --commit   # apply
 *
 * List price = our cost; retail = cost*MARKUP, then base.js applies nine-ending + floors.
 */
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute,
} from './scrapers/base.js';
import {
  loadSienaCatalog, keepInternalSkus, buildInternalSku, accessoryLabel, isMosaic,
} from './lib/sienaCatalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const MARKUP = 2.0;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

function buildPlan(PRICE_LIST) {
  const fields = [], accessories = [];
  for (const [collectionName, coll] of Object.entries(PRICE_LIST)) {
    const { material, origin, usage, desc } = coll;
    const allColors = new Set();
    for (const it of coll.items) if (!it.type && it.colors) for (const c of it.colors) allColors.add(c);

    for (const item of coll.items) {
      if (item.type || !item.colors || !item.colors.length) continue;
      for (const color of item.colors) {
        const productName = (allColors.size === 1 && !color.includes('Mix') && !color.includes('Deco'))
          ? collectionName : `${collectionName} ${color}`;
        const finish = item.finish || null;
        const cost = item.price, retail = parseFloat((cost * MARKUP).toFixed(2));
        fields.push({
          collectionName, productName, material, origin, desc, color, size: item.size, finish,
          internalSku: buildInternalSku(collectionName, color, item.size, finish),
          variant: finish ? `${item.size}, ${finish}` : item.size,
          variantType: usage.includes('wall') ? 'wall_tile' : 'floor_tile',
          sellBy: item.unit === 'sf' ? 'box' : 'unit',
          priceBasis: item.unit === 'sf' ? 'per_sqft' : 'per_unit',
          cost, retail, sf: item.sf, pcs: item.pcs, lbs: item.lbs, bxPl: item.bxPl,
        });
      }
    }
    for (const item of coll.items) {
      if (!item.type) continue;
      const label = accessoryLabel(item.type);
      const cost = item.price, retail = parseFloat((cost * MARKUP).toFixed(2));
      accessories.push({
        collectionName, productName: `${collectionName} ${label}`, material, origin, desc, label,
        size: item.size, internalSku: buildInternalSku(collectionName, label, item.size, null),
        variantType: isMosaic(item.type) ? 'mosaic' : 'accessory',
        sellBy: item.unit === 'sf' ? 'box' : 'unit',
        priceBasis: item.unit === 'sf' ? 'per_sqft' : 'per_unit',
        cost, retail, sf: item.sf, pcs: item.pcs, lbs: item.lbs,
      });
    }
  }
  return { fields, accessories };
}

async function main() {
  console.log(`=== Siena Q4-2025 re-onboard — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===\n`);

  const v = await pool.query("SELECT id FROM vendors WHERE code='SIEN'");
  if (!v.rows.length) throw new Error('Siena vendor (SIEN) not found');
  const vendorId = v.rows[0].id;

  const cats = {};
  for (const slug of ['porcelain-tile', 'ceramic-tile', 'mosaic-tile']) {
    const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
    if (r.rows.length) cats[slug] = r.rows[0].id;
  }
  const catFor = (material, vt) => vt === 'mosaic' ? (cats['mosaic-tile'] || cats['porcelain-tile'])
    : material === 'ceramic' ? cats['ceramic-tile'] : cats['porcelain-tile'];

  const PRICE_LIST = await loadSienaCatalog(pool, vendorId);
  const plan = buildPlan(PRICE_LIST);
  const keep = keepInternalSkus(PRICE_LIST);
  const all = [...plan.fields, ...plan.accessories];
  console.log(`Catalog: ${Object.keys(PRICE_LIST).length} collections`);
  console.log(`Desired: ${plan.fields.length} field + ${plan.accessories.length} accessory rows = ${keep.size} internal SKUs\n`);

  const cur = await pool.query(`
    SELECT s.id, s.internal_sku, s.status, p.name AS product
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id=$1`, [vendorId]);
  const curISkus = new Set(cur.rows.map(r => r.internal_sku));
  const toCreate = all.filter(x => !curISkus.has(x.internalSku));
  const toDeactivate = cur.rows.filter(r => r.status === 'active' && !keep.has(r.internal_sku));

  console.log(`Current Siena SKUs: ${cur.rows.length} (${cur.rows.filter(r => r.status === 'active').length} active)`);
  console.log(`  CREATE: ${toCreate.length}   UPDATE: ${all.length - toCreate.length}   DEACTIVATE: ${toDeactivate.length}\n`);
  console.log('Sample CREATE:'); toCreate.slice(0, 12).forEach(x => console.log(`  + ${x.productName} [${x.variant || x.size}] $${x.cost}`));
  console.log('Sample DEACTIVATE:'); toDeactivate.slice(0, 12).forEach(r => console.log(`  - ${r.product} (${r.internal_sku})`));

  if (!COMMIT) {
    fs.writeFileSync(path.join(__dirname, 'data/siena/reonboard-plan.json'), JSON.stringify({
      counts: { create: toCreate.length, update: all.length - toCreate.length, deactivate: toDeactivate.length },
      create: toCreate.map(x => ({ product: x.productName, variant: x.variant || x.size, cost: x.cost })),
      deactivate: toDeactivate.map(r => ({ product: r.product, internal_sku: r.internal_sku })),
    }, null, 2));
    console.log('\nDry run — no writes. Plan → backend/data/siena/reonboard-plan.json. Re-run with --commit.');
    await pool.end();
    return;
  }

  let created = 0, updated = 0;
  for (const x of plan.fields) {
    const { id: productId } = await upsertProduct(pool, {
      vendor_id: vendorId, name: x.productName, collection: x.collectionName,
      category_id: catFor(x.material, x.variantType),
      description_short: `${x.desc}. Origin: ${x.origin}.`,
    });
    const { id: skuId, is_new } = await upsertSku(pool, {
      product_id: productId, vendor_sku: '', internal_sku: x.internalSku,
      variant_name: x.variant, sell_by: x.sellBy, variant_type: x.variantType,
    });
    is_new ? created++ : updated++;
    await upsertPricing(pool, skuId, { cost: x.cost, retail_price: x.retail, price_basis: x.priceBasis });
    if (x.sf) await upsertPackaging(pool, skuId, { sqft_per_box: x.sf, pieces_per_box: x.pcs, weight_per_box_lbs: x.lbs, boxes_per_pallet: x.bxPl || null });
    await upsertSkuAttribute(pool, skuId, 'size', x.size);
    await upsertSkuAttribute(pool, skuId, 'color', x.color);
    if (x.finish) await upsertSkuAttribute(pool, skuId, 'finish', x.finish);
    await upsertSkuAttribute(pool, skuId, 'material', x.material);
    if (x.origin) await upsertSkuAttribute(pool, skuId, 'origin', x.origin);
  }
  for (const x of plan.accessories) {
    const { id: productId } = await upsertProduct(pool, {
      vendor_id: vendorId, name: x.productName, collection: x.collectionName,
      category_id: catFor(x.material, x.variantType),
      description_short: `${x.label} for the ${x.collectionName} collection.`,
    });
    const { id: skuId, is_new } = await upsertSku(pool, {
      product_id: productId, vendor_sku: '', internal_sku: x.internalSku,
      variant_name: x.size, sell_by: x.sellBy, variant_type: x.variantType,
    });
    is_new ? created++ : updated++;
    await upsertPricing(pool, skuId, { cost: x.cost, retail_price: x.retail, price_basis: x.priceBasis });
    if (x.sf) await upsertPackaging(pool, skuId, { sqft_per_box: x.sf, pieces_per_box: x.pcs, weight_per_box_lbs: x.lbs });
    else if (x.pcs) await upsertPackaging(pool, skuId, { pieces_per_box: x.pcs });
    await upsertSkuAttribute(pool, skuId, 'size', x.size);
    await upsertSkuAttribute(pool, skuId, 'material', x.material);
  }
  console.log(`Upserted: ${created} created, ${updated} updated`);

  await pool.query(`
    UPDATE skus SET status='active'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id=$1) AND status='draft'
      AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id=skus.id AND pr.retail_price>0)`, [vendorId]);

  const deact = await pool.query(`
    UPDATE skus SET status='inactive'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id=$1) AND status='active'
      AND internal_sku <> ALL($2::text[]) RETURNING id`, [vendorId, [...keep]]);
  console.log(`Deactivated ${deact.rowCount} discontinued SKUs`);

  await pool.query(`
    UPDATE products SET status='active'
    WHERE vendor_id=$1 AND status='draft'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id=products.id AND s.status='active')`, [vendorId]);
  const prodDeact = await pool.query(`
    UPDATE products SET status='inactive'
    WHERE vendor_id=$1 AND status='active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=products.id AND s.status='active') RETURNING id`, [vendorId]);
  console.log(`Deactivated ${prodDeact.rowCount} products with no active SKUs`);

  const prods = await pool.query('SELECT id FROM products WHERE vendor_id=$1', [vendorId]);
  for (const r of prods.rows) await pool.query('SELECT refresh_search_vectors($1)', [r.id]);
  console.log(`Refreshed search vectors for ${prods.rowCount} products\n=== Re-onboard complete ===`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
