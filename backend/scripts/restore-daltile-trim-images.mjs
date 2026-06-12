#!/usr/bin/env node
/**
 * Restore Daltile accessory/trim SKU images from Coveo API.
 * Targeted recovery script — only fetches Trim product types.
 */
import pg from 'pg';

const PAGE_SIZE = 1000;
const COVEO_FIELDS = [
  'sku', 'productimageurl', 'primaryroomsceneurl', 'producttype',
];
const TRIM_TYPES = [
  'Floor Tile Trim', 'Wall Tile Trim', 'Mosaic Tile Trim',
  'Stone Tile Trim', 'LVT Trim', 'Quarry Tile Trim',
];

function cleanScene7Url(url) {
  if (!url) return url;
  return url.split('?')[0].split('#')[0].trim();
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const u = url.toUpperCase();
  return u.includes('PLACEHOLDER') || u.includes('NO-SERIES-IMAGE') ||
    u.includes('NOIMAGE') || u.includes('NO_IMAGE') || u.includes('COMING-SOON');
}

async function queryCoveo(domain, extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${domain}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${domain}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

function getField(item, name) {
  const raw = item.raw || {};
  const val = raw[name] || raw[name.toLowerCase()] || '';
  return Array.isArray(val) ? val[0] || '' : (val || '').toString();
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  // Load Daltile accessory SKUs missing primary images
  const missing = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL', 'AO', 'MZ')
      AND s.variant_type = 'accessory'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
      )
  `);

  const skuMap = new Map();
  for (const row of missing.rows) {
    skuMap.set(row.vendor_sku.toUpperCase(), row);
  }
  console.log(`Found ${skuMap.size} accessory SKUs missing primary images`);

  if (skuMap.size === 0) {
    await pool.end();
    return;
  }

  // Fetch trim products from Coveo for all three domains
  const domains = ['www.daltile.com', 'www.americanolean.com', 'www.marazziusa.com'];
  let matched = 0, inserted = 0;

  for (const domain of domains) {
    for (const trimType of TRIM_TYPES) {
      const filter = ` @producttype=="${trimType}"`;
      let probe;
      try {
        probe = await queryCoveo(domain, filter, 0, 0);
      } catch (e) {
        console.log(`  Skip ${domain} / ${trimType}: ${e.message}`);
        continue;
      }
      const total = probe.totalCount || 0;
      if (total === 0) continue;

      console.log(`  ${domain} / ${trimType}: ${total} results`);

      let offset = 0;
      while (offset < total && offset < 5000) {
        const pageSize = Math.min(PAGE_SIZE, total - offset);
        const resp = await queryCoveo(domain, filter, offset, pageSize);
        const batch = resp.results || [];
        if (batch.length === 0) break;

        for (const item of batch) {
          const rawSku = getField(item, 'sku');
          if (!rawSku) continue;

          const skuList = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
          for (const coveoSku of skuList) {
            const row = skuMap.get(coveoSku.toUpperCase());
            if (!row) continue;

            const imgUrl = getField(item, 'productimageurl');
            if (!imgUrl || isPlaceholderUrl(imgUrl)) continue;

            const cleanedImg = cleanScene7Url(imgUrl);
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, $2, 'primary', $3, $3, 0)
              ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [row.product_id, row.sku_id, cleanedImg]);
            inserted++;
            matched++;
            skuMap.delete(coveoSku.toUpperCase());
          }
        }

        offset += batch.length;
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  console.log(`\nDone. Matched: ${matched}, Inserted: ${inserted}, Still missing: ${skuMap.size}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
