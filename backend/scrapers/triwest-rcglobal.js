import { appendLog } from './base.js';

/**
 * RC Global enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: Private label underlayment — no external manufacturer site
 * Products: ~8
 *
 * This brand is a private label underlayment product line. No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'RC Global: Skipped — private label underlayment — no external manufacturer site. No enrichment source available.'
  );
}
