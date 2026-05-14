#!/usr/bin/env node
/**
 * create-jmv-accessories.cjs
 *
 * Resolves James Martin's `optional_accessories` attribute (comma/semicolon-separated
 * vendor_sku references) into proper `sku_accessories` junction table rows.
 *
 * Also sets `accessory_label` on the referenced SKUs based on their product category
 * (Mirror, Storage Cabinet, Bench, Hutch, etc.).
 *
 * Usage:
 *   node backend/scripts/create-jmv-accessories.cjs --dry-run
 *   node backend/scripts/create-jmv-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Derive a display label for an accessory SKU based on its product name and category.
 */
function deriveLabel(productName, categoryName) {
  const pn = (productName || '').toLowerCase();
  const cn = (categoryName || '').toLowerCase();

  if (cn.includes('mirror') || pn.includes('mirror')) return 'Mirror';
  if (cn.includes('storage') || pn.includes('storage cabinet')) return 'Storage Cabinet';
  if (pn.includes('linen cabinet')) return 'Linen Cabinet';
  if (pn.includes('side cabinet')) return 'Side Cabinet';
  if (pn.includes('drawer unit')) return 'Drawer Unit';
  if (pn.includes('cabinet')) return 'Cabinet';
  if (pn.includes('hutch')) return 'Hutch';
  if (pn.includes('bench')) return 'Bench';
  if (pn.includes('shelf')) return 'Shelf';
  if (pn.includes('countertop')) return 'Countertop Unit';
  if (pn.includes('console base')) return 'Console Base';
  if (pn.includes('console')) return 'Console';
  if (pn.includes('vanity')) return 'Vanity';
  if (cn.includes('vanit')) return 'Vanity';
  if (cn.includes('accessor')) return 'Accessory';
  return productName || 'Accessory';
}

async function main() {
  console.log(`create-jmv-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  // Step 1: Get JMV vendor ID
  const vendorRes = await pool.query(`SELECT id FROM vendors WHERE code = 'JMV'`);
  if (vendorRes.rows.length === 0) {
    console.error('JMV vendor not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Step 2: Clear existing JMV sku_accessories links
  if (!DRY_RUN) {
    const deleted = await pool.query(`
      DELETE FROM sku_accessories
      WHERE parent_sku_id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
      )
    `, [vendorId]);
    console.log(`Cleared ${deleted.rowCount} existing JMV sku_accessories links`);
  }

  // Step 3: Load all JMV SKUs with optional_accessories attribute
  const optAccResult = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.internal_sku,
      p.name as product_name, sa.value as optional_accessories
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'optional_accessories'
    JOIN skus s ON s.id = sa.sku_id AND s.status = 'active'
    JOIN products p ON p.id = s.product_id AND p.status = 'active'
    WHERE p.vendor_id = $1
    ORDER BY s.internal_sku
  `, [vendorId]);

  console.log(`Found ${optAccResult.rows.length} JMV SKUs with optional_accessories`);

  // Step 4: Build a lookup map of vendor_sku → SKU details for all active JMV SKUs
  const skuLookup = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.variant_type,
      p.name as product_name, c.name as category_name
    FROM skus s
    JOIN products p ON p.id = s.product_id AND p.status = 'active'
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  const skuMap = new Map();
  for (const row of skuLookup.rows) {
    skuMap.set(row.vendor_sku, row);
  }
  console.log(`Loaded ${skuMap.size} active JMV SKUs for lookup`);

  // Step 5: Process optional_accessories references
  const linkBatch = []; // [parent_sku_id, accessory_sku_id, sort_order]
  const labelSet = new Map(); // sku_id → label (deduped)
  let resolvedCount = 0;
  let unresolvedCount = 0;
  const unresolvedSamples = new Set();

  for (const row of optAccResult.rows) {
    // Split on commas and semicolons
    const refs = row.optional_accessories
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    let sortOrder = 0;
    for (const ref of refs) {
      // Skip non-SKU references (series names, collection names — contain spaces with no dashes)
      if (!ref.includes('-') && ref.includes(' ')) {
        continue;
      }

      const target = skuMap.get(ref);
      if (target) {
        // Don't link a SKU to itself
        if (target.id === row.sku_id) continue;

        linkBatch.push([row.sku_id, target.id, sortOrder++]);
        resolvedCount++;

        // Set label based on target product/category
        const label = deriveLabel(target.product_name, target.category_name);
        labelSet.set(target.id, label);
      } else {
        unresolvedCount++;
        if (unresolvedSamples.size < 30) unresolvedSamples.add(ref);
      }
    }
  }

  console.log(`\nResolved: ${resolvedCount} links`);
  console.log(`Unresolved: ${unresolvedCount} references (items likely inactive/not imported)`);
  if (unresolvedSamples.size > 0) {
    console.log(`Sample unresolved refs: ${Array.from(unresolvedSamples).slice(0, 15).join(', ')}`);
  }

  // Deduplicate links (same parent+acc pair, keep lowest sort_order)
  const dedupLinks = new Map();
  for (const [parent, acc, sort] of linkBatch) {
    const key = `${parent}|${acc}`;
    if (!dedupLinks.has(key) || dedupLinks.get(key)[2] > sort) {
      dedupLinks.set(key, [parent, acc, sort]);
    }
  }
  const finalLinks = Array.from(dedupLinks.values());
  console.log(`Deduplicated: ${finalLinks.length} unique links (from ${linkBatch.length} raw)`);
  console.log(`Labels to set: ${labelSet.size}`);

  if (DRY_RUN) {
    console.log('\nSample links (first 20):');
    for (const [parent, acc, sort] of finalLinks.slice(0, 20)) {
      const parentSku = optAccResult.rows.find(r => r.sku_id === parent);
      const accInfo = skuLookup.rows.find(r => r.id === acc);
      console.log(`  ${parentSku?.internal_sku || parent} → ${accInfo?.vendor_sku || acc} (${accInfo?.product_name}) [sort: ${sort}]`);
    }
    console.log('\nSample labels (first 20):');
    for (const [skuId, label] of Array.from(labelSet.entries()).slice(0, 20)) {
      const info = skuLookup.rows.find(r => r.id === skuId);
      console.log(`  ${info?.vendor_sku || skuId} → "${label}" (${info?.product_name})`);
    }
  } else {
    // Step 6: Write links in batches
    console.log('\nWriting sku_accessories links...');
    const BATCH_SIZE = 500;
    let written = 0;
    for (let i = 0; i < finalLinks.length; i += BATCH_SIZE) {
      const batch = finalLinks.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      for (let j = 0; j < batch.length; j++) {
        const offset = j * 3;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        params.push(batch[j][0], batch[j][1], batch[j][2]);
      }
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ${values.join(', ')}
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
      `, params);
      written += batch.length;
      if (written % 2000 === 0 || written === finalLinks.length) {
        console.log(`  ${written}/${finalLinks.length} links written`);
      }
    }

    // Step 7: Write labels
    console.log('Writing accessory_label values...');
    const labelEntries = Array.from(labelSet.entries());
    for (let i = 0; i < labelEntries.length; i += BATCH_SIZE) {
      const batch = labelEntries.slice(i, i + BATCH_SIZE);
      const ids = batch.map(b => b[0]);
      const caseLines = batch.map((b, j) => `WHEN id = $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ');
      const params = [];
      for (const [skuId, label] of batch) {
        params.push(skuId, label);
      }
      await pool.query(`
        UPDATE skus SET accessory_label = CASE ${caseLines} END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($${params.length + 1})
      `, [...params, ids]);
    }
    console.log(`  ${labelEntries.length} labels written`);

    // Step 8: Summary
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM sku_accessories sa
      JOIN skus s ON s.id = sa.parent_sku_id
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
    `, [vendorId]);
    console.log(`\nTotal JMV sku_accessories links: ${countResult.rows[0].count}`);

    const labelCount = await pool.query(`
      SELECT accessory_label, COUNT(*) as cnt FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND accessory_label IS NOT NULL
      GROUP BY accessory_label ORDER BY cnt DESC
    `, [vendorId]);
    console.log('Labels:');
    for (const r of labelCount.rows) {
      console.log(`  ${r.accessory_label}: ${r.cnt} SKUs`);
    }
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
