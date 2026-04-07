import { appendLog } from './base.js';

/**
 * Summit enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: Tri-West private label — no external manufacturer site
 * Products: ~20
 *
 * This brand is a Tri-West private label. No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'Summit: Skipped — Tri-West private label — no external manufacturer site. No enrichment source available.'
  );
}
