#!/usr/bin/env node
/**
 * MSI Final CDN Probe — Aggressive CDN URL probing for the last ~114 products.
 * Tries many slug variations across all CDN sections.
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function extractBase(name) {
  return name
    .replace(/\s+\d+\s*Mm\b.*/i, '')
    .replace(/\s+\d{4}\s+/g, ' ')
    .replace(/\s+(Matte|Polished|Honed|Glossy|Lappato|Satin|Rectified)\s*$/i, '')
    .replace(/\s+(3d|Mosaic|Bullnose|Hexagon)\s*.*/i, '')
    .replace(/\s*\(\s*\d+\s*Pcs?\s.*/i, '')
    .replace(/\s+(Cop|Pav|Tread|Cobble|Pebble|Coping|Pool|Kits|Pattern|Shotblast|Sandblast|Tumbl|Honed|Unfil|Eased).*/i, '')
    .replace(/x\d+.*/i, '')
    .replace(/\s+\d+["']?.*/i, '')
    .replace(/\s+(R11|R10|R9)\s*$/i, '')
    .replace(/\s+(Origin)\s*$/i, '')
    .replace(/\s+(Bullnose\s+)?(Mat|Pol)\s*$/i, '')
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
  console.log(`Missing: ${missing.length}`);

  // Group by base name
  const baseGroups = new Map();
  for (const m of missing) {
    const b = extractBase(m.display_name);
    if (!baseGroups.has(b)) baseGroups.set(b, []);
    baseGroups.get(b).push(m);
  }
  console.log(`Unique base names: ${baseGroups.size}`);

  const needsImage = new Set(missing.map(m => m.id));
  let matched = 0;
  let probed = 0;

  const CDN_BASE = 'https://cdn.msisurfaces.com/images';
  const SECTIONS = ['porcelainceramic', 'colornames', 'naturalstone', 'hardscaping', 'mosaics', 'lvt'];
  const TYPES = ['detail', 'colornames', 'front', 'iso'];

  for (const [baseName, products] of baseGroups) {
    if (products.every(p => !needsImage.has(p.id))) continue;
    if (!baseName || baseName.length < 3) continue;
    if (baseName.startsWith('M S International')) continue;

    // Generate slug variations
    const words = baseName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) continue;

    const slugs = new Set();
    const forward = words.join('-');
    const reversed = [...words].reverse().join('-');

    slugs.add(forward);
    if (words.length >= 2) slugs.add(reversed);
    slugs.add(forward + '-porcelain');
    slugs.add(forward + '-ceramic');
    if (words.length >= 2) {
      slugs.add(reversed + '-porcelain');
      slugs.add(reversed + '-ceramic');
      // Try just first+last word
      slugs.add(words[0] + '-' + words[words.length - 1]);
      slugs.add(words[words.length - 1] + '-' + words[0]);
    }
    // Try without "hd" prefix
    if (words[0] === 'hd' && words.length >= 2) {
      const noHd = words.slice(1);
      slugs.add(noHd.join('-'));
      slugs.add([...noHd].reverse().join('-'));
    }

    let found = false;
    for (const slug of slugs) {
      if (found) break;
      for (const section of SECTIONS) {
        if (found) break;
        for (const type of TYPES) {
          const url = `${CDN_BASE}/${section}/${type}/${slug}.jpg`;
          probed++;
          const result = await headUrl(url);
          if (result) {
            // Try to upgrade to high-res root URL
            const rootUrl = `${CDN_BASE}/${section}/${slug}.jpg`;
            const rootResult = await headUrl(rootUrl);
            const imgUrl = rootResult || result;

            // Save to all products in this group
            for (const p of products) {
              if (!needsImage.has(p.id)) continue;
              try {
                await pool.query(`
                  INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                  VALUES ($1, NULL, 'primary', $2, $2, 0)
                  ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
                  DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
                `, [p.id, imgUrl]);
                matched++;
                needsImage.delete(p.id);
                console.log(`  ✓ ${p.display_name} → ${imgUrl}`);
              } catch {}
            }
            found = true;
            break;
          }
        }
      }
      await delay(20);
    }

    if (probed % 500 === 0 && probed > 0) {
      console.log(`  ${probed} probed, ${matched} matched, ${needsImage.size} remaining`);
    }
  }

  console.log(`\nCDN probe: ${matched} matched from ${probed} probes`);

  // Final coverage
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);
  console.log(`Still missing: ${stats.total - stats.with_images}`);

  // List remaining
  if (needsImage.size > 0 && needsImage.size <= 50) {
    console.log('\nRemaining products:');
    for (const m of missing) {
      if (needsImage.has(m.id)) {
        console.log(`  [${m.category}] ${m.display_name}`);
      }
    }
  }

  await pool.end();
})();
