const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

// Coveo API helper
async function queryCoveo(domain, filter, offset, count) {
  const aq = `@sitetargethostname=="${domain}" @sourcedisplayname==product${filter}`;
  const resp = await fetch(`https://${domain}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      q: '',
      aq,
      firstResult: offset,
      numberOfResults: count,
      fieldsToInclude: ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'primaryroomsceneurl', 'nominalsize', 'finish', 'productshape'],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return await resp.json();
}

const BRAND_DOMAINS = {
  'DAL': 'www.daltile.com',
  'AO': 'www.americanolean.com',
  'MZ': 'www.marazziusa.com',
};

(async () => {
  // Get products without images
  const noImg = await pool.query(`
    SELECT p.id, p.name, p.collection, v.code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ') AND ma.id IS NULL
    ORDER BY v.code, p.name
  `);
  console.log("Products without images:", noImg.rows.length);

  // Build lookup: for each brand, fetch ALL Coveo results and index by series+color
  for (const brandCode of ['DAL', 'AO', 'MZ']) {
    const domain = BRAND_DOMAINS[brandCode];
    const brandProducts = noImg.rows.filter(r => r.code === brandCode);
    if (brandProducts.length === 0) continue;

    console.log("\n=== " + brandCode + " (" + brandProducts.length + " products need images) ===");

    // Fetch Coveo results for this brand
    const probe = await queryCoveo(domain, '', 0, 0);
    const total = probe.totalCount || 0;
    console.log("Coveo total for " + domain + ": " + total);

    // Fetch all results in pages
    const allResults = [];
    let offset = 0;
    while (offset < total && offset < 5000) {
      const page = await queryCoveo(domain, '', offset, 1000);
      const batch = page.results || [];
      if (batch.length === 0) break;
      allResults.push(...batch);
      offset += batch.length;
      await new Promise(r => setTimeout(r, 200));
    }
    console.log("Fetched " + allResults.length + " Coveo results");

    // Index by SERIES + COLOR (lowercase)
    const coveoByName = new Map(); // "series|color" -> {imageUrl, roomSceneUrl}
    const coveoBySeriesOnly = new Map(); // "series" -> first result with image
    for (const result of allResults) {
      const raw = result.raw || {};
      const series = (raw.seriesname || '').toString().trim();
      const color = (raw.colornameenglish || '').toString().trim();
      const imageUrl = (raw.productimageurl || '').toString().trim();
      const roomUrl = (raw.primaryroomsceneurl || '').toString().trim();

      if (!imageUrl && !roomUrl) continue;

      if (series && color) {
        const key = (series + ' ' + color).toLowerCase();
        if (!coveoByName.has(key)) {
          coveoByName.set(key, { imageUrl, roomUrl });
        }
      }
      if (series && !coveoBySeriesOnly.has(series.toLowerCase())) {
        coveoBySeriesOnly.set(series.toLowerCase(), { imageUrl, roomUrl });
      }
    }
    console.log("Indexed " + coveoByName.size + " series+color combos, " + coveoBySeriesOnly.size + " series");

    // Try to match products
    let matched = 0, matchedSeries = 0, unmatched = 0;
    for (const prod of brandProducts) {
      const nameKey = prod.name.toLowerCase();
      const collKey = (prod.collection || '').toLowerCase();

      let coveo = coveoByName.get(nameKey);
      if (!coveo) {
        // Try collection + color parts
        // Product name might be "Natural Stone Seashell", collection is "Natural Stone"
        // Coveo might have series="Natural Stone" color="Seashell"
        coveo = coveoBySeriesOnly.get(collKey);
        if (coveo) matchedSeries++;
      }

      if (coveo) {
        matched++;
        if (coveo.imageUrl) {
          await pool.query(`
            INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
            VALUES ($1, 'primary', $2, $2, 0)
            ON CONFLICT DO NOTHING
          `, [prod.id, coveo.imageUrl]);
        }
        if (coveo.roomUrl) {
          await pool.query(`
            INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
            VALUES ($1, 'lifestyle', $2, $2, 0)
            ON CONFLICT DO NOTHING
          `, [prod.id, coveo.roomUrl]);
        }
      } else {
        unmatched++;
        if (unmatched <= 5) {
          console.log("  UNMATCHED: " + prod.name + " (coll: " + prod.collection + ")");
        }
      }
    }
    console.log("Matched: " + matched + " (by name: " + (matched - matchedSeries) + ", by series: " + matchedSeries + ") | Unmatched: " + unmatched);
  }

  // Final image coverage
  const coverage = await pool.query(`
    SELECT v.code,
      COUNT(DISTINCT p.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ')
    GROUP BY v.code ORDER BY v.code
  `);
  console.log("\n=== Final Image Coverage ===");
  for (const row of coverage.rows) {
    console.log(row.code + ": " + row.with_images + "/" + row.total);
  }

  pool.end();
})();
