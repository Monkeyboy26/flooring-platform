/**
 * Mapei — Fill Missing Products (Grout, Caulk, Thinset/Mortar)
 *
 * Phase A: Pulls the canonical ~42-color Mapei grout palette from Ultracolor
 *          Plus FA and fills missing Keracolor S/U + Keracaulk S/U colors.
 * Phase B: Creates missing Mapei thinset/mortar products (Gray/White variants).
 *
 * Vendor: Big D Supply (code BIGD)
 * Pricing: retail_price from known retail pricing, cost = 0, price_basis = per_unit
 *
 * Usage: Run from admin UI after creating Big D Supply vendor + vendor_source.
 */

import {
  upsertProduct, upsertSku, upsertSkuAttribute, upsertPricing,
  saveProductImages, upsertMediaAsset,
  appendLog, addJobError,
} from './base.js';

const COLLECTION = 'Mapei';

// ─── Phase A: Color-based products (grout + caulk) ──────────────────
const COLOR_PRODUCT_LINES = [
  { productName: 'Mapei Keracolor S Sanded Grout',   retailPrice: 34.98, skuPrefix: 'KC-S',  categoryHint: 'grout' },
  { productName: 'Mapei Keracolor U Unsanded Grout',  retailPrice: 21.98, skuPrefix: 'KC-U',  categoryHint: 'grout' },
  { productName: 'Mapei Keracaulk S',                 retailPrice: 12.98, skuPrefix: 'KCK-S', categoryHint: 'adhesives-sealants' },
  { productName: 'Mapei Keracaulk U',                 retailPrice: 12.98, skuPrefix: 'KCK-U', categoryHint: 'adhesives-sealants' },
];

// ─── Phase B: Thinset / mortar products ──────────────────────────────
// Each entry creates SKUs for each variant (typically Gray + White).
// Prices sourced from tiletoolshq.com / big-box retail, early 2026.
// imageUrl: known Mapei CDN product image.
const THINSET_PRODUCTS = [
  {
    productName: 'Mapei Ultraflex 2',
    skuPrefix: 'UF2',
    categoryHint: 'installation-sundries',
    description_short: 'Professional-grade polymer-modified thin-set mortar for ceramic, porcelain & natural stone. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 18.99 },
      { name: 'White', retailPrice: 21.99 },
    ],
    imageUrl: 'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_22-1713-ultraflex-1-gray-50lbs_b402d13974054449a8c5b4da9952c372.png',
  },
  {
    productName: 'Mapei Ultraflex RS',
    skuPrefix: 'UFRS',
    categoryHint: 'installation-sundries',
    description_short: 'Rapid-setting polymer-modified thin-set mortar. Sets in 3-4 hours. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 29.99 },
      { name: 'White', retailPrice: 32.99 },
    ],
    imageUrl: 'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_3000264-ultraflex-lft-rapid-grey-50lbs_abd540d6036240a999f4595e42e76242.png',
  },
  {
    productName: 'Mapei Kerabond',
    skuPrefix: 'KB',
    categoryHint: 'installation-sundries',
    description_short: 'Premium-grade dry-set mortar for interior/exterior floor and wall tile. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 16.99 },
      { name: 'White', retailPrice: 19.99 },
    ],
    imageUrl: 'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_3000123-kerabond-1-50lb_gray_94ebf3baf67a4adcad9a8d5f8d2131a5.png',
  },
  {
    productName: 'Mapei Kerabond T',
    skuPrefix: 'KBT',
    categoryHint: 'installation-sundries',
    description_short: 'Premium-grade non-sag mortar for large-and-heavy-tile thin-set applications. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 17.99 },
      { name: 'White', retailPrice: 20.99 },
    ],
    imageUrl: 'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_3000124-kerabond-t-1-50lb_gray_be39c6edb2d84db0824a79a5e91d8d3b.png',
  },
  {
    productName: 'Mapei Keralastic',
    skuPrefix: 'KL',
    categoryHint: 'installation-sundries',
    description_short: 'Premium-grade acrylic latex additive for Kerabond mortar system.',
    variants: [
      { name: '2 Gal', retailPrice: 56.99 },
      { name: '5 Gal', retailPrice: 125.99 },
    ],
    imageUrl: 'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_3000125-keralastic-1_2gal_b0ce5cc6f0274289a9bb3b8e6fc0cdad.png',
  },
  {
    productName: 'Mapei ECO Ultraflex',
    skuPrefix: 'ECUF',
    categoryHint: 'installation-sundries',
    description_short: 'Professional-grade, eco-friendly polymer-modified thin-set mortar. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 22.99 },
      { name: 'White', retailPrice: 25.99 },
    ],
    imageUrl: null,
  },
  {
    productName: 'Mapei Large Tile & Gauged Porcelain Tile Mortar',
    skuPrefix: 'LTGPT',
    categoryHint: 'installation-sundries',
    description_short: 'Premium mortar for large-format and gauged porcelain tile/panel installations. 50 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 32.99 },
      { name: 'White', retailPrice: 35.99 },
    ],
    imageUrl: null,
  },
  {
    productName: 'Mapei Ultralite S2',
    skuPrefix: 'ULS2',
    categoryHint: 'installation-sundries',
    description_short: 'Lightweight, high-performance mortar with polymer. ANSI A118.15. 25 lb bag.',
    variants: [
      { name: 'Gray',  retailPrice: 29.98 },
      { name: 'White', retailPrice: 29.98 },
    ],
    imageUrl: null,
  },
];

// ─── Shared helpers ──────────────────────────────────────────────────

function stripSuffix(c) {
  if (!c) return '';
  return c
    .replace(/\s+\d[A-Za-z0-9]{2,}[-A-Za-z0-9]*$/, '')
    .replace(/\s+[A-Za-z]{2}-[A-Za-z0-9-]+$/, '')
    .replace(/\s+GC-[A-Za-z0-9-]+$/i, '')
    .replace(/\s+UC-[A-Za-z0-9-]+$/i, '')
    .replace(/\s*\(formerly\s+\w+\)/i, '')
    .trim();
}

function normalizeColor(c) {
  return stripSuffix(c).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function cleanColorName(raw) {
  const stripped = stripSuffix(raw);
  if (!stripped) return titleCase(normalizeColor(raw));
  if (stripped === stripped.toUpperCase()) return titleCase(stripped);
  return stripped;
}

async function loadCanonicalPalette(pool) {
  const result = await pool.query(`
    SELECT DISTINCT sa.value AS raw_color
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'color'
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.name ILIKE '%mapei%ultracolor%'
      AND sa.value NOT ILIKE '%no color%'
      AND sa.value NOT ILIKE '%xxx%'
      AND sa.value NOT ILIKE '%clear%'
    ORDER BY sa.value
  `);

  const seen = new Map();
  for (const row of result.rows) {
    const norm = normalizeColor(row.raw_color);
    if (!norm) continue;
    const clean = cleanColorName(row.raw_color);
    if (!seen.has(norm) || clean.length < seen.get(norm).length) {
      seen.set(norm, clean);
    }
  }
  return [...seen.values()].sort();
}

async function loadExistingColors(pool, productNames) {
  const result = await pool.query(`
    SELECT p.name AS product_name, s.variant_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE (${productNames.map((_, i) => `p.name = $${i + 1}`).join(' OR ')})
      AND s.variant_name IS NOT NULL
  `, productNames);

  const existing = new Map();
  for (const row of result.rows) {
    const pn = row.product_name.trim();
    if (!existing.has(pn)) existing.set(pn, new Set());
    existing.get(pn).add(normalizeColor(row.variant_name));
  }
  return existing;
}

async function copyProductImage(pool, bigdProductId, productName) {
  const result = await pool.query(`
    SELECT ma.url
    FROM media_assets ma
    JOIN products p ON ma.product_id = p.id
    WHERE p.name = $1 AND p.id != $2
      AND ma.asset_type = 'primary' AND ma.url IS NOT NULL
    LIMIT 1
  `, [productName, bigdProductId]);

  if (!result.rows.length) return false;
  await saveProductImages(pool, bigdProductId, [result.rows[0].url]);
  return true;
}

async function findCategory(pool, hint) {
  const result = await pool.query(
    `SELECT id FROM categories WHERE slug = $1 OR name ILIKE $2 LIMIT 1`,
    [hint, `%${hint}%`]
  );
  return result.rows.length ? result.rows[0].id : null;
}

async function productHasImage(pool, productId) {
  const r = await pool.query(
    `SELECT 1 FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1`,
    [productId]
  );
  return r.rows.length > 0;
}

// ─── Main entry point ────────────────────────────────────────────────

export async function run(pool, job, source) {
  const vendor_id = source.vendor_id;

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalImages = 0;
  let totalFixed = 0;
  let errorCount = 0;

  const categoryCache = new Map();
  async function getCategory(hint) {
    if (!categoryCache.has(hint)) {
      categoryCache.set(hint, await findCategory(pool, hint));
    }
    return categoryCache.get(hint);
  }

  try {
    // ── Fix ALL-CAPS variant names on existing BIGD SKUs ─────────
    const capsResult = await pool.query(`
      SELECT s.id, s.variant_name
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.variant_name ~ '^[A-Z ]+$'
    `, [vendor_id]);

    for (const row of capsResult.rows) {
      const fixed = titleCase(row.variant_name);
      await pool.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [fixed, row.id]);
      await pool.query(`
        UPDATE sku_attributes SET value = $1
        WHERE sku_id = $2 AND attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
      `, [fixed, row.id]);
      totalFixed++;
    }
    if (totalFixed > 0) {
      await appendLog(pool, job.id, `Fixed ${totalFixed} ALL-CAPS variant names`);
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE A: Color-based products (grout + caulk)
    // ══════════════════════════════════════════════════════════════
    const palette = await loadCanonicalPalette(pool);
    await appendLog(pool, job.id, `Phase A: ${palette.length} Mapei colors from Ultracolor Plus FA`);

    if (palette.length > 0) {
      const colorProductNames = COLOR_PRODUCT_LINES.map(l => l.productName);
      const existingColors = await loadExistingColors(pool, colorProductNames);

      for (const line of COLOR_PRODUCT_LINES) {
        const category_id = await getCategory(line.categoryHint);
        const existingSet = existingColors.get(line.productName) || new Set();
        let lineCreated = 0;

        for (const color of palette) {
          const normColor = normalizeColor(color);
          if (existingSet.has(normColor)) { totalSkipped++; continue; }

          try {
            const product = await upsertProduct(pool, {
              vendor_id, name: line.productName, collection: COLLECTION, category_id,
            });

            const colorSlug = color.replace(/\s+/g, '-');
            const skuCode = `BIGD-${line.skuPrefix}-${colorSlug}`;

            const sku = await upsertSku(pool, {
              product_id: product.id, vendor_sku: skuCode, internal_sku: skuCode,
              variant_name: color, sell_by: 'unit',
            });

            await upsertPricing(pool, sku.id, {
              retail_price: line.retailPrice, cost: 0, price_basis: 'per_unit',
            });
            await upsertSkuAttribute(pool, sku.id, 'color', color);

            if (sku.is_new) {
              const copied = await copyProductImage(pool, product.id, line.productName);
              if (copied) totalImages++;
              lineCreated++;
              totalCreated++;
            }

            existingSet.add(normColor);
            if (!existingColors.has(line.productName)) existingColors.set(line.productName, existingSet);
          } catch (err) {
            errorCount++;
            await addJobError(pool, job.id, `${line.productName} / ${color}: ${err.message}`);
          }
        }

        await appendLog(pool, job.id, `  ${line.productName}: ${lineCreated} new, ${existingSet.size} total`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE B: Thinset / mortar products
    // ══════════════════════════════════════════════════════════════
    await appendLog(pool, job.id, `Phase B: ${THINSET_PRODUCTS.length} thinset/mortar product lines`);

    // Load existing thinset SKUs across all vendors
    const thinsetNames = THINSET_PRODUCTS.map(t => t.productName);
    const existingThinsets = await loadExistingColors(pool, thinsetNames);

    for (const ts of THINSET_PRODUCTS) {
      const category_id = await getCategory(ts.categoryHint);
      const existingSet = existingThinsets.get(ts.productName) || new Set();
      let lineCreated = 0;

      for (const v of ts.variants) {
        const normVariant = v.name.toLowerCase().trim();
        if (existingSet.has(normVariant)) { totalSkipped++; continue; }

        try {
          const product = await upsertProduct(pool, {
            vendor_id, name: ts.productName, collection: COLLECTION, category_id,
            description_short: ts.description_short,
          });

          const variantSlug = v.name.replace(/\s+/g, '-');
          const skuCode = `BIGD-${ts.skuPrefix}-${variantSlug}`;

          const sku = await upsertSku(pool, {
            product_id: product.id, vendor_sku: skuCode, internal_sku: skuCode,
            variant_name: v.name, sell_by: 'unit',
          });

          await upsertPricing(pool, sku.id, {
            retail_price: v.retailPrice, cost: 0, price_basis: 'per_unit',
          });
          await upsertSkuAttribute(pool, sku.id, 'color', v.name);

          if (sku.is_new) {
            // Set product image: try copying from DAL, then use provided CDN URL
            const hasImg = await productHasImage(pool, product.id);
            if (!hasImg) {
              const copied = await copyProductImage(pool, product.id, ts.productName);
              if (!copied && ts.imageUrl) {
                await saveProductImages(pool, product.id, [ts.imageUrl]);
              }
              totalImages++;
            }
            lineCreated++;
            totalCreated++;
          }

          existingSet.add(normVariant);
          if (!existingThinsets.has(ts.productName)) existingThinsets.set(ts.productName, existingSet);
        } catch (err) {
          errorCount++;
          await addJobError(pool, job.id, `${ts.productName} / ${v.name}: ${err.message}`);
        }
      }

      await appendLog(pool, job.id, `  ${ts.productName}: ${lineCreated} new, ${existingSet.size} total`);
    }

    // ── Summary ──────────────────────────────────────────────────
    await appendLog(pool, job.id,
      `Complete. New SKUs: ${totalCreated}, Skipped: ${totalSkipped}, ` +
      `Names fixed: ${totalFixed}, Images: ${totalImages}, Errors: ${errorCount}`,
      { products_found: totalSkipped + totalCreated, skus_created: totalCreated }
    );

  } catch (err) {
    await addJobError(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}
