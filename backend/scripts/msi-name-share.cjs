#!/usr/bin/env node
/**
 * MSI Name-Based Image Sharing — Fast SQL-only approach.
 * Groups missing products by base name and copies images from
 * imaged siblings or prefix-matched products.
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function extractBase(name) {
  return name
    .replace(/\s+\d+\s*Mm\b.*/i, '')
    .replace(/\s+\d{4}\s+/g, ' ')
    .replace(/\s+(Matte|Polished|Honed|Glossy|Lappato|Satin|Rectified)\s*$/i, '')
    .replace(/\s+(3d|Mosaic|Bullnose|Hexagon)\s*.*/i, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s.*/i, '')
    .trim();
}

function extractCore(name) {
  return name
    .replace(/\s*(Cop|Pav|Tread|Stepping|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased|Mini|Grande|River|Beach|Boulder|Xl|Hand\s*Cut|Thick|Corners?|Sq\s*&?\s*Rec|Sawn|Ashlar|Veneer|Fieldstone|Premium|Cobbles?).*/i, '')
    .replace(/x\d+.*/i, '')
    .replace(/\s+\d+["']?.*/i, '')
    .replace(/\s+(Ec|Fsn|Osn|Qr|Sr|T|Tl)\s*$/i, '')
    .trim();
}

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, c.name as category
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY c.name, p.display_name
  `, [vid]);
  console.log('Missing:', missing.length);

  // Group by base name
  const groups = new Map();
  for (const m of missing) {
    const b = extractBase(m.display_name);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(m);
  }
  console.log('Unique base names:', groups.size);

  // Load all imaged products
  const { rows: imaged } = await pool.query(`
    SELECT p.id, p.display_name FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vid]);

  const baseToImaged = new Map();
  for (const ip of imaged) {
    const b = extractBase(ip.display_name);
    if (!baseToImaged.has(b)) baseToImaged.set(b, []);
    baseToImaged.get(b).push(ip);
  }

  const needsImage = new Set(missing.map(m => m.id));
  let matched = 0;

  async function copyImages(donorId, recipientId) {
    const { rows: imgs } = await pool.query(
      'SELECT url, original_url, asset_type, sort_order FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3',
      [donorId]
    );
    if (imgs.length === 0) return false;
    for (const img of imgs) {
      try {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, $2, $3, $4, $5)
          ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [recipientId, img.asset_type, img.url, img.original_url, img.sort_order]);
      } catch {}
    }
    return true;
  }

  for (const [baseName, products] of groups) {
    let donorId = null;

    // 1. Exact base match from imaged products
    const imgMatch = baseToImaged.get(baseName);
    if (imgMatch) donorId = imgMatch[0].id;

    // 2. Prefix match
    if (!donorId && baseName.length >= 5) {
      for (const [b, prods] of baseToImaged) {
        if (b.startsWith(baseName) || baseName.startsWith(b)) {
          donorId = prods[0].id;
          break;
        }
      }
    }

    // 3. Core name extraction (strips hardscaping suffixes)
    if (!donorId) {
      const core = extractCore(baseName);
      if (core && core.length >= 4) {
        const coreLower = core.toLowerCase();
        for (const [b, prods] of baseToImaged) {
          const bLower = b.toLowerCase();
          if (bLower.startsWith(coreLower) || coreLower.startsWith(bLower)) {
            donorId = prods[0].id;
            break;
          }
        }
      }
    }

    // 4. First two words match
    if (!donorId) {
      const words = baseName.split(/\s+/).slice(0, 2).join(' ');
      if (words.length >= 5) {
        const wLower = words.toLowerCase();
        for (const [b, prods] of baseToImaged) {
          if (b.toLowerCase().startsWith(wLower)) {
            donorId = prods[0].id;
            break;
          }
        }
      }
    }

    if (donorId) {
      for (const p of products) {
        if (!needsImage.has(p.id)) continue;
        const ok = await copyImages(donorId, p.id);
        if (ok) {
          matched++;
          needsImage.delete(p.id);
        }
      }
    }
  }

  console.log('Name-based sharing matched:', matched);
  console.log('Still missing:', needsImage.size);

  // Show what's left by category
  const catBreakdown = {};
  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;
    const cat = m.category || 'Unknown';
    catBreakdown[cat] = (catBreakdown[cat] || 0) + 1;
  }
  console.log('\nRemaining by category:');
  for (const [cat, count] of Object.entries(catBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // Show sample of what's still missing
  console.log('\nSample remaining products:');
  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;
    console.log(`  [${m.category}] ${m.display_name}`);
  }

  // Final coverage
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);

  console.log(`\nCoverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);

  await pool.end();
})();
