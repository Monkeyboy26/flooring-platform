/**
 * Schluter Tile Edge Profiles — Static Data Seeder
 *
 * Seeds the 4 most popular Schluter tile edge profile lines:
 *   JOLLY (L-angle), QUADEC (square edge), RONDEC (bullnose), SCHIENE (floor edge)
 *
 * Vendor: Daltile (existing) — Schluter products come through Daltile's catalog.
 * Category: transitions-moldings (existing)
 *
 * Pattern: Same as lowes-mapei.js — static product data, base.js helpers, no web scraping.
 * Idempotent: Skips existing SKUs via ON CONFLICT on internal_sku.
 *
 * Usage: Run via admin UI or CLI after creating the vendor_source:
 *   INSERT INTO vendor_sources (vendor_id, scraper_key, name, source_type, base_url, config)
 *   SELECT id, 'schluter-profiles', 'Schluter Profiles', 'scraper', '', '{}'
 *   FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1;
 */

import {
  upsertProduct, upsertSku, upsertSkuAttribute, upsertPricing,
  saveProductImages, appendLog, addJobError,
} from './base.js';

const COLLECTION = 'Schluter';
const CATEGORY_SLUG = 'transitions-moldings';

// ─── Product line definitions ────────────────────────────────────────

const PROFILE_LINES = [
  {
    productName: 'Schluter JOLLY Tile Edge Trim',
    description_short: 'L-shaped wall tile edge trim. Provides a clean finish for tile edges on walls and countertops. 8 ft 2-1/2 in length.',
    skuPrefix: 'JOLLY',
    imageUrl: 'https://i8.amplience.net/i/flooranddecor/951500225_schluter-jolly-p-edge-trim-3-8in-pvc-bright-white_1?fmt=auto&qlt=85',
    skus: [
      // PVC
      { code: 'BW100', color: 'Bright White', size: '1/4"', material: 'PVC', price: 6.19 },
      { code: 'BW125', color: 'Bright White', size: '3/8"', material: 'PVC', price: 6.59 },
      { code: 'BW150', color: 'Bright White', size: '1/2"', material: 'PVC', price: 6.89 },
      { code: 'SP125', color: 'Sand Pebble', size: '3/8"', material: 'PVC', price: 6.59 },
      { code: 'LB125', color: 'Light Beige', size: '3/8"', material: 'PVC', price: 6.59 },
      { code: 'BK125', color: 'Black', size: '3/8"', material: 'PVC', price: 6.59 },
      // Aluminum
      { code: 'SA125', color: 'Satin Anodized', size: '3/8"', material: 'Aluminum', price: 15.05 },
      { code: 'SA150', color: 'Satin Anodized', size: '1/2"', material: 'Aluminum', price: 18.00 },
      { code: 'SN125', color: 'Satin Nickel', size: '3/8"', material: 'Aluminum', price: 18.89 },
      { code: 'SN150', color: 'Satin Nickel', size: '1/2"', material: 'Aluminum', price: 19.49 },
      { code: 'BN150', color: 'Brushed Nickel', size: '1/2"', material: 'Aluminum', price: 21.98 },
      { code: 'MB125', color: 'Matte Black', size: '3/8"', material: 'Aluminum', price: 24.54 },
      { code: 'MB150', color: 'Matte Black', size: '1/2"', material: 'Aluminum', price: 30.46 },
      { code: 'BWA125', color: 'Bright White', size: '3/8"', material: 'Aluminum', price: 19.43 },
    ],
  },
  {
    productName: 'Schluter QUADEC Square Edge Trim',
    description_short: 'Square-edge tile finishing profile for clean, modern edge transitions. 8 ft 2-1/2 in length.',
    skuPrefix: 'QUADEC',
    imageUrl: 'https://i8.amplience.net/i/flooranddecor/951500234_schluter-quadec-square-edge-trim-3-8in-aluminum-satin-nickel_1?fmt=auto&qlt=85',
    skus: [
      // PVC
      { code: 'BW125', color: 'Bright White', size: '3/8"', material: 'PVC', price: 8.00 },
      // Aluminum
      { code: 'SA100', color: 'Satin Anodized', size: '1/4"', material: 'Aluminum', price: 19.90 },
      { code: 'SA125', color: 'Satin Anodized', size: '3/8"', material: 'Aluminum', price: 18.83 },
      { code: 'SN125', color: 'Satin Nickel', size: '3/8"', material: 'Aluminum', price: 23.09 },
      { code: 'SN150', color: 'Satin Nickel', size: '1/2"', material: 'Aluminum', price: 25.69 },
      { code: 'BN125', color: 'Brushed Nickel', size: '3/8"', material: 'Aluminum', price: 29.59 },
      { code: 'PC125', color: 'Polished Chrome', size: '3/8"', material: 'Aluminum', price: 31.07 },
      { code: 'MB080', color: 'Matte Black', size: '5/16"', material: 'Aluminum', price: 34.09 },
      { code: 'MB125', color: 'Matte Black', size: '3/8"', material: 'Aluminum', price: 35.19 },
      { code: 'MB150', color: 'Matte Black', size: '1/2"', material: 'Aluminum', price: 35.99 },
    ],
  },
  {
    productName: 'Schluter RONDEC Bullnose Edge Trim',
    description_short: 'Rounded bullnose tile edge profile for a classic finished look on tile edges and outside corners. 8 ft 2-1/2 in length.',
    skuPrefix: 'RONDEC',
    imageUrl: 'https://i8.amplience.net/i/flooranddecor/951500193_schluter-rondec-bullnose-trim-3-8in-aluminum-satin-nickel_1?fmt=auto&qlt=85',
    skus: [
      // PVC
      { code: 'BW100', color: 'Bright White', size: '1/4"', material: 'PVC', price: 7.93 },
      { code: 'BW125', color: 'Bright White', size: '3/8"', material: 'PVC', price: 8.98 },
      { code: 'BK125', color: 'Black', size: '3/8"', material: 'PVC', price: 8.98 },
      // Aluminum
      { code: 'SA125', color: 'Satin Anodized', size: '3/8"', material: 'Aluminum', price: 20.18 },
      { code: 'SN125', color: 'Satin Nickel', size: '3/8"', material: 'Aluminum', price: 20.99 },
      { code: 'SN150', color: 'Satin Nickel', size: '1/2"', material: 'Aluminum', price: 23.79 },
      { code: 'BN125', color: 'Brushed Nickel', size: '3/8"', material: 'Aluminum', price: 30.58 },
      { code: 'AB125', color: 'Antique Bronze', size: '3/8"', material: 'Aluminum', price: 31.17 },
      { code: 'MB125', color: 'Matte Black', size: '3/8"', material: 'Aluminum', price: 30.00 },
      { code: 'PC125', color: 'Polished Chrome', size: '3/8"', material: 'Aluminum', price: 27.19 },
    ],
  },
  {
    productName: 'Schluter SCHIENE Floor Edge Trim',
    description_short: 'Floor-level tile edge protection profile. Protects exposed tile edges at transitions to lower surfaces. 8 ft 2-1/2 in length.',
    skuPrefix: 'SCHIENE',
    imageUrl: 'https://i8.amplience.net/i/flooranddecor/951200300_schluter-schiene-edge-trim-3-8in-aluminum_1?fmt=auto&qlt=85',
    skus: [
      // Plain Aluminum
      { code: 'AL100', color: 'Plain Aluminum', size: '1/4"', material: 'Aluminum', price: 10.29 },
      { code: 'AL125', color: 'Plain Aluminum', size: '3/8"', material: 'Aluminum', price: 10.79 },
      { code: 'AL150', color: 'Plain Aluminum', size: '1/2"', material: 'Aluminum', price: 11.39 },
      // Satin Anodized
      { code: 'SA100', color: 'Satin Anodized', size: '1/4"', material: 'Aluminum', price: 15.29 },
      { code: 'SA125', color: 'Satin Anodized', size: '3/8"', material: 'Aluminum', price: 16.09 },
      { code: 'SA150', color: 'Satin Anodized', size: '1/2"', material: 'Aluminum', price: 17.29 },
      // Coated Aluminum
      { code: 'SN125', color: 'Satin Nickel', size: '3/8"', material: 'Aluminum', price: 18.00 },
      { code: 'BN125', color: 'Brushed Nickel', size: '3/8"', material: 'Aluminum', price: 22.50 },
      { code: 'PC125', color: 'Polished Chrome', size: '3/8"', material: 'Aluminum', price: 21.81 },
      { code: 'MB125', color: 'Matte Black', size: '3/8"', material: 'Aluminum', price: 27.66 },
    ],
  },
];

// ─── Main entry point ────────────────────────────────────────────────

export async function run(pool, job, source) {
  const vendor_id = source.vendor_id;

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalImages = 0;
  let errorCount = 0;

  // Look up category
  const catResult = await pool.query(
    `SELECT id FROM categories WHERE slug = $1 LIMIT 1`,
    [CATEGORY_SLUG]
  );
  const category_id = catResult.rows.length ? catResult.rows[0].id : null;

  try {
    await appendLog(pool, job.id, `Schluter Profiles: ${PROFILE_LINES.length} product lines, ${PROFILE_LINES.reduce((n, l) => n + l.skus.length, 0)} SKUs`);

    for (const line of PROFILE_LINES) {
      let lineCreated = 0;

      const product = await upsertProduct(pool, {
        vendor_id,
        name: line.productName,
        collection: COLLECTION,
        category_id,
        description_short: line.description_short,
      });

      // Set product image if new or missing
      if (line.imageUrl) {
        const imgCheck = await pool.query(
          `SELECT 1 FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1`,
          [product.id]
        );
        if (!imgCheck.rows.length) {
          await saveProductImages(pool, product.id, [line.imageUrl]);
          totalImages++;
        }
      }

      for (const s of line.skus) {
        try {
          const internalSku = `DAL-SCHLUTER-${line.skuPrefix}-${s.code}`;
          const variantName = `${s.color}, ${s.size}`;

          const sku = await upsertSku(pool, {
            product_id: product.id,
            vendor_sku: internalSku,
            internal_sku: internalSku,
            variant_name: variantName,
            sell_by: 'unit',
          });

          await upsertPricing(pool, sku.id, {
            retail_price: s.price,
            cost: 0,
            price_basis: 'per_unit',
          });

          await upsertSkuAttribute(pool, sku.id, 'color', s.color);
          await upsertSkuAttribute(pool, sku.id, 'size', s.size);
          await upsertSkuAttribute(pool, sku.id, 'material', s.material);

          if (sku.is_new) {
            lineCreated++;
            totalCreated++;
          } else {
            totalSkipped++;
          }
        } catch (err) {
          errorCount++;
          await addJobError(pool, job.id, `${line.productName} / ${s.code}: ${err.message}`);
        }
      }

      await appendLog(pool, job.id, `  ${line.productName}: ${lineCreated} new, ${line.skus.length - lineCreated} skipped`);
    }

    // Activate all 4 products
    await pool.query(
      `UPDATE products SET status = 'active' WHERE vendor_id = $1 AND collection = $2`,
      [vendor_id, COLLECTION]
    );

    await appendLog(pool, job.id,
      `Complete. New SKUs: ${totalCreated}, Skipped: ${totalSkipped}, Images: ${totalImages}, Errors: ${errorCount}`,
      { products_found: PROFILE_LINES.length, skus_created: totalCreated }
    );

  } catch (err) {
    await addJobError(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}
