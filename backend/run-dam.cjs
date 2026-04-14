/**
 * One-time runner for the Daltile DAM scraper.
 * Run: docker compose exec api node backend/run-dam.cjs
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

async function main() {
  // Use existing DAM vendor source
  const vsRes = await pool.query(`
    SELECT vs.id FROM vendor_sources vs
    JOIN vendors v ON v.id = vs.vendor_id
    WHERE v.code = 'DAL' AND vs.name ILIKE '%dam%'
    LIMIT 1
  `);
  const vsId = vsRes.rows[0]?.id;
  if (!vsId) { console.error('No DAM vendor source found'); process.exit(1); }

  // Create job
  const jobRes = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, started_at)
    VALUES ($1, 'running', NOW()) RETURNING id
  `, [vsId]);
  const jobId = jobRes.rows[0].id;
  console.log('Job ID:', jobId);

  // Dynamic import for ES module scraper
  const { run } = await import('./scrapers/daltile-dam.js');
  try {
    await run(pool, { id: jobId }, { id: vsId });
    await pool.query("UPDATE scrape_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1", [jobId]);
  } catch (err) {
    console.error('Error:', err.message);
    await pool.query("UPDATE scrape_jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2", [err.message, jobId]);
  }

  // Print log
  const logRes = await pool.query('SELECT log FROM scrape_jobs WHERE id = $1', [jobId]);
  console.log('\n=== Job Log ===');
  console.log(logRes.rows[0]?.log || '(no log)');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
