/**
 * Re-scrape Bedrosians detail pages for SKUs missing packaging data.
 * Only visits detail pages for products that have no packaging record.
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: 'db', user: 'postgres', password: 'postgres', database: 'flooring_pim', port: 5432
});

// Find non-slab SKUs missing packaging
const result = await pool.query(`
  SELECT DISTINCT s.id as sku_id, s.vendor_sku, p.id as product_id, p.name
  FROM skus s
  JOIN products p ON s.product_id = p.id
  JOIN categories c ON p.category_id = c.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440002'
  AND pk.sku_id IS NULL
  AND NOT (c.slug IN ('quartz-countertops', 'marble-countertops')
       OR s.vendor_sku LIKE '%SLAB%'
       OR s.variant_name LIKE '%126%' OR s.variant_name LIKE '%138%'
       OR s.variant_name LIKE '%127%' OR s.variant_name LIKE '%139%')
  ORDER BY p.name
`);

console.log(`Found ${result.rows.length} SKUs missing packaging`);
if (result.rows.length === 0) {
  await pool.end();
  process.exit(0);
}

// Import scraper utilities
const { launchBrowser, upsertPackaging, upsertSkuAttribute, delay } = await import('../scrapers/base.js');

// We need to scrape individual detail pages for these SKUs
// Build detail URLs from vendor_sku
const browser = await launchBrowser();
let scraped = 0;
let packaged = 0;

for (const row of result.rows) {
  const detailUrl = `https://www.bedrosians.com/en/product/detail/?itemNo=${encodeURIComponent(row.vendor_sku)}`;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['font', 'stylesheet', 'media', 'image'].includes(type)) req.abort();
      else req.continue();
    });

    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    await page.close();

    // Extract productDetailModel
    const match = html.match(/window\.bdApp\.value\s*\(\s*'productDetailModel'\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) {
      scraped++;
      continue;
    }

    // Safe parse (it's JS object, not strict JSON)
    let model;
    try {
      model = (new Function('return ' + match[1]))();
    } catch {
      scraped++;
      continue;
    }

    // Extract packaging
    if (Array.isArray(model.Packaging) && model.Packaging.length > 0) {
      const keyMap = {
        'box pieces': 'pieces_per_box', 'box pcs': 'pieces_per_box', 'pieces per box': 'pieces_per_box',
        'box sf': 'sqft_per_box', 'box sq ft': 'sqft_per_box', 'sqft per box': 'sqft_per_box', 'sf per box': 'sqft_per_box',
        'box weight': 'weight_per_box_lbs', 'weight per box': 'weight_per_box_lbs',
        'pallet boxes': 'boxes_per_pallet', 'boxes per pallet': 'boxes_per_pallet',
      };
      const pkg = {};
      for (const item of model.Packaging) {
        const key = (item.Key || '').toLowerCase().trim();
        const val = parseFloat(item.Value);
        if (keyMap[key] && !isNaN(val)) {
          pkg[keyMap[key]] = val;
        }
      }
      if (Object.keys(pkg).length > 0) {
        await upsertPackaging(pool, row.sku_id, pkg);
        packaged++;
      }
    }
  } catch (err) {
    console.error(`Error scraping ${row.vendor_sku}: ${err.message}`);
  }

  scraped++;
  if (scraped % 25 === 0) {
    console.log(`Progress: ${scraped}/${result.rows.length} (packaging: ${packaged})`);
  }

  // Restart browser every 50 to prevent memory issues
  if (scraped % 50 === 0 && scraped < result.rows.length) {
    await browser.close();
    await delay(2000);
    const newBrowser = await launchBrowser();
    Object.assign(browser, newBrowser);
  }

  await delay(1500);
}

await browser.close();
console.log(`Done. Scraped: ${scraped}, Packaging found: ${packaged}`);
await pool.end();
process.exit(0);
