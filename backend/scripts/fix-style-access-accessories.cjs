/**
 * Fix Style Access accessory labels + sku_accessories mappings.
 *
 * Issues addressed:
 *   1. accessory_label is NULL on most accessory SKUs — derive from variant_name
 *      by stripping trailing "(size)" parenthetical
 *   2. sku_accessories table has almost no mappings — link each accessory to
 *      parent (non-accessory) SKUs in the same collection by matching base color
 *
 * Run: docker compose exec api node scripts/fix-style-access-accessories.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// --- Copied from import-style-access.js (kept in sync) ---

function getBaseColor(desc) {
  return desc
    .replace(/\b(Jolly|geometric|jolly|Trim|BN|Universal|OG|NHU)\b/gi, '')
    .replace(/\b(Flat|Dixie|Charleston|Swing)\b/gi, '')
    .replace(/\b(undulated|Undulated|extruded|pressed|antislip)\b/gi, '')
    .replace(/\bglazed\s+pol\.?\b/gi, '')
    .replace(/\bfinish\s+R\d+\b/gi, '')
    .replace(/\b(Flower\s+Deco|Deco|Audrey\s+D[eé]cor|Chloe\s+D[eé]cor)\b/gi, '')
    .replace(/\b(Gloss|Satin|Matte|matte|gloss|satin)\b/gi, '')
    .replace(/\b(Brick\s+Joint|loose|Cross\s+Hatch)\b/gi, '')
    .replace(/\b\d+in\b/gi, '')
    .replace(/\b\d+x\d+\b/gi, '')
    .replace(/[,.'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- End copied functions ---

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up vendor
    const { rows: vendorRows } = await client.query(
      `SELECT id FROM vendors WHERE code = 'STYLEACCESS'`
    );
    if (!vendorRows.length) { console.error('Vendor STYLEACCESS not found!'); return; }
    const vendorId = vendorRows[0].id;

    // Look up color attribute ID
    const { rows: attrRows } = await client.query(
      `SELECT id FROM attributes WHERE slug = 'color'`
    );
    const colorAttrId = attrRows[0]?.id;
    if (!colorAttrId) { console.error('No "color" attribute found!'); return; }

    console.log(`=== Fix Style Access Accessories ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

    // 1. Query all Style Access accessory SKUs
    const { rows: accessories } = await client.query(`
      SELECT s.id AS sku_id, s.variant_name, s.accessory_label,
             s.product_id, p.collection,
             sa_color.value AS color_value
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_color ON sa_color.sku_id = s.id AND sa_color.attribute_id = $1
      WHERE v.id = $2
        AND s.variant_type = 'accessory'
      ORDER BY p.collection, s.variant_name
    `, [colorAttrId, vendorId]);

    console.log(`Found ${accessories.length} accessory SKUs\n`);

    // 2. Query all non-accessory (parent) SKUs for matching
    const { rows: parents } = await client.query(`
      SELECT s.id AS sku_id, s.variant_name, s.product_id, p.collection,
             sa_color.value AS color_value
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_color ON sa_color.sku_id = s.id AND sa_color.attribute_id = $1
      WHERE v.id = $2
        AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
        AND s.status = 'active'
      ORDER BY p.collection, s.variant_name
    `, [colorAttrId, vendorId]);

    // Group parents by collection for efficient lookup
    const parentsByCollection = new Map();
    for (const p of parents) {
      if (!p.collection) continue;
      if (!parentsByCollection.has(p.collection)) parentsByCollection.set(p.collection, []);
      parentsByCollection.get(p.collection).push(p);
    }

    let labelsSet = 0, mappingsCreated = 0, orphans = 0;

    for (const acc of accessories) {
      const vn = acc.variant_name || '';

      // 2a. Derive accessory_label: strip trailing "(size)" from variant_name
      const label = vn.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (label && label !== acc.accessory_label) {
        console.log(`  LABEL: "${vn}" -> "${label}"`);
        if (!DRY_RUN) {
          await client.query(
            `UPDATE skus SET accessory_label = $1 WHERE id = $2`,
            [label, acc.sku_id]
          );
        }
        labelsSet++;
      }

      // 2b. Find parent SKUs in same collection by matching base color
      const accColor = acc.color_value || vn;
      const accBase = getBaseColor(accColor).toLowerCase();

      const collParents = parentsByCollection.get(acc.collection) || [];
      let foundParent = false;

      for (const parent of collParents) {
        const parentColor = parent.color_value || parent.variant_name || '';
        const parentBase = getBaseColor(parentColor).toLowerCase();

        if (accBase && parentBase && accBase === parentBase) {
          console.log(`  MAP: "${vn}" -> parent "${parent.variant_name}" [${acc.collection}]`);
          if (!DRY_RUN) {
            await client.query(`
              INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
              VALUES ($1, $2, 0)
              ON CONFLICT DO NOTHING
            `, [parent.sku_id, acc.sku_id]);
          }
          mappingsCreated++;
          foundParent = true;
        }
      }

      if (!foundParent) {
        console.log(`  ORPHAN: "${vn}" [${acc.collection}] (base="${accBase}")`);
        orphans++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total accessory SKUs: ${accessories.length}`);
    console.log(`Labels set: ${labelsSet}`);
    console.log(`Mappings created: ${mappingsCreated}`);
    console.log(`Orphans (no parent match): ${orphans}`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('\nDone! Restart API to see changes: docker compose restart api');
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
