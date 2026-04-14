// Generic scraper runner: node run-scraper.cjs <scraper-key>
const { Pool } = require('pg');

async function main() {
  const key = process.argv[2];
  if (!key) { console.error('Usage: node run-scraper.cjs <scraper-key>'); process.exit(1); }

  const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });
  const mod = await import(`./scrapers/${key}.js`);

  const src = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = $1 LIMIT 1", [key]);
  const source = src.rows[0];
  if (!source) { console.log('No vendor_source for key:', key); process.exit(1); }

  const job = await pool.query(
    "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id",
    [source.id]
  );
  const jobId = job.rows[0].id;
  console.log('Job ID:', jobId);

  try {
    await mod.run(pool, { id: jobId }, source);
  } catch (e) {
    console.error('FATAL:', e);
  }

  const logs = await pool.query('SELECT log FROM scrape_jobs WHERE id = $1', [jobId]);
  console.log('\n=== Job Log ===');
  console.log(logs.rows[0].log);

  await pool.query("UPDATE scrape_jobs SET status = 'completed' WHERE id = $1", [jobId]);
  await pool.end();
}
main();
