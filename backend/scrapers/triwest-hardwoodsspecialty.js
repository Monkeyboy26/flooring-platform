import { appendLog } from './base.js';

/**
 * Hardwoods Specialty enrichment scraper for Tri-West — SKIPPED.
 *
 * Reason: Moldings and trim accessories — no product page images available
 * Products: ~15
 *
 * This brand makes moldings, trim, and accessories. No manufacturer website with
 * product images is available for enrichment.
 */
export async function run(pool, job, source) {
  await appendLog(pool, job.id,
    'Hardwoods Specialty: Skipped — moldings and trim accessories — no product page images available. No enrichment source available.'
  );
}
