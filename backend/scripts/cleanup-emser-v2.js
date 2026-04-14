#!/usr/bin/env node
/**
 * Emser Tile — Comprehensive Data Cleanup v2
 *
 * 1. Clean display_names (strip EDI junk: Pc/Ct, Mm, Buy Mult, Mattepor, Sbn, etc.)
 * 2. Title Case variant_names (ALL CAPS → Title Case)
 * 3. Title Case color attributes (remaining ALL CAPS → Title Case)
 * 4. Fix size attributes (0.03x0.06FT → 3"x6")
 * 5. Fix "ii" → "II" in display_names and collection names
 * 6. Delete 5,308 inactive product clutter
 * 7. Regenerate description_long for all active products
 *
 * Usage: docker compose exec api node scripts/cleanup-emser-v2.js [--dry-run]
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_CODE = 'EMSER';

// ── Helpers ─────────────────────────────────────────────────────────────────

function titleCase(s) {
  if (!s) return s;
  return s.toLowerCase().split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function cleanDisplayName(name) {
  let s = name;
  // Remove leading "Bb " prefix
  s = s.replace(/^Bb\s+/i, '');
  // Replace compound abbreviations BEFORE stripping Mm/numbers
  s = s.replace(/Mattepor\b/gi, 'Matte');
  s = s.replace(/Mattex(?=\d)/gi, 'Matte ');  // Mattex8.4 → Matte 8.4
  s = s.replace(/Mattex\b/gi, 'Matte');
  s = s.replace(/Glossypor\b/gi, 'Glossy');
  s = s.replace(/Sbnpor\b/gi, 'Bullnose');
  s = s.replace(/\bSbn\b/gi, 'Bullnose');
  s = s.replace(/\bCm$/i, '');  // trailing "Cm"
  s = s.replace(/\bV2$/i, '');  // trailing "V2"
  // Remove "Single Designcm" and "Single Design"
  s = s.replace(/Single\s*Designcm/gi, '');
  s = s.replace(/Single\s*Design/gi, '');
  // Remove "Thickness" (before Mm so it doesn't leave "ness")
  s = s.replace(/\s*Thickness\b/gi, '');
  // Remove Mm measurements: "8.0 Mm", "7.5mm" etc — but NOT when part of mm/mil (5mm/12mil)
  s = s.replace(/\d+\.?\d*\s*[Mm][Mm](?!\/)/g, '');
  // Remove "Thick" standalone
  s = s.replace(/\s+Thick\b/gi, '');
  // Remove "XX Pc/Ct", "XXpc/Ct"
  s = s.replace(/\s*\d+\s*[Pp]c\/[Cc]t/g, '');
  // Remove "XX.XX Sf/Ct"
  s = s.replace(/\s*[0-9.]+\s*[Ss]f\/[Cc]t/g, '');
  // Remove "XX.XX Sf/Pc"
  s = s.replace(/\s*[0-9.]+\s*[Ss]f\/[Pp]c/g, '');
  // Remove "Buy MultXX.XX"
  s = s.replace(/\s*Buy\s*Mult[0-9.]+/gi, '');
  // Remove "/12x12" from "Mosaic/12x12"
  s = s.replace(/\/\d+x\d+/g, '');
  // Fix "ii" → "II" for series names
  s = s.replace(/\bii\b/g, 'II');
  // Collapse multiple spaces and trim
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * Convert Emser's encoded size format to readable inches.
 * Format: "0.03x0.06FT" where small values (< 1) are hundredths (×100 → inches)
 * and larger values (≥ 1) are in feet (×12 → inches).
 */
function convertSize(sizeStr) {
  if (!sizeStr) return sizeStr;
  const m = sizeStr.match(/^([0-9.]+)x([0-9.]+)FT$/i);
  if (!m) return sizeStr;

  const toInches = (val) => {
    const n = parseFloat(val);
    if (n < 1) {
      // Small values are hundredths → inches
      const inches = Math.round(n * 100 * 10) / 10; // round to 1 decimal
      // Convert common fractions
      if (inches === 0.5) return '1/2';
      if (inches === 0.25) return '1/4';
      if (inches === 0.75) return '3/4';
      // Clean integer display
      if (Number.isInteger(inches)) return String(inches);
      return String(inches);
    } else {
      // Values ≥ 1 are in feet → convert to inches
      const inches = Math.round(n * 12 * 10) / 10;
      if (Number.isInteger(inches)) return String(inches);
      // Round to nearest standard tile size
      const rounded = Math.round(inches);
      // Check if within 1" of a common size (12, 18, 24, 36, 48)
      const common = [6, 8, 10, 12, 13, 16, 18, 20, 24, 32, 36, 47, 48];
      const nearest = common.find(c => Math.abs(inches - c) < 1.5);
      return String(nearest || rounded);
    }
  };

  const w = toInches(m[1]);
  const h = toInches(m[2]);
  return `${w}"x${h}"`;
}

// ── Step 1: Clean display_names ─────────────────────────────────────────────

async function cleanDisplayNames() {
  console.log('Step 1: Cleaning display_names...');

  const products = await pool.query(`
    SELECT p.id, p.name, p.display_name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1 AND p.status = 'active'
  `, [VENDOR_CODE]);

  let updated = 0;
  for (const p of products.rows) {
    const cleaned = cleanDisplayName(p.name);
    if (cleaned !== p.display_name && cleaned !== '') {
      if (!DRY_RUN) {
        await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [cleaned, p.id]);
      }
      if (cleaned !== p.name) {
        console.log(`  "${p.name}" → "${cleaned}"`);
      }
      updated++;
    }
  }
  console.log(`  Updated ${updated} display_names\n`);
}

// ── Step 2: Title Case variant_names ────────────────────────────────────────

async function fixVariantNames() {
  console.log('Step 2: Title Casing variant_names...');

  const res = DRY_RUN
    ? await pool.query(`
        SELECT COUNT(*) as cnt FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = $1 AND p.status = 'active'
          AND s.variant_name = UPPER(s.variant_name) AND LENGTH(s.variant_name) > 1
      `, [VENDOR_CODE])
    : await pool.query(`
        UPDATE skus SET variant_name = INITCAP(LOWER(variant_name))
        WHERE variant_name = UPPER(variant_name) AND LENGTH(variant_name) > 1
          AND product_id IN (
            SELECT p.id FROM products p JOIN vendors v ON v.id = p.vendor_id
            WHERE v.code = $1 AND p.status = 'active'
          )
      `, [VENDOR_CODE]);

  const count = DRY_RUN ? res.rows[0].cnt : res.rowCount;
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} ${count} variant_names\n`);
}

// ── Step 3: Title Case color attributes ─────────────────────────────────────

async function fixColorAttributes() {
  console.log('Step 3: Title Casing color attributes...');

  const res = DRY_RUN
    ? await pool.query(`
        SELECT COUNT(*) as cnt FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        JOIN skus s ON s.id = sa.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE a.slug = 'color' AND v.code = $1 AND p.status = 'active'
          AND sa.value = UPPER(sa.value) AND LENGTH(sa.value) > 1
      `, [VENDOR_CODE])
    : await pool.query(`
        UPDATE sku_attributes SET value = INITCAP(LOWER(value))
        WHERE value = UPPER(value) AND LENGTH(value) > 1
          AND attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
          AND sku_id IN (
            SELECT s.id FROM skus s JOIN products p ON p.id = s.product_id
            JOIN vendors v ON v.id = p.vendor_id
            WHERE v.code = $1 AND p.status = 'active'
          )
      `, [VENDOR_CODE]);

  const count = DRY_RUN ? res.rows[0].cnt : res.rowCount;
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} ${count} color attributes\n`);
}

// ── Step 4: Fix size attributes ─────────────────────────────────────────────

async function fixSizeAttributes() {
  console.log('Step 4: Fixing size attributes...');

  const sizes = await pool.query(`
    SELECT DISTINCT sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE a.slug = 'size' AND v.code = $1 AND p.status = 'active'
      AND sa.value LIKE '%FT'
    ORDER BY sa.value
  `, [VENDOR_CODE]);

  let updated = 0;
  for (const row of sizes.rows) {
    const converted = convertSize(row.value);
    if (converted !== row.value) {
      if (!DRY_RUN) {
        await pool.query(`
          UPDATE sku_attributes SET value = $1
          WHERE value = $2
            AND attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
            AND sku_id IN (
              SELECT s.id FROM skus s JOIN products p ON p.id = s.product_id
              JOIN vendors v ON v.id = p.vendor_id WHERE v.code = $3
            )
        `, [converted, row.value, VENDOR_CODE]);
      }
      console.log(`  "${row.value}" → "${converted}"`);
      updated++;
    }
  }
  console.log(`  ${DRY_RUN ? 'Would convert' : 'Converted'} ${updated} distinct size values\n`);
}

// ── Step 5: Fix "ii" → "II" in collections ──────────────────────────────────

async function fixCollectionCase() {
  console.log('Step 5: Fixing collection names...');

  const res = DRY_RUN
    ? await pool.query(`
        SELECT COUNT(*) as cnt FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = $1 AND p.collection ~ '\\mIi\\M|\\mii\\M'
      `, [VENDOR_CODE])
    : await pool.query(`
        UPDATE products SET collection = REGEXP_REPLACE(collection, '\\mii\\M', 'II', 'g')
        WHERE vendor_id = (SELECT id FROM vendors WHERE code = $1)
          AND collection ~ '\\mii\\M'
      `, [VENDOR_CODE]);

  const count = DRY_RUN ? res.rows[0].cnt : res.rowCount;
  console.log(`  ${DRY_RUN ? 'Would fix' : 'Fixed'} ${count} collection names\n`);
}

// ── Step 6: Delete inactive product clutter ─────────────────────────────────

async function deleteInactiveClutter() {
  console.log('Step 6: Deleting inactive product clutter...');

  const inactiveRes = await pool.query(`
    SELECT p.id FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1 AND p.status = 'inactive'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')
  `, [VENDOR_CODE]);

  const ids = inactiveRes.rows.map(r => r.id);
  console.log(`  Found ${ids.length} inactive products with no active SKUs`);

  if (ids.length > 0 && !DRY_RUN) {
    // Delete in FK dependency order, in batches
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [batch]);
      await pool.query(`DELETE FROM pricing WHERE sku_id IN (SELECT id FROM skus WHERE product_id = ANY($1))`, [batch]);
      await pool.query(`DELETE FROM sku_attributes WHERE sku_id IN (SELECT id FROM skus WHERE product_id = ANY($1))`, [batch]);
      await pool.query(`DELETE FROM packaging WHERE sku_id IN (SELECT id FROM skus WHERE product_id = ANY($1))`, [batch]);
      await pool.query(`DELETE FROM inventory_snapshots WHERE sku_id IN (SELECT id FROM skus WHERE product_id = ANY($1))`, [batch]);
      await pool.query('DELETE FROM skus WHERE product_id = ANY($1)', [batch]);
      await pool.query('DELETE FROM products WHERE id = ANY($1)', [batch]);
      console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1} (${batch.length} products)`);
    }
  }

  console.log(`  ${DRY_RUN ? 'Would delete' : 'Deleted'} ${ids.length} inactive products\n`);
}

// ── Step 7: Regenerate description_long ──────────────────────────────────────

async function regenerateDescriptions() {
  console.log('Step 7: Regenerating description_long...');

  const products = await pool.query(`
    SELECT p.id, COALESCE(p.display_name, p.name) as name, p.collection, c.name as category,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'size'
         AND s2.variant_type IS DISTINCT FROM 'accessory') as sizes,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'color'
         AND s2.variant_type IS DISTINCT FROM 'accessory') as colors,
      (SELECT array_agg(DISTINCT sa.value ORDER BY sa.value)
       FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE s2.product_id = p.id AND a.slug = 'finish') as finishes,
      (SELECT COUNT(*)::int FROM skus s2
       WHERE s2.product_id = p.id AND s2.variant_type = 'accessory') as acc_skus,
      (SELECT s2.sell_by FROM skus s2
       WHERE s2.product_id = p.id AND s2.variant_type IS DISTINCT FROM 'accessory' LIMIT 1) as sell_by
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
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
    'Luxury Vinyl': {
      material: 'luxury vinyl plank',
      intro: 'designed with a rigid core and realistic wood or stone visuals for effortless style',
      uses: 'living rooms, bedrooms, kitchens, and commercial spaces',
      durability: 'Waterproof, scratch-resistant, and comfortable underfoot',
    },
  };

  const sundryPattern = /edge protector|shower pan|shower bench|foam board|drain|mesh tape|niche|ramp|carpet trim|reducer trim|quarter circle|coupler|caulk|grout|sealer|mortar|adhesive|membrane|backer|elevel clip|jolly liner/i;

  let updated = 0;
  for (const p of products.rows) {
    const cat = catInfo[p.category] || catInfo['Porcelain Tile'];
    const isSundry = sundryPattern.test(p.name) || sundryPattern.test(p.collection);

    let desc;
    if (isSundry) {
      desc = `${p.name} by Emser Tile. A professional-grade installation accessory designed for use with tile, stone, and related surface installations. Manufactured to exacting standards for reliable performance on every project.`;
    } else {
      const collection = p.collection || p.name;
      desc = `The ${collection} collection by Emser Tile features premium ${cat.material} tile ${cat.intro}.`;

      const sizes = (p.sizes || []).filter(s => s);
      const colors = (p.colors || []).filter(c => c);
      const finishes = (p.finishes || []);

      if (sizes.length > 0 || colors.length > 0 || finishes.length > 0) {
        const parts = [];
        if (sizes.length > 0 && sizes.length <= 6) parts.push(`${sizes.join(', ')} format${sizes.length > 1 ? 's' : ''}`);
        else if (sizes.length > 6) parts.push(`${sizes.length} sizes`);
        if (colors.length > 0 && colors.length <= 6) parts.push(`${colors.join(', ')} colorway${colors.length > 1 ? 's' : ''}`);
        else if (colors.length > 6) parts.push(`${colors.length} colorways`);
        if (finishes.length > 0) parts.push(`a ${finishes.join(' and ')} finish`);
        if (parts.length > 0) desc += ` Available in ${parts.join(' and ')}.`;
      }

      desc += ` Ideal for ${cat.uses}. ${cat.durability}.`;

      if (p.acc_skus > 0) {
        desc += ` Coordinating trim and finishing pieces available for a complete installation.`;
      }
    }

    if (!DRY_RUN) {
      await pool.query('UPDATE products SET description_long = $1 WHERE id = $2', [desc, p.id]);
    }
    updated++;
  }
  console.log(`  ${DRY_RUN ? 'Would regenerate' : 'Regenerated'} ${updated} descriptions\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(55)}`);
  console.log(`Emser Tile — Comprehensive Cleanup v2${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`${'='.repeat(55)}\n`);

  await cleanDisplayNames();
  await fixVariantNames();
  await fixColorAttributes();
  await fixSizeAttributes();
  await fixCollectionCase();
  await deleteInactiveClutter();
  await regenerateDescriptions();

  // Final verification
  const verify = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN display_name IS NOT NULL AND display_name != '' THEN 1 END) as has_display,
      COUNT(CASE WHEN description_long IS NOT NULL AND description_long != '' THEN 1 END) as has_desc,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      COUNT(CASE WHEN status = 'draft' THEN 1 END) as draft,
      COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1
  `, [VENDOR_CODE]);
  const v = verify.rows[0];
  console.log(`${'='.repeat(55)}`);
  console.log(`Total products: ${v.total} (active: ${v.active}, draft: ${v.draft}, inactive: ${v.inactive})`);
  console.log(`With display_name: ${v.has_display}`);
  console.log(`With description_long: ${v.has_desc}`);
  console.log(`${'='.repeat(55)}\n`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
