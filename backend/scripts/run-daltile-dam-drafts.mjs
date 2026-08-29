/** One-off: run daltile-dam enrichment including DRAFT products (DAM_INCLUDE_DRAFT=1). */
import { pool } from '../db.js';
import { run } from '../scrapers/daltile-dam.js';
const { rows: [src] } = await pool.query(`SELECT vs.* FROM vendor_sources vs WHERE vs.scraper_key='daltile-dam' LIMIT 1`);
const { rows: [job] } = await pool.query(
  `INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1,'running',now()) RETURNING *`, [src.id]);
console.log('job', job.id);
try { await run(pool, job, src); await pool.query(`UPDATE scrape_jobs SET status='completed', completed_at=now() WHERE id=$1`, [job.id]); }
catch (e) { console.error(e.message); await pool.query(`UPDATE scrape_jobs SET status='failed', completed_at=now() WHERE id=$1`, [job.id]); }
await pool.end();
