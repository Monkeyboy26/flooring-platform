#!/usr/bin/env node
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

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

  const { rows: imaged } = await pool.query(`
    SELECT p.id, lower(p.display_name) as name_l
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
      AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
  `, [vid]);

  // Build word index
  const wordIndex = new Map();
  const skip = new Set(['matte','polished','honed','glossy','lappato','satin','porcelain','ceramic',
    'tile','marble','granite','travertine','natural','stone','panel','corner','corners',
    'splitface','splitfce','spltfac','pnl6x18','pnl6x24','international','tumbled','sandblasted',
    'shotblasted','coping','pavers','paver','treads','cobbles','cobble','pattern','kits']);

  for (const ip of imaged) {
    const words = ip.name_l.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3 && !skip.has(w));
    for (const w of words) {
      if (!wordIndex.has(w)) wordIndex.set(w, []);
      wordIndex.get(w).push(ip);
    }
  }

  let matched = 0;

  for (const m of missing) {
    const words = m.display_name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3 && !skip.has(w));
    if (words.length === 0) continue;

    const donorScores = new Map();
    for (const w of words) {
      const candidates = wordIndex.get(w) || [];
      for (const c of candidates) {
        donorScores.set(c.id, (donorScores.get(c.id) || 0) + 1);
      }
    }

    let bestDonor = null;
    let bestScore = 0;
    const minScore = words.length <= 2 ? 1 : 2;
    for (const [donorId, score] of donorScores) {
      if (score > bestScore && score >= minScore) {
        bestScore = score;
        bestDonor = donorId;
      }
    }

    if (bestDonor) {
      const { rows: imgs } = await pool.query(
        'SELECT url, original_url, asset_type, sort_order FROM media_assets WHERE product_id = $1 ORDER BY sort_order LIMIT 3',
        [bestDonor]
      );
      for (const img of imgs) {
        try {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, NULL, $2, $3, $4, $5)
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [m.id, img.asset_type, img.url, img.original_url, img.sort_order]);
        } catch {}
      }
      if (imgs.length > 0) {
        matched++;
        const donorName = imaged.find(ip => ip.id === bestDonor)?.name_l || '?';
        console.log(`  ${m.display_name} → ${donorName} (${bestScore} words)`);
      }
    }
  }

  console.log(`\nMatched: ${matched}`);

  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);

  await pool.end();
})();
