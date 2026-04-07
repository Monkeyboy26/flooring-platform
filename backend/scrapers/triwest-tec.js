import { appendLog } from './base.js';

/**
 * TEC enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: Installation materials — no consumer product images
 * Products: ~10
 *
 * This brand makes grouts, mortars, and adhesives (H.B. Fuller). No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'TEC: Skipped — installation materials — no consumer product images. No enrichment source available.'
  );
}
