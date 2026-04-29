/**
 * Fix MSI Accessory Attachments
 *
 * 1. "Mixed product" accessories — already in correct product, just need sku_accessories rows
 * 2. "Catch-all" accessories — find parent product by name/collection matching, then link
 */

const { Pool } = require('pg');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  const log = (msg) => console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
  log('Fix MSI Accessory Attachments');
  log('═'.repeat(60));

  // ─── Part 1: Mixed product accessories ───────────────────────────────
  // These are accessory SKUs that live in a product alongside non-accessory SKUs.
  // Just need sku_accessories rows linking main SKUs → accessory SKUs.

  log('Part 1: Mixed product accessories...');

  const { rows: mixedAccSkus } = await pool.query(`
    SELECT s.id AS acc_sku_id, s.vendor_sku, s.product_id, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.variant_type = 'accessory' AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM sku_accessories sa WHERE sa.accessory_sku_id = s.id)
      AND EXISTS (
        SELECT 1 FROM skus s2
        WHERE s2.product_id = s.product_id
          AND s2.id != s.id
          AND s2.variant_type IS DISTINCT FROM 'accessory'
      )
  `, [VENDOR_ID]);

  log(`  Found ${mixedAccSkus.length} mixed-product accessories to link`);

  let mixedLinked = 0;
  for (const acc of mixedAccSkus) {
    // Find all main (non-accessory) SKUs in the same product
    const { rows: mainSkus } = await pool.query(`
      SELECT id FROM skus
      WHERE product_id = $1 AND variant_type IS DISTINCT FROM 'accessory' AND status = 'active'
    `, [acc.product_id]);

    for (const main of mainSkus) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [main.id, acc.acc_sku_id]);
      mixedLinked++;
    }
  }
  log(`  Created ${mixedLinked} sku_accessories rows for mixed products`);

  // ─── Part 2: Catch-all accessories ───────────────────────────────────
  // These are in products that contain ONLY accessory SKUs. Need to find
  // the right parent product by name matching within the collection.

  log('Part 2: Catch-all accessories...');

  const { rows: catchAllAccSkus } = await pool.query(`
    SELECT s.id AS acc_sku_id, s.vendor_sku, s.product_id,
           p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1
      AND s.variant_type = 'accessory' AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM sku_accessories sa WHERE sa.accessory_sku_id = s.id)
      AND NOT EXISTS (
        SELECT 1 FROM skus s2
        WHERE s2.product_id = s.product_id
          AND s2.id != s.id
          AND s2.variant_type IS DISTINCT FROM 'accessory'
      )
  `, [VENDOR_ID]);

  log(`  Found ${catchAllAccSkus.length} catch-all accessories to match`);

  let catchAllLinked = 0, catchAllUnmatched = 0;

  for (const acc of catchAllAccSkus) {
    // Strategy 1: Find a main product with the same name in the same or similar collection
    let parentProductId = null;

    // Extract the core stone name from the accessory product name
    // e.g., "Tuscany Beige" from "Tuscany Beige Versailles Pattern"
    const accName = acc.product_name.toLowerCase();
    const accNameClean = accName
      .replace(/versailles.*$/i, '')
      .replace(/vein\s*cut.*$/i, '')
      .replace(/\d+x\d+.*$/i, '')
      .replace(/hf\b.*$/i, '')
      .replace(/hufcb?\b.*$/i, '')
      .replace(/tumbled\b.*$/i, '')
      .replace(/classic\b.*$/i, '')
      .replace(/pattern\b.*$/i, '')
      .trim();

    // Try to find parent product by name similarity in same collection
    if (acc.collection) {
      const { rows: candidates } = await pool.query(`
        SELECT DISTINCT p.id, p.name,
          COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') AS main_sku_count
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.collection = $2
          AND p.id != $3
          AND s.variant_type IS DISTINCT FROM 'accessory'
        GROUP BY p.id, p.name
        HAVING COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') > 0
        ORDER BY p.name
      `, [VENDOR_ID, acc.collection, acc.product_id]);

      if (candidates.length > 0) {
        // Try exact name match first
        let match = candidates.find(c => c.name.toLowerCase() === accNameClean);

        // Try prefix match
        if (!match && accNameClean.length >= 4) {
          match = candidates.find(c => c.name.toLowerCase().startsWith(accNameClean));
        }

        // Try contains match
        if (!match && accNameClean.length >= 5) {
          match = candidates.find(c => c.name.toLowerCase().includes(accNameClean) ||
                                       accNameClean.includes(c.name.toLowerCase()));
        }

        // Try vendor SKU prefix matching (e.g. TTBEIG → products with TBEIG or similar)
        if (!match) {
          const accSkuBase = acc.vendor_sku.replace(/^TT/, 'T')
            .replace(/[-_]?PAT[-_]?.*$/i, '')
            .replace(/\d{4,}.*$/i, '')
            .replace(/[-_]?(HF|HUCB|HUFC|TUM|BN|SB|COR|P|C)$/i, '')
            .toUpperCase();

          if (accSkuBase.length >= 5) {
            for (const cand of candidates) {
              const { rows: candSkus } = await pool.query(
                `SELECT vendor_sku FROM skus WHERE product_id = $1 AND variant_type IS DISTINCT FROM 'accessory' LIMIT 5`,
                [cand.id]
              );
              for (const cs of candSkus) {
                if (cs.vendor_sku.toUpperCase().startsWith(accSkuBase) ||
                    accSkuBase.startsWith(cs.vendor_sku.toUpperCase().slice(0, accSkuBase.length))) {
                  match = cand;
                  break;
                }
              }
              if (match) break;
            }
          }
        }

        // If only one candidate in collection, use it
        if (!match && candidates.length === 1) {
          match = candidates[0];
        }

        if (match) parentProductId = match.id;
      }
    }

    // Also try across collections with same name (for empty-collection accessories)
    if (!parentProductId && accNameClean.length >= 4) {
      const { rows: globalMatch } = await pool.query(`
        SELECT DISTINCT p.id, p.name
        FROM products p
        JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1
          AND LOWER(p.name) = $2
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND p.id != $3
        LIMIT 1
      `, [VENDOR_ID, accNameClean, acc.product_id]);

      if (globalMatch.length > 0) parentProductId = globalMatch[0].id;
    }

    if (parentProductId) {
      // Link to all main SKUs of the parent product
      const { rows: parentSkus } = await pool.query(`
        SELECT id FROM skus
        WHERE product_id = $1 AND variant_type IS DISTINCT FROM 'accessory' AND status = 'active'
      `, [parentProductId]);

      for (const ps of parentSkus) {
        await pool.query(`
          INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [ps.id, acc.acc_sku_id]);
        catchAllLinked++;
      }

      // Move the accessory SKU to the parent product
      await pool.query(`UPDATE skus SET product_id = $1 WHERE id = $2`, [parentProductId, acc.acc_sku_id]);
    } else {
      catchAllUnmatched++;
      log(`    UNMATCHED: ${acc.vendor_sku} "${acc.product_name}" (collection: "${acc.collection}")`);
    }
  }

  log(`  Catch-all: ${catchAllLinked} links created, ${catchAllUnmatched} unmatched`);

  // Clean up empty catch-all products
  const { rows: emptyProducts } = await pool.query(`
    SELECT p.id FROM products p
    WHERE p.vendor_id = $1
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
  `, [VENDOR_ID]);

  if (emptyProducts.length > 0) {
    const ids = emptyProducts.map(r => r.id);
    await pool.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [ids]);
    log(`  Cleaned up ${ids.length} empty products`);
  }

  // Final stats
  const { rows: [stats] } = await pool.query(`
    SELECT
      COUNT(*) AS total_acc,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM sku_accessories sa WHERE sa.accessory_sku_id = s.id)) AS attached
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type = 'accessory' AND s.status = 'active'
  `, [VENDOR_ID]);

  log('');
  log('═'.repeat(60));
  log(`  Total accessories:  ${stats.total_acc}`);
  log(`  Attached:           ${stats.attached}`);
  log(`  Unattached:         ${stats.total_acc - stats.attached}`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
