const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });
  const mod = await import('./scrapers/daltile-inherit.js');

  const src = await pool.query("SELECT id FROM vendor_sources WHERE scraper_key = 'daltile-inherit' LIMIT 1");
  const sourceId = src.rows[0] && src.rows[0].id;
  if (!sourceId) { console.log('No vendor_source found'); process.exit(1); }

  const job = await pool.query(
    "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id",
    [sourceId]
  );
  const jobId = job.rows[0].id;
  console.log('Job ID:', jobId);

  try {
    await mod.run(pool, { id: jobId }, { id: sourceId });
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
