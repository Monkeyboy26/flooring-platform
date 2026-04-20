#!/usr/bin/env node
/**
 * fix-provenza-cleanup.cjs
 *
 * Phase 2 cleanup: merge duplicates, fix junk collection names, clean up images.
 *
 * Problems this fixes:
 * 1. 832 feed created per-color products for Dutch Masters under "EUROPEAN OAK 4MM (PIECES)"
 *    — merge flooring SKUs into main "Dutch Masters" product, accessories into proper accessory products
 * 2. "Zz" prefix products under bare "Provenza" collection — merge into proper collections
 * 3. Junk collection names (NOSE 94.48, PROFILE,COLOR,SIZE,QTY, etc.) — move or deactivate
 * 4. Generic accessory products without collection — deactivate
 * 5. Accessory products sharing flooring images — remove incorrect images
 * 6. Bare "Provenza" collection products (loose accessories) — deactivate non-essential ones
 */
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const VENDOR_ID = process.env.VENDOR_ID;

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

// Map "Zz" product color names to their correct Provenza collection
const ZZ_COLOR_TO_COLLECTION = {
  'brown sugar': 'Antico',
  'caribou': 'Antico',
  'dovetail': 'Herringbone Reserve',
  'grotto': 'Volterra',
  'hang ten': 'Moda Living',
  'jet set': 'Moda Living',
  'messina': 'Lugano',
  'mink': 'Old World',
  'obsession': 'Affinity',
  'toulouse': 'Palais Royale',
};

async function main() {
  try {
    // Find vendor_id for Tri-West
    let vendorId = VENDOR_ID;
    if (!vendorId) {
      const vr = await pool.query(`SELECT id FROM vendors WHERE name ILIKE '%tri%west%' LIMIT 1`);
      if (vr.rows.length === 0) { console.error('Tri-West vendor not found'); return; }
      vendorId = vr.rows[0].id;
    }
    console.log(`Vendor ID: ${vendorId}`);
    if (DRY_RUN) console.log('=== DRY RUN ===\n');

    let totalMoved = 0;
    let totalDeactivated = 0;
    let totalImagesRemoved = 0;

    // ── 1. Merge EUROPEAN OAK 4MM products into Dutch Masters ──
    console.log('--- Step 1: Merge EUROPEAN OAK 4MM into Dutch Masters ---');
    {
      // Find the main Dutch Masters product
      const dmResult = await pool.query(`
        SELECT id FROM products
        WHERE vendor_id = $1 AND collection = 'Provenza - Dutch Masters' AND name = 'Dutch Masters' AND is_active = true
        LIMIT 1
      `, [vendorId]);

      if (dmResult.rows.length === 0) {
        console.log('  No main Dutch Masters product found — creating one');
        if (!DRY_RUN) {
          const cr = await pool.query(`
            INSERT INTO products (vendor_id, collection, name, status, is_active, created_at, updated_at)
            VALUES ($1, 'Provenza - Dutch Masters', 'Dutch Masters', 'active', true, NOW(), NOW())
            RETURNING id
          `, [vendorId]);
          var dmProductId = cr.rows[0].id;
        }
      } else {
        var dmProductId = dmResult.rows[0].id;
      }

      // Find all EUROPEAN OAK 4MM products
      const euroProducts = await pool.query(`
        SELECT p.id, p.name FROM products p
        WHERE p.vendor_id = $1 AND p.collection = 'Provenza - EUROPEAN OAK 4MM (PIECES)' AND p.is_active = true
      `, [vendorId]);

      console.log(`  Found ${euroProducts.rows.length} EUROPEAN OAK products to merge`);

      // Find or create accessory products for Dutch Masters
      const accessoryTypes = ['Stairnose', 'Reducer', 'Quarter Round', 'T Mold', 'End Cap', 'Flush Mount'];
      const accessoryProductIds = {};

      for (const type of accessoryTypes) {
        const existing = await pool.query(`
          SELECT id FROM products
          WHERE vendor_id = $1 AND collection = 'Provenza - Dutch Masters'
            AND name = $2 AND is_active = true LIMIT 1
        `, [vendorId, `Dutch Masters ${type}`]);

        if (existing.rows.length > 0) {
          accessoryProductIds[type] = existing.rows[0].id;
        }
      }

      for (const euroProd of euroProducts.rows) {
        // Get all SKUs under this product
        const skus = await pool.query(`
          SELECT id, variant_name, vendor_sku FROM skus WHERE product_id = $1
        `, [euroProd.id]);

        // Extract color from product name: "Dutch Masters Bosch" → "Bosch"
        const colorName = euroProd.name.replace(/^Dutch Masters\s*/i, '').trim();

        for (const sku of skus.rows) {
          const vn = (sku.variant_name || '').toLowerCase();
          const isAccessory = /stair|reducer|quarter|t[- ]?mold|moulding|end\s*cap|square\s*nose|bullnose|flush/i.test(vn);

          if (isAccessory) {
            // Determine accessory type
            let accType = 'Stairnose';
            if (/reducer/i.test(vn)) accType = 'Reducer';
            else if (/quarter/i.test(vn)) accType = 'Quarter Round';
            else if (/t[- ]?mold|moulding/i.test(vn)) accType = 'T Mold';
            else if (/end\s*cap|square\s*nose/i.test(vn)) accType = 'End Cap';
            else if (/flush/i.test(vn)) accType = 'Stairnose'; // flush stairnose

            // Ensure accessory product exists
            if (!accessoryProductIds[accType] && !DRY_RUN) {
              const cr = await pool.query(`
                INSERT INTO products (vendor_id, collection, name, status, is_active, created_at, updated_at)
                VALUES ($1, 'Provenza - Dutch Masters', $2, 'active', true, NOW(), NOW())
                RETURNING id
              `, [vendorId, `Dutch Masters ${accType}`]);
              accessoryProductIds[accType] = cr.rows[0].id;
            }

            const targetId = accessoryProductIds[accType];
            if (!DRY_RUN && targetId) {
              await pool.query(`UPDATE skus SET product_id = $1, variant_name = $2, variant_type = 'accessory', sell_by = 'unit' WHERE id = $3`,
                [targetId, colorName, sku.id]);
            }
          } else {
            // Flooring SKU — move to main Dutch Masters product
            if (!DRY_RUN && dmProductId) {
              await pool.query(`UPDATE skus SET product_id = $1, variant_name = $2 WHERE id = $3`,
                [dmProductId, colorName, sku.id]);
            }
          }
          totalMoved++;
        }

        // Deactivate the old product
        if (!DRY_RUN) {
          await pool.query(`UPDATE products SET is_active = false, status = 'inactive' WHERE id = $1`, [euroProd.id]);
        }
        totalDeactivated++;
      }
      console.log(`  Moved ${totalMoved} SKUs, deactivated ${totalDeactivated} products`);
    }

    // ── 2. Merge Zz products into proper collections ──
    console.log('\n--- Step 2: Merge Zz flooring products ---');
    {
      let zzMoved = 0;
      for (const [colorKey, collectionName] of Object.entries(ZZ_COLOR_TO_COLLECTION)) {
        const zzName = `Zz ${colorKey.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`;
        const zzProd = await pool.query(`
          SELECT id FROM products WHERE vendor_id = $1 AND name = $2 AND is_active = true LIMIT 1
        `, [vendorId, zzName]);

        if (zzProd.rows.length === 0) continue;

        // Find or create the target collection product
        const targetProd = await pool.query(`
          SELECT id FROM products
          WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND is_active = true LIMIT 1
        `, [vendorId, `Provenza - ${collectionName}`, collectionName]);

        let targetId;
        if (targetProd.rows.length > 0) {
          targetId = targetProd.rows[0].id;
        } else if (!DRY_RUN) {
          const cr = await pool.query(`
            INSERT INTO products (vendor_id, collection, name, status, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, 'active', true, NOW(), NOW())
            RETURNING id
          `, [vendorId, `Provenza - ${collectionName}`, collectionName]);
          targetId = cr.rows[0].id;
        }

        // Move SKUs
        const skus = await pool.query(`SELECT id FROM skus WHERE product_id = $1`, [zzProd.rows[0].id]);
        if (!DRY_RUN && targetId) {
          const titleColor = colorKey.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
          await pool.query(`UPDATE skus SET product_id = $1, variant_name = $2 WHERE product_id = $3`,
            [targetId, titleColor, zzProd.rows[0].id]);
          await pool.query(`UPDATE products SET is_active = false, status = 'inactive' WHERE id = $1`, [zzProd.rows[0].id]);
        }
        zzMoved += skus.rows.length;
        console.log(`  ${zzName} (${skus.rows.length} SKUs) → ${collectionName}`);
      }
      console.log(`  Total: ${zzMoved} SKUs moved`);
    }

    // ── 3. Deactivate remaining Zz and junk products ──
    console.log('\n--- Step 3: Deactivate remaining junk products ---');
    {
      const junkProducts = await pool.query(`
        SELECT p.id, p.collection, p.name, COUNT(s.id) as skus
        FROM products p
        LEFT JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.is_active = true
          AND p.collection LIKE 'Provenza%'
          AND (
            p.name LIKE 'Zz%' OR p.name LIKE 'Zz %'
            OR p.collection LIKE 'Provenza - EUROPEAN%'
            OR p.collection LIKE 'Provenza - NOSE%'
            OR p.collection LIKE 'Provenza - PROFILE%'
            OR p.collection LIKE 'Provenza - Agio%'
            OR p.collection LIKE 'Provenza - Cherie%'
            OR p.collection LIKE 'Provenza - Pier%'
            OR p.collection = 'Provenza - Cleaner'
            OR p.collection = 'Provenza - Color Set'
            OR p.collection LIKE 'Provenza End Cap%'
            OR p.collection LIKE 'Provenza Flush%'
            OR p.collection LIKE 'Provenza Quarter%'
            OR p.collection LIKE 'Provenza Reducer%'
            OR p.collection LIKE 'Provenza T-mould%'
            OR p.name LIKE 'Zzprovenza%'
            OR p.name = 'Maxcore Custom Flush Square'
            OR p.name = 'Moda Living Fabricated Square'
            OR p.name = 'Provenza Flush Stair Ns'
            OR p.name = 'Provenza Custom Moldings'
            OR p.name = 'Cleaner Cleaner'
            OR p.name = 'Color Set'
          )
        GROUP BY p.id, p.collection, p.name
        ORDER BY p.collection, p.name
      `, [vendorId]);

      for (const jp of junkProducts.rows) {
        console.log(`  Deactivate: ${jp.collection} / ${jp.name} (${jp.skus} SKUs)`);
      }

      if (!DRY_RUN) {
        const ids = junkProducts.rows.map(r => r.id);
        if (ids.length > 0) {
          await pool.query(`UPDATE products SET is_active = false, status = 'inactive' WHERE id = ANY($1)`, [ids]);
        }
      }
      console.log(`  Deactivated ${junkProducts.rows.length} junk products`);
      totalDeactivated += junkProducts.rows.length;
    }

    // ── 4. Remove product-level images from accessory products ──
    console.log('\n--- Step 4: Remove images from accessory-only products ---');
    {
      const accImages = await pool.query(`
        SELECT ma.id, p.name, ma.url
        FROM media_assets ma
        JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true
          AND p.collection LIKE 'Provenza%'
          AND ma.sku_id IS NULL
          AND (p.name LIKE '%Stairnose%' OR p.name LIKE '%Reducer%'
            OR p.name LIKE '%Quarter Round%' OR p.name LIKE '%End Cap%'
            OR p.name LIKE '%Flush Mount%' OR p.name LIKE '%Accessory%'
            OR p.name LIKE '%T Mold%' OR p.name LIKE '%Bullnose%')
      `, [vendorId]);

      console.log(`  Found ${accImages.rows.length} images on accessory products to remove`);
      for (const img of accImages.rows.slice(0, 5)) {
        console.log(`    ${img.name}: ${img.url.split('/').pop()}`);
      }

      if (!DRY_RUN && accImages.rows.length > 0) {
        const ids = accImages.rows.map(r => r.id);
        await pool.query(`DELETE FROM media_assets WHERE id = ANY($1)`, [ids]);
      }
      totalImagesRemoved = accImages.rows.length;
    }

    // ── 5. Remove duplicate SKU images (same image on multiple SKUs) ──
    console.log('\n--- Step 5: Deduplicate SKU images ---');
    {
      // Find SKUs where the image doesn't match the color
      const skuImages = await pool.query(`
        SELECT ma.id, ma.url, s.variant_name, p.name as product_name
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true AND ma.sku_id IS NOT NULL
      `, [vendorId]);

      // Group by URL — if many SKUs share same URL, that's suspicious
      const urlCounts = new Map();
      for (const row of skuImages.rows) {
        urlCounts.set(row.url, (urlCounts.get(row.url) || 0) + 1);
      }
      const duped = [...urlCounts.entries()].filter(([, c]) => c > 1);
      if (duped.length > 0) {
        console.log(`  ${duped.length} images shared across multiple SKUs (OK — same color in different products)`);
      } else {
        console.log('  No duplicate SKU images found');
      }
    }

    // ── 6. Final state ──
    console.log('\n--- Summary ---');
    console.log(`  SKUs moved: ${totalMoved}`);
    console.log(`  Products deactivated: ${totalDeactivated}`);
    console.log(`  Accessory images removed: ${totalImagesRemoved}`);

    if (!DRY_RUN) {
      const final = await pool.query(`
        SELECT COUNT(DISTINCT p.id) as products, COUNT(s.id) as skus
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND p.is_active = true
      `, [vendorId]);
      console.log(`\n  Final active: ${final.rows[0].products} products, ${final.rows[0].skus} SKUs`);

      const collections = await pool.query(`
        SELECT p.collection, p.name, COUNT(s.id) as skus
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND p.is_active = true
        GROUP BY p.collection, p.name
        ORDER BY p.collection, p.name
      `, [vendorId]);
      console.log('\n  Active products:');
      for (const r of collections.rows) {
        console.log(`    ${r.collection} / ${r.name} (${r.skus} SKUs)`);
      }
    }

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
