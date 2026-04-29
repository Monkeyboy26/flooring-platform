#!/usr/bin/env node
/**
 * Try to construct Scene7 URLs for imageless Daltile SKUs.
 * Tests multiple URL patterns and inserts the first one that returns 200.
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const S7 = 'https://s7d9.scene7.com/is/image/daltile/DAL_';

function buildCandidates(colorCode, size, colorName, finish) {
  const s = size.toLowerCase();
  const cn = (colorName || '').replace(/\s+/g, '');
  const candidates = [];
  for (const f of [finish, '']) {
    const fsuffix = f ? `_${f}` : '';
    if (cn) {
      candidates.push(`${S7}${colorCode}_${s}_${cn}${fsuffix}_Grid`);
      candidates.push(`${S7}${colorCode}_${s}_${cn}${fsuffix}_Silo_01`);
      candidates.push(`${S7}${colorCode}_${s}_${cn}_Grid`);
      candidates.push(`${S7}${colorCode}_${s}_${cn}_Silo_01`);
    }
    candidates.push(`${S7}${colorCode}_${s}${fsuffix}_Grid`);
    candidates.push(`${S7}${colorCode}_${s}${fsuffix}_Silo_01`);
  }
  return [...new Set(candidates)];
}

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const res = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id,
      p.name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'primary'
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND m.id IS NULL
    ORDER BY p.collection, p.name
  `);

  console.log(`Imageless SKUs to check: ${res.rows.length}`);
  let found = 0, notFound = 0;

  for (const row of res.rows) {
    const colorCode = row.vendor_sku.substring(0, 4);
    const sizePart = (row.variant_name || '').split(',')[0].trim();
    const m = sizePart.match(/^(\d+)X(\d+)$/i);
    if (!m) { notFound++; continue; }
    const size = `${m[1]}x${m[2]}`;

    const colorName = row.name
      .replace(new RegExp('^' + row.collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '')
      .trim();
    const finish = (row.variant_name || '').includes('Polished') ? 'PL' :
                   (row.variant_name || '').includes('Glossy') ? 'GL' :
                   (row.variant_name || '').includes('Light Polished') ? 'LP' : 'MT';

    const candidates = buildCandidates(colorCode, size, colorName, finish);
    let foundUrl = null;

    for (const url of candidates) {
      if (await urlExists(url)) { foundUrl = url; break; }
    }

    if (foundUrl) {
      found++;
      console.log(`FOUND: ${row.vendor_sku} → ${foundUrl.split('/').pop()}`);
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $3, 0, 'scene7-construct')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, foundUrl]);
    } else {
      notFound++;
      console.log(`MISS: ${row.vendor_sku} (${row.name} ${sizePart})`);
    }
  }

  console.log(`\nFound: ${found}, Not found: ${notFound}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
