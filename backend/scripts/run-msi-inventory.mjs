import pg from 'pg';

const pool = new pg.Pool({
  host: 'db', user: 'postgres', password: 'postgres', database: 'flooring_pim', port: 5432
});

const src = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'msi-inventory'");
if (!src.rows.length) { console.log('No source found'); process.exit(1); }
const source = src.rows[0];
console.log('Source:', source.id);

const jobRes = await pool.query(
  `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING *`,
  [source.id]
);
const job = jobRes.rows[0];
console.log('Created job:', job.id);

const scraper = await import('../scrapers/msi-inventory.js');
try {
  await scraper.run(pool, job, source);
  await pool.query(`UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [job.id]);
  console.log('Scrape completed successfully');
} catch (err) {
  await pool.query(`UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [job.id]);
  console.error('Scrape failed:', err.message);
}

const logs = await pool.query('SELECT log FROM scrape_jobs WHERE id = $1', [job.id]);
console.log('--- Job log ---');
console.log(logs.rows[0]?.log || '(empty)');
await pool.end();
process.exit(0);
