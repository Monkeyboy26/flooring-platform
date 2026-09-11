/**
 * Onboard Akua Mosaics as a BRAND under the Western Pacific Tile vendor.
 *
 * Akua is "Akua Mosaics by WPT" — a mosaic line sold on WPT's wholesale price
 * list (A.AKUA XL Z1&Z2, July 2026). Catalog is built in backend/data/akua-catalog.json
 * by merging:
 *   - the price-list PDF  → SKU (CAY-/AUK- prefixes), wholesale price, sheet size, SF/sheet, pcs/box, lbs/box
 *   - akuamosaics.com js/data.js → swatch (label) + room (lifestyle) images, series descriptor
 *
 * Every Akua product is a mosaic sold BY THE SHEET: sell_by=unit, price_basis=per_unit,
 * cost = wholesale sheet price, retail = cost×1.6 rounded down to end in .X9 (WPT keystone).
 * Category = Mosaic Tile. brand = "Akua Mosaics" (under vendor WPT/807).
 *
 * Idempotent (upserts on internal_sku / vendor+collection+name). Dry-run default;
 * --apply commits. 274 products (166 with images, 108 photoless — series not on site).
 *   node backend/scripts/import-akua.mjs [--apply] [--limit N]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute, upsertMediaAsset } from '../scrapers/base.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : null; })();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOSAIC_CATEGORY = '650e8400-e29b-41d4-a716-446655440014';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const normSize = (s) => (s || '').replace(/\s+/g, '').replace(/X/g, 'x');

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  let catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'akua-catalog.json'), 'utf8'));
  if (LIMIT) catalog = catalog.slice(0, LIMIT);

  const withImg = catalog.filter(c => c.primary_img).length;
  console.log(`\nAkua Mosaics onboarding — ${catalog.length} products (${withImg} with images, ${catalog.length - withImg} photoless)`);
  console.log(`  vendor: WPT (${vendor.id})  ·  category: Mosaic Tile  ·  brand: Akua Mosaics\n`);
  for (const c of catalog.slice(0, 6)) {
    console.log(`  ${c.sku}  ${c.name}  [${c.collection}] $${c.cost}→$${c.retail} ${c.size} sf/sht ${c.sqft_per_sheet}${c.primary_img ? '' : '  (photoless)'}`);
  }
  console.log(`  … ${catalog.length - 6} more`);

  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  // Ensure the Akua Mosaics brand.
  let brand = (await pool.query(`SELECT id FROM brands WHERE code='AKUA' OR LOWER(name)='akua mosaics' LIMIT 1`)).rows[0];
  if (!brand) {
    brand = (await pool.query(
      `INSERT INTO brands (name, code, website, description, is_active)
       VALUES ('Akua Mosaics','AKUA','https://akuamosaics.com','Curated mosaic collections — recycled glass, natural stone, marble & ceramic, distributed by Western Pacific Tile.', true)
       RETURNING id`)).rows[0];
    console.log(`Created brand Akua Mosaics (${brand.id})`);
  }

  let created = 0, updated = 0, skusN = 0, imgs = 0;
  for (const c of catalog) {
    const prod = await upsertProduct(pool, {
      vendor_id: vendor.id, name: c.name, collection: c.collection,
      category_id: MOSAIC_CATEGORY, brand_id: brand.id,
      description_short: c.material ? `${c.material} mosaic — sold by the sheet.` : null,
    });
    if (prod.is_new) created++; else updated++;
    // Onboarded products are sellable → active (upsertProduct inserts 'draft').
    await pool.query(`UPDATE products SET status='active', category_source='manual' WHERE id=$1`, [prod.id]);

    const sku = await upsertSku(pool, {
      product_id: prod.id, vendor_sku: c.sku, internal_sku: c.sku,
      variant_name: normSize(c.size), sell_by: 'unit', variant_type: 'mosaic',
    });
    skusN++;

    await upsertPricing(pool, sku.id, {
      cost: c.cost, retail_price: c.retail, price_basis: 'per_unit',
    }, { coveringFloor: true });

    await upsertPackaging(pool, sku.id, {
      sqft_per_box: c.sqft_per_sheet, pieces_per_box: c.pcs_per_box, weight_per_box_lbs: c.lbs_per_box,
    });

    if (c.size) await upsertSkuAttribute(pool, sku.id, 'size', normSize(c.size));
    if (c.material) await upsertSkuAttribute(pool, sku.id, 'material', c.material);
    if (c.color) await upsertSkuAttribute(pool, sku.id, 'color', c.color);

    if (c.primary_img) {
      await upsertMediaAsset(pool, { product_id: prod.id, sku_id: sku.id, asset_type: 'primary', url: c.primary_img, original_url: c.primary_img, sort_order: 0 });
      imgs++;
      if (c.room_img) await upsertMediaAsset(pool, { product_id: prod.id, sku_id: sku.id, asset_type: 'lifestyle', url: c.room_img, original_url: c.room_img, sort_order: 1 });
    }
  }
  console.log(`\n✓ Akua: ${created} products created, ${updated} updated · ${skusN} SKUs · ${imgs} with primary image.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
