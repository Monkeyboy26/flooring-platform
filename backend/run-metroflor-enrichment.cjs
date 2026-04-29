#!/usr/bin/env node
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'flooring_pim'
});

(async () => {
  try {
    const srcResult = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'triwest-metroflor'");
    if (!srcResult.rows.length) { console.log('Source not found'); process.exit(1); }
    const source = srcResult.rows[0];
    console.log('Source:', source.name, source.id);

    const jobResult = await pool.query(
      `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING *`,
      [source.id]
    );
    const job = jobResult.rows[0];
    console.log('Job created:', job.id);

    const scraperModule = await import('./scrapers/triwest-metroflor.js');
    console.log('Scraper module loaded, running...');
    await scraperModule.run(pool, job, source);

    await pool.query(`UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [job.id]);
    console.log('Scrape completed successfully!');
  } catch (err) {
    console.error('Scrape failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
