// One-off: add specific Orion products by URL without a full re-scrape.
// Usage: node run-orion-slabs.cjs
const { Pool } = require('pg');

const URLS = [
  'https://orionflooring.com/product/lumen-slab-natural-stone/',
  'https://orionflooring.com/product/ijen-blue-slab-natural-stone/',
  'https://orionflooring.com/product/camelot-slab-natural-stone/',
  'https://orionflooring.com/product/azul-imperial-slab-natural-stone/',
  'https://orionflooring.com/product/botanic-green-quartzite-slabs-countertops/',
  'https://orionflooring.com/product/oni-blue-polished-porcelain-tile-marble-look-onyx-onix/',
];

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const mod = await import('./scrapers/orion.js');
  const src = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'orion' LIMIT 1");
  const source = src.rows[0];
  if (!source) { console.log('No vendor_source for orion'); process.exit(1); }
  source.config = { ...(source.config || {}), onlyUrls: URLS, delayMs: 1500 };

  const job = await pool.query(
    "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id",
    [source.id]
  );
  const jobId = job.rows[0].id;
  console.log('Job ID:', jobId, '— scraping', URLS.length, 'URLs');
  try {
    await mod.run(pool, { id: jobId }, source);
  } catch (e) { console.error('FATAL:', e); }
  const logs = await pool.query('SELECT log FROM scrape_jobs WHERE id = $1', [jobId]);
  console.log('\n=== Job Log ===\n' + (logs.rows[0].log || ''));
  await pool.query("UPDATE scrape_jobs SET status='completed', completed_at=NOW() WHERE id=$1", [jobId]);
  await pool.end();
}
main();
