#!/usr/bin/env node
/**
 * Emser Tile — Data Cleanup Script
 *
 * 1. Set display_name = name for all products
 * 2. Generate description_long for active products
 * 3. Backfill Finish attribute from product names
 */
import pg from 'pg';
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const VENDOR_CODE = 'EMSER';

// ── Step 1: Set display_name ─────────────────────────────────────────────────

async function fixDisplayNames() {
  console.log('Step 1: Setting display_name...');
  const res = await pool.query(`
    UPDATE products SET display_name = name
    WHERE vendor_id = (SELECT id FROM vendors WHERE code = $1)
      AND (display_name IS NULL OR display_name = '')
  `, [VENDOR_CODE]);
  console.log(`  Updated ${res.rowCount} products\n`);
}

// ── Step 2: Generate description_long ────────────────────────────────────────

async function generateDescriptions() {
  console.log('Step 2: Generating description_long for active products...');

  const products = await pool.query(`
    SELECT p.id, p.name, p.collection, c.name as category,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'size' AND sa.value != '0x0FT')
       as sizes,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'color' AND sa.value != 'XXX')
       as colors,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'finish')
       as finishes,
      (SELECT COUNT(*)::int FROM skus s2 WHERE s2.product_id = p.id AND s2.variant_type = 'accessory') as acc_skus,
      (SELECT s2.sell_by FROM skus s2 WHERE s2.product_id = p.id AND s2.variant_type IS DISTINCT FROM 'accessory' LIMIT 1) as sell_by
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = $1 AND p.status = 'active'
    ORDER BY p.name
  `, [VENDOR_CODE]);

  const catInfo = {
    'Porcelain Tile': {
      material: 'porcelain',
      intro: 'engineered from refined clay fired at extreme temperatures for superior strength and minimal water absorption',
      uses: 'floors, walls, showers, countertops, and outdoor areas',
      durability: 'Frost-proof, stain-resistant, and built to withstand heavy foot traffic',
    },
    'Ceramic Tile': {
      material: 'ceramic',
      intro: 'crafted from natural clay with a durable glazed surface for lasting beauty',
      uses: 'walls, backsplashes, bathroom surrounds, and light-duty flooring',
      durability: 'Easy to cut and install with excellent color retention over time',
    },
    'Natural Stone': {
      material: 'natural stone',
      intro: 'quarried from genuine stone with unique veining and natural character that makes every piece one-of-a-kind',
      uses: 'floors, walls, fireplace surrounds, outdoor patios, and luxury bath installations',
      durability: 'Timeless and durable with proper sealing and care',
    },
    'Mosaic Tile': {
      material: 'mosaic',
      intro: 'precision-cut pieces arranged on mesh backing for easy installation and striking visual impact',
      uses: 'backsplashes, shower floors and walls, accent features, and decorative borders',
      durability: 'Versatile and durable with consistent grout spacing for professional results',
    },
  };

  // Detect if a product name looks like a sundry/accessory (not a tile)
  const sundryPattern = /edge protector|shower pan|shower bench|foam board|drain|mesh tape|niche|ramp|carpet trim|reducer trim|quarter circle|coupler|caulk|grout|sealer|mortar|adhesive|membrane|backer/i;

  let updated = 0;
  for (const p of products.rows) {
    const cat = catInfo[p.category] || catInfo['Porcelain Tile'];
    const isSundry = sundryPattern.test(p.name) || sundryPattern.test(p.collection);

    let desc;
    if (isSundry) {
      // Sundry/accessory — simpler description
      desc = `${p.name} by Emser Tile. A professional-grade installation accessory designed for use with tile, stone, and related surface installations. Manufactured to exacting standards for reliable performance on every project.`;
    } else {
      // Tile product — rich description
      const collection = p.collection || p.name;
      desc = `The ${collection} collection by Emser Tile features premium ${cat.material} tile ${cat.intro}.`;

      const sizes = (p.sizes || []).filter(s => s && s !== '0x0FT');
      const colors = (p.colors || []).filter(c => c && c !== 'XXX');
      const finishes = (p.finishes || []);

      if (sizes.length > 0 || colors.length > 0 || finishes.length > 0) {
        const parts = [];
        if (sizes.length > 0) parts.push(`${sizes.join(', ')} format${sizes.length > 1 ? 's' : ''}`);
        if (colors.length > 0 && colors.length <= 6) parts.push(`${colors.join(', ')} colorway${colors.length > 1 ? 's' : ''}`);
        else if (colors.length > 6) parts.push(`${colors.length} colorways`);
        if (finishes.length > 0) parts.push(`a ${finishes.join(' and ')} finish`);
        desc += ` Available in ${parts.join(' and ')}.`;
      }

      desc += ` Ideal for ${cat.uses}. ${cat.durability}.`;

      if (p.acc_skus > 0) {
        desc += ` Coordinating trim and finishing pieces available for a complete installation.`;
      }
    }

    await pool.query('UPDATE products SET description_long = $1 WHERE id = $2', [desc, p.id]);
    updated++;
  }
  console.log(`  Generated descriptions for ${updated} active products\n`);
}

// ── Step 3: Backfill Finish attribute from product names ─────────────────────

async function backfillFinish() {
  console.log('Step 3: Backfilling Finish attribute from product names...');

  const finishAttr = await pool.query("SELECT id FROM attributes WHERE slug = 'finish'");
  if (!finishAttr.rows.length) {
    console.log('  Finish attribute not found, skipping\n');
    return;
  }
  const finishId = finishAttr.rows[0].id;

  // Find SKUs without finish that have a finish keyword in their product name
  const skus = await pool.query(`
    SELECT s.id as sku_id, p.name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
      AND NOT EXISTS (
        SELECT 1 FROM sku_attributes sa WHERE sa.sku_id = s.id AND sa.attribute_id = $2
      )
      AND (p.name ~* '\\m(matte|glossy|gloss|polished|honed|lappato|satin|textured|structured|natural|rectified)\\M')
  `, [VENDOR_CODE, finishId]);

  const finishMap = [
    [/\bmatte\b/i, 'Matte'],
    [/\bglossy?\b/i, 'Gloss'],
    [/\bpolished\b/i, 'Polished'],
    [/\bhoned\b/i, 'Honed'],
    [/\blappato\b/i, 'Lappato'],
    [/\bsatin\b/i, 'Satin'],
    [/\btextured\b/i, 'Textured'],
    [/\bstructured\b/i, 'Structured'],
    [/\bnatural\b/i, 'Natural'],
  ];

  let added = 0;
  for (const sku of skus.rows) {
    for (const [pattern, value] of finishMap) {
      if (pattern.test(sku.name)) {
        try {
          await pool.query(
            'INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [sku.sku_id, finishId, value]
          );
          added++;
        } catch { /* skip duplicates */ }
        break; // Only first match
      }
    }
  }
  console.log(`  Added Finish attribute to ${added} SKUs\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log('Emser Tile — Data Cleanup');
  console.log(`${'='.repeat(50)}\n`);

  await fixDisplayNames();
  await generateDescriptions();
  await backfillFinish();

  // Verify
  const verify = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN display_name IS NOT NULL AND display_name != '' THEN 1 END) as has_display,
      COUNT(CASE WHEN description_long IS NOT NULL AND description_long != '' THEN 1 END) as has_desc,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
  `, [VENDOR_CODE]);
  const v = verify.rows[0];
  console.log(`${'='.repeat(50)}`);
  console.log(`Total products: ${v.total}`);
  console.log(`With display_name: ${v.has_display}`);
  console.log(`With description_long: ${v.has_desc}`);
  console.log(`Active: ${v.active}`);
  console.log(`${'='.repeat(50)}\n`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
