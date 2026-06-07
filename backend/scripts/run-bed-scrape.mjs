import pg from 'pg';

const pool = new pg.Pool({
  host: 'db', user: 'postgres', password: 'postgres', database: 'flooring_pim', port: 5432
});

const detailOffset = parseInt(process.argv[2] || '0', 10);

const src = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'bed'");
if (!src.rows.length) { console.log('No source found'); process.exit(1); }
const source = src.rows[0];
if (detailOffset > 0) {
  source.config = { ...(source.config || {}), detailOffset };
}
console.log('Source:', source.id, source.name, 'detailOffset:', detailOffset);

const jobRes = await pool.query(
  `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING *`,
  [source.id]
);
const job = jobRes.rows[0];
console.log('Created job:', job.id);

const scraper = await import('../scrapers/bed.js');
try {
  await scraper.run(pool, job, source);
  await pool.query(`UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [job.id]);
  console.log('Scrape completed successfully');
} catch (err) {
  await pool.query(`UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [job.id]);
  console.error('Scrape failed:', err.message);
}
await pool.end();
process.exit(0);
