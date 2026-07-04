import pg from 'pg';

const pool = new pg.Pool({
  host: 'db', user: 'postgres', password: 'postgres', database: 'flooring_pim', port: 5432
});

// Limit the test to specific manufacturers via CLI args, e.g.:
//   node scripts/run-triwest-inventory-test.mjs PRO MET
const mfgrs = process.argv.slice(2);

const src = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'triwest-inventory'");
if (!src.rows.length) { console.log('No source found'); process.exit(1); }
const source = src.rows[0];
if (mfgrs.length > 0) {
  source.config = { ...(source.config || {}), manufacturers: mfgrs };
}
console.log('Source:', source.id, 'manufacturers:', mfgrs.length ? mfgrs.join(',') : '(all)');

const jobRes = await pool.query(
  `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING *`,
  [source.id]
);
const job = jobRes.rows[0];
console.log('Created job:', job.id);

const scraper = await import('../scrapers/triwest-inventory.js');
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
