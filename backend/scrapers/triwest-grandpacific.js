import { appendLog } from './base.js';

/**
 * Grand Pacific enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: No public website found for this brand
 * Products: ~27
 *
 * This brand has no active public website. No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'Grand Pacific: Skipped — no public website found for this brand. No enrichment source available.'
  );
}
