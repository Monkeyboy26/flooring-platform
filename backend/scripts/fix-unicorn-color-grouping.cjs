/**
 * Fix Unicorn Tile color grouping — comprehensive migration.
 *
 * Phase 1: Add 9 missing website products (pricing estimated from similar products)
 * Phase 2: Add missing color variants to existing products
 * Phase 3: Fix Nox color attributes (shapes → Black)
 * Phase 4: Fix accessory & single-color-product color attributes
 *
 * Run: docker compose exec api node scripts/fix-unicorn-color-grouping.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  ceramic:   '650e8400-e29b-41d4-a716-446655440013',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
};
const ATTR = {
  color: 'd50e8400-e29b-41d4-a716-446655440001',
  size:  'd50e8400-e29b-41d4-a716-446655440004',
};

const usedSkus = new Set();
function genSku(brand, series, color, size) {
  const b = brand === 'Deer Tile' ? 'DR' : 'UN';
  const s = series.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5);
  const c = color.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
  const z = size.replace(/[" ]/g, '').toUpperCase();
  let base = `${b}-${s}-${c}-${z}`;
  if (usedSkus.has(base)) {
    let i = 2;
    while (usedSkus.has(`${base}-${i}`)) i++;
    base = `${base}-${i}`;
  }
  usedSkus.add(base);
  return base;
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: New products from website (not in Q4-2025 price list)
// Pricing estimated from comparable products. Mark status = 'active'.
// ══════════════════════════════════════════════════════════════════════════════
const NEW_PRODUCTS = [
  {
    name: 'Borneo', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Gris', '9x48', 11.40, 4, 11.62, 40],
      ['Taupe', '9x48', 11.40, 4, 11.62, 40],
      ['Haya', '9x48', 11.40, 4, 11.62, 40],
    ],
  },
  {
    name: 'dAntilia', col: 'Unicorn Tile', cat: 'ceramic',
    tile: [
      ['Carrara', '12x24', 3.98, 8, 15.9, 60],
      ['Carrara Wave', '12x24', 3.98, 8, 15.9, 60],
    ],
    acc: [['Bullnose', '3x12', 14.00]],
  },
  {
    name: 'Hexagon', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Calacatta Gold Nat', '20.5x23.6', 11.40, 2, 7.50, 44],
    ],
  },
  {
    name: 'Le Que', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Neon', '13x40', 11.40, 4, 14, 48]],
  },
  {
    name: 'Onda', col: 'Unicorn Tile', cat: 'mosaic',
    unit: [['Black 2x2 Square Mosaic', '12x12 sheet', 8.90]],
  },
  {
    name: 'Paulista', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Bloc White', '23x23', 11.40, 2, 7.50, 44],
    ],
  },
  {
    name: 'Rue De Paris', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [
      ['Blanco', '36x36', 7.40, 2, 17.90, 27],
      ['Beige', '36x36', 7.40, 2, 17.90, 27],
    ],
  },
  {
    name: 'Sparkling', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Contempo Black', '12x24', 3.58, 8, 15.9, 48]],
  },
  {
    name: 'Veneziana', col: 'Unicorn Tile', cat: 'porcelain',
    tile: [['Bone', '24x24', 5.40, 3, 11.63, 32]],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Missing color variants for existing products
// Pricing cloned from same-product siblings.
// ══════════════════════════════════════════════════════════════════════════════
const MISSING_VARIANTS = [
  {
    product: 'Unicorn Tile Akila Lux',
    tile: [['White', '24x24', 9.90, 3, 11.90, 48]],
  },
  {
    product: 'Unicorn Tile Catavento',
    tile: [['Linen', '23x23', 11.40, 2, 7.50, 44]],
  },
  {
    product: 'Unicorn Tile Brick',
    tile: [["D'Caravista Winter", '12x24', 4.90, 6, 11.50, 40]],
  },
  {
    product: 'Unicorn Tile Creative Concrete',
    tile: [
      ['Nero', '12x24', 5.40, 5, 9.69, 48],
      ['Nero', '24x24', 5.40, 3, 11.63, 32],
    ],
  },
  {
    product: 'Unicorn Tile Spectrum',
    tile: [
      ['Carrara Matte', '12x24', 3.58, 8, 15.90, 40],
      ['Carrara Polished', '12x24', 3.58, 8, 15.90, 40],
    ],
  },
  {
    product: 'Unicorn Tile Track',
    tile: [['Gris', '30x30', 6.50, 2, 12.16, 42]],
  },
  {
    product: 'Unicorn Tile Shades',
    tile: [
      ['White Glossy', '4x16', 3.58, 28, 12.10, 72],
      ['White Matte', '4x16', 3.58, 28, 12.10, 72],
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3 & 4: Color attribute fixes (applied via UPDATE)
// ══════════════════════════════════════════════════════════════════════════════

async function upsertAttr(client, skuId, attrSlug, value) {
  const attrId = ATTR[attrSlug];
  if (!attrId) return;
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, value]);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load existing SKUs to avoid genSku collisions
    const { rows: existingSkus } = await client.query(
      `SELECT vendor_sku FROM skus WHERE vendor_sku LIKE 'UN-%' OR vendor_sku LIKE 'DR-%'`
    );
    for (const r of existingSkus) usedSkus.add(r.vendor_sku);

    // Get vendor ID
    const { rows: [vendor] } = await client.query(
      `SELECT id FROM vendors WHERE code = 'UNICORN'`
    );
    const vendorId = vendor.id;

    let p1Products = 0, p1Skus = 0;
    let p2Skus = 0;
    let p3Fixes = 0, p4Fixes = 0;

    // ── PHASE 1: Add missing website products ──────────────────────────────
    console.log('=== Phase 1: Add 9 missing website products ===\n');

    for (const prod of NEW_PRODUCTS) {
      // Product names in DB use "${collection} ${name}" format
      const fullName = `${prod.col} ${prod.name}`;

      // Check if product already exists
      const { rows: existing } = await client.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND name = $2 AND collection = $3`,
        [vendorId, fullName, prod.col]
      );

      let productId;
      if (existing.length > 0) {
        productId = existing[0].id;
        console.log(`  SKIP (exists): ${prod.col} / ${prod.name}`);
      } else {
        if (!DRY_RUN) {
          const res = await client.query(`
            INSERT INTO products (id, vendor_id, name, collection, category_id, status)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
            RETURNING id
          `, [vendorId, fullName, prod.col, CAT[prod.cat]]);
          productId = res.rows[0].id;
        } else {
          productId = 'dry-run-id';
        }
        p1Products++;
        console.log(`  ADD product: ${prod.col} / ${prod.name}`);
      }

      // Insert tile SKUs (sold by sqft)
      if (prod.tile) {
        for (const [color, size, msrp, pcs, sqf, plt] of prod.tile) {
          const vendorSku = genSku(prod.col, prod.name, color, size);
          const variantName = `${color} ${size}`;
          const colorClean = color
            .replace(/ (Glossy|Matte|Polished|& Matte|& Glossy|Nat|Nat\.).*$/i, '')
            .trim();

          console.log(`    SKU: ${variantName} (${vendorSku}) — color: ${colorClean}`);

          if (!DRY_RUN) {
            const skuRes = await client.query(`
              INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
              VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
              ON CONFLICT ON CONSTRAINT skus_internal_sku_key
              DO UPDATE SET variant_name = EXCLUDED.variant_name, status = 'active'
              RETURNING id
            `, [productId, vendorSku, vendorSku, variantName]);
            const skuId = skuRes.rows[0].id;

            // Pricing
            const cost = (msrp * 0.50).toFixed(2);
            await client.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $3, 'sqft')
              ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
            `, [skuId, cost, msrp.toFixed(2)]);

            // Packaging
            if (pcs && sqf) {
              await client.query(`
                INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, boxes_per_pallet)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (sku_id) DO UPDATE SET
                  pieces_per_box = EXCLUDED.pieces_per_box,
                  sqft_per_box = EXCLUDED.sqft_per_box,
                  boxes_per_pallet = EXCLUDED.boxes_per_pallet
              `, [skuId, pcs, sqf, plt]);
            }

            // Attributes
            await upsertAttr(client, skuId, 'size', size);
            if (colorClean) await upsertAttr(client, skuId, 'color', colorClean);
          }
          p1Skus++;
        }
      }

      // Insert unit-priced SKUs (mosaics sold per sheet)
      if (prod.unit) {
        for (const [desc, size, msrp] of prod.unit) {
          const vendorSku = genSku(prod.col, prod.name, desc, size);
          const variantName = `${desc} ${size}`;
          // Extract color from description
          const colorClean = desc
            .replace(/ (Glossy|Matte|Polished|Square|Hexagon|Herringbone|Mosaic|Round|Penny|\d+x\d+).*$/i, '')
            .trim();

          console.log(`    SKU (unit): ${variantName} (${vendorSku}) — color: ${colorClean}`);

          if (!DRY_RUN) {
            const skuRes = await client.query(`
              INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
              VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'active')
              ON CONFLICT ON CONSTRAINT skus_internal_sku_key
              DO UPDATE SET variant_name = EXCLUDED.variant_name, status = 'active'
              RETURNING id
            `, [productId, vendorSku, vendorSku, variantName]);
            const skuId = skuRes.rows[0].id;

            const cost = (msrp * 0.50).toFixed(2);
            await client.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $3, 'unit')
              ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
            `, [skuId, cost, msrp.toFixed(2)]);

            await upsertAttr(client, skuId, 'size', size);
            if (colorClean) await upsertAttr(client, skuId, 'color', colorClean);
          }
          p1Skus++;
        }
      }

      // Insert accessories
      if (prod.acc) {
        for (const [desc, size, msrp] of prod.acc) {
          const vendorSku = genSku(prod.col, prod.name, desc, size);
          const variantName = `${desc} ${size}`;

          console.log(`    ACC: ${variantName} (${vendorSku})`);

          if (!DRY_RUN) {
            const skuRes = await client.query(`
              INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
              VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unit', 'accessory', 'active')
              ON CONFLICT ON CONSTRAINT skus_internal_sku_key
              DO UPDATE SET variant_name = EXCLUDED.variant_name, variant_type = 'accessory', status = 'active'
              RETURNING id
            `, [productId, vendorSku, vendorSku, variantName]);
            const skuId = skuRes.rows[0].id;

            const cost = (msrp * 0.50).toFixed(2);
            await client.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $3, 'unit')
              ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
            `, [skuId, cost, msrp.toFixed(2)]);

            await upsertAttr(client, skuId, 'size', size);
          }
          p1Skus++;
        }
      }
    }

    console.log(`\nPhase 1: ${p1Products} products, ${p1Skus} SKUs added\n`);

    // ── PHASE 2: Add missing color variants ────────────────────────────────
    console.log('=== Phase 2: Add missing color variants to existing products ===\n');

    for (const mv of MISSING_VARIANTS) {
      // Product names in DB are stored as "Unicorn Tile Akila Lux" etc.
      const { rows: prods } = await client.query(
        `SELECT p.id FROM products p JOIN vendors v ON v.id = p.vendor_id
         WHERE v.code = 'UNICORN' AND p.name = $1`,
        [mv.product]
      );
      if (prods.length === 0) {
        console.log(`  SKIP (not found): ${mv.product}`);
        continue;
      }
      const productId = prods[0].id;

      const shortName = mv.product.replace(/^Unicorn Tile /, '');
      console.log(`  ${mv.product}:`);

      if (mv.tile) {
        for (const [color, size, msrp, pcs, sqf, plt] of mv.tile) {
          const vendorSku = genSku('Unicorn Tile', shortName, color, size);
          const variantName = `${color} ${size}`;
          const colorClean = color
            .replace(/ (Glossy|Matte|Polished|& Matte|& Glossy).*$/i, '')
            .trim();

          // Check if this variant already exists
          const { rows: existingVar } = await client.query(
            `SELECT id FROM skus WHERE product_id = $1 AND variant_name = $2`,
            [productId, variantName]
          );
          if (existingVar.length > 0) {
            console.log(`    SKIP (exists): ${variantName}`);
            continue;
          }

          console.log(`    ADD: ${variantName} (${vendorSku}) — color: ${colorClean}`);

          if (!DRY_RUN) {
            const skuRes = await client.query(`
              INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
              VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sqft', 'active')
              ON CONFLICT ON CONSTRAINT skus_internal_sku_key
              DO UPDATE SET variant_name = EXCLUDED.variant_name, status = 'active'
              RETURNING id
            `, [productId, vendorSku, vendorSku, variantName]);
            const skuId = skuRes.rows[0].id;

            const cost = (msrp * 0.50).toFixed(2);
            await client.query(`
              INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
              VALUES ($1, $2, $3, 'sqft')
              ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost, retail_price = EXCLUDED.retail_price
            `, [skuId, cost, msrp.toFixed(2)]);

            if (pcs && sqf) {
              await client.query(`
                INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, boxes_per_pallet)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (sku_id) DO UPDATE SET
                  pieces_per_box = EXCLUDED.pieces_per_box,
                  sqft_per_box = EXCLUDED.sqft_per_box,
                  boxes_per_pallet = EXCLUDED.boxes_per_pallet
              `, [skuId, pcs, sqf, plt]);
            }

            await upsertAttr(client, skuId, 'size', size);
            if (colorClean) await upsertAttr(client, skuId, 'color', colorClean);
          }
          p2Skus++;
        }
      }
    }

    console.log(`\nPhase 2: ${p2Skus} variant SKUs added\n`);

    // ── PHASE 3: Fix Nox color attributes ──────────────────────────────────
    console.log('=== Phase 3: Fix Nox color attributes (shapes → Black) ===\n');

    // All Nox tiles and accessories are black
    const { rows: noxSkus } = await client.query(`
      SELECT s.id, s.variant_name, s.variant_type,
             (SELECT sa.value FROM sku_attributes sa
              WHERE sa.sku_id = s.id AND sa.attribute_id = $1) AS color
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.name = 'Unicorn Tile Nox'
        AND p.vendor_id = $2
      ORDER BY s.variant_type NULLS FIRST, s.variant_name
    `, [ATTR.color, vendorId]);

    for (const sku of noxSkus) {
      if (sku.color === 'Black') {
        continue; // Already correct
      }
      const oldColor = sku.color || 'NULL';
      console.log(`  ${sku.variant_name}: ${oldColor} → Black`);

      if (!DRY_RUN) {
        await upsertAttr(client, sku.id, 'color', 'Black');
      }
      p3Fixes++;
    }

    console.log(`\nPhase 3: ${p3Fixes} Nox color attributes fixed\n`);

    // ── PHASE 4: Fix accessory & single-color product color attributes ─────
    console.log('=== Phase 4: Fix accessory color attributes ===\n');

    // For each product, find the dominant tile color. For single-color products,
    // set all accessories to that color. For multi-color products, skip.
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1
      ORDER BY p.collection, p.name
    `, [vendorId]);

    for (const prod of products) {
      // Get distinct colors from main (non-accessory) SKUs
      const { rows: mainColors } = await client.query(`
        SELECT DISTINCT sa.value AS color
        FROM skus s
        JOIN sku_attributes sa ON sa.sku_id = s.id
        WHERE s.product_id = $1
          AND s.variant_type IS NULL
          AND sa.attribute_id = $2
          AND sa.value IS NOT NULL
      `, [prod.id, ATTR.color]);

      if (mainColors.length !== 1) continue; // Skip multi-color products

      const trueColor = mainColors[0].color;

      // Find accessories with wrong color (product name as color, or type-as-color)
      const { rows: accSkus } = await client.query(`
        SELECT s.id, s.variant_name,
               (SELECT sa.value FROM sku_attributes sa
                WHERE sa.sku_id = s.id AND sa.attribute_id = $1) AS color
        FROM skus s
        WHERE s.product_id = $2
          AND s.variant_type = 'accessory'
        ORDER BY s.variant_name
      `, [ATTR.color, prod.id]);

      for (const acc of accSkus) {
        // Skip if already correct
        if (acc.color === trueColor) continue;

        // Skip if color is actually descriptive (contains a real color word different from trueColor)
        // e.g., "White" on an Arte Jolly, "Crema Latte Silver" on a Shades Jolly
        // These are fine and represent specific accessory colors
        const accColor = (acc.color || '').toLowerCase();
        const knownColors = ['white', 'black', 'grey', 'gray', 'beige', 'silver', 'crema',
          'cream', 'latte', 'blue', 'green', 'red', 'nero', 'bianco', 'blanco',
          'ivory', 'gold', 'bone', 'brown', 'charcoal', 'cotto', 'graphit'];
        const hasRealColor = knownColors.some(c => accColor.includes(c));
        if (hasRealColor && accColor !== trueColor.toLowerCase()) continue;

        // Fix: set to parent product's color
        const fullName = `${prod.collection} / ${prod.name}`;
        console.log(`  ${fullName} | ${acc.variant_name}: "${acc.color || 'NULL'}" → "${trueColor}"`);

        if (!DRY_RUN) {
          await upsertAttr(client, acc.id, 'color', trueColor);
        }
        p4Fixes++;
      }
    }

    console.log(`\nPhase 4: ${p4Fixes} accessory color attributes fixed\n`);

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('=== Summary ===');
    console.log(`Phase 1: ${p1Products} new products, ${p1Skus} new SKUs`);
    console.log(`Phase 2: ${p2Skus} missing variant SKUs added`);
    console.log(`Phase 3: ${p3Fixes} Nox colors fixed`);
    console.log(`Phase 4: ${p4Fixes} accessory colors fixed`);
    console.log(`Total changes: ${p1Products + p1Skus + p2Skus + p3Fixes + p4Fixes}\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Done — all changes committed!');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
