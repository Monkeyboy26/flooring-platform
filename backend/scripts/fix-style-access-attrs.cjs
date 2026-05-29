/**
 * Fix Style Access SKU attributes: color, finish, size.
 *
 * The import script (import-style-access.js line 444) originally stored the
 * full description as the `color` attribute (e.g., "Sage Swing Satin" instead
 * of "Sage"). This caused the storefront to render each variant as a separate
 * color swatch instead of grouping by finish.
 *
 * Fixes applied per SKU:
 *   1. color  → getBaseColor(current_color_value)  (strip finish/pattern tokens)
 *   2. finish → extractFinish(current_color_value)  (surface pattern + qualifier)
 *   3. size   → copy from existing width attribute   (for size pill rendering)
 *
 * Run: docker compose exec api node scripts/fix-style-access-attrs.cjs [--dry-run]
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

function extractFinish(desc) {
  const tokens = [];
  for (const p of ['Flat', 'Dixie', 'Charleston', 'Swing']) {
    if (new RegExp('\\b' + p + '\\b', 'i').test(desc)) tokens.push(p);
  }
  if (/\bFlower\s+Deco\b/i.test(desc)) tokens.push('Flower Deco');
  else if (/\bDeco\b/i.test(desc)) tokens.push('Deco');
  for (const l of ['Brick Joint', 'Cross Hatch']) {
    if (new RegExp('\\b' + l + '\\b', 'i').test(desc)) tokens.push(l);
  }
  for (const q of ['Gloss', 'Satin', 'Matte']) {
    if (new RegExp('\\b' + q + '\\b', 'i').test(desc)) tokens.push(q);
  }
  return tokens.length ? tokens.join(' ') : null;
}

// --- End copied functions ---

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up attribute IDs
    const attrRows = (await client.query(
      `SELECT id, slug FROM attributes WHERE slug IN ('color', 'finish', 'size', 'width')`
    )).rows;
    const attrId = {};
    for (const r of attrRows) attrId[r.slug] = r.id;

    if (!attrId.color) { console.error('No "color" attribute found!'); return; }
    if (!attrId.finish) { console.error('No "finish" attribute found!'); return; }
    if (!attrId.size) { console.error('No "size" attribute found!'); return; }

    console.log(`=== Fix Style Access Attributes ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);
    console.log(`Attribute IDs — color: ${attrId.color}, finish: ${attrId.finish}, size: ${attrId.size}, width: ${attrId.width || '(missing)'}\n`);

    // Get all Style Access SKUs with current color attribute
    const { rows: skuRows } = await client.query(`
      SELECT s.id AS sku_id, s.variant_name, p.name AS product_name, p.collection,
             sa_color.value AS old_color,
             sa_width.value AS width_value
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN sku_attributes sa_color ON sa_color.sku_id = s.id AND sa_color.attribute_id = $1
      LEFT JOIN sku_attributes sa_width ON sa_width.sku_id = s.id AND sa_width.attribute_id = $2
      WHERE v.code = 'STYLEACCESS'
      ORDER BY p.collection, p.name, s.variant_name
    `, [attrId.color, attrId.width || attrId.color]);

    let colorFixed = 0, finishAdded = 0, sizeAdded = 0, skipped = 0;

    for (const row of skuRows) {
      const oldColor = row.old_color;
      if (!oldColor) { skipped++; continue; }

      const newColor = getBaseColor(oldColor);
      const finish = extractFinish(oldColor);

      const colorChanged = newColor !== oldColor;
      if (!colorChanged && !finish && !row.width_value) { skipped++; continue; }

      console.log(`  ${row.collection} / ${row.product_name} / ${row.variant_name}`);

      // 1. Fix color
      if (colorChanged) {
        console.log(`    color: "${oldColor}" → "${newColor}"`);
        if (!DRY_RUN) {
          await client.query(
            `UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3`,
            [newColor, row.sku_id, attrId.color]
          );
        }
        colorFixed++;
      }

      // 2. Upsert finish
      if (finish) {
        console.log(`    finish: → "${finish}"`);
        if (!DRY_RUN) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [row.sku_id, attrId.finish, finish]);
        }
        finishAdded++;
      }

      // 3. Upsert size (copy from width)
      if (row.width_value && attrId.size) {
        console.log(`    size: → "${row.width_value}"`);
        if (!DRY_RUN) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [row.sku_id, attrId.size, row.width_value]);
        }
        sizeAdded++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total Style Access SKUs: ${skuRows.length}`);
    console.log(`Colors fixed: ${colorFixed}`);
    console.log(`Finishes added: ${finishAdded}`);
    console.log(`Sizes added: ${sizeAdded}`);
    console.log(`Skipped (no change needed): ${skipped}`);

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
