import { appendLog } from './base.js';

/**
 * True Touch enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: No public website found for this brand
 * Products: ~25
 *
 * This brand has no active public website. No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'True Touch: Skipped — no public website found for this brand. No enrichment source available.'
  );
}
