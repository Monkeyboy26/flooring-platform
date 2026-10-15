// One-off: run the Bedrosians website scraper (bed.js) directly, outside the API's
// 4h in-process timeout wrapper, for the 2026-10-15 re-onboard (retail = site price,
// cost = 60% of retail). Creates its own scrape_jobs row so progress is visible in
// the admin scraper UI. Safe to delete after the run.
import { pool } from '../db.js';
import { run } from '../scrapers/bed.js';

const src = (await pool.query("SELECT * FROM vendor_sources WHERE scraper_key='bed' LIMIT 1")).rows[0];
if (!src) { console.error('No bed vendor_source found'); process.exit(1); }

const job = (await pool.query(
  "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1,'running',now()) RETURNING *",
  [src.id])).rows[0];
console.log('[bed-reonboard] job', job.id, 'started', new Date().toISOString());

try {
  await run(pool, job, src);
  await pool.query("UPDATE scrape_jobs SET status='completed', completed_at=now() WHERE id=$1", [job.id]);
  await pool.query("UPDATE vendor_sources SET last_scraped_at=now(), updated_at=now() WHERE id=$1", [src.id]);
  console.log('[bed-reonboard] DONE', new Date().toISOString());
} catch (e) {
  await pool.query(
    "UPDATE scrape_jobs SET status='failed', completed_at=now(), errors = errors || $2::jsonb WHERE id=$1",
    [job.id, JSON.stringify([{ message: String(e && e.message || e), time: new Date().toISOString() }])]);
  console.error('[bed-reonboard] FAILED', e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
