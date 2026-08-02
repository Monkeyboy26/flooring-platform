#!/usr/bin/env node

/**
 * ef-images.js — Engineered Floors image gap-fill (multi-source fallback chain)
 *
 * Runs as a pipeline step. Fills PRIMARY images for EF/PC SKUs that don't have
 * one yet, trying sources in order of quality/cost:
 *
 *   1. enrich-ef-cloudinary.cjs   — EF Cloudinary Search API (best; needs keys)
 *   2. import-ef-api-images.js    — EF WordPress REST API (name-matched)
 *   3. enrich-ef-pentz-web.cjs    — Pentz Commercial web images (PC style codes)
 *   4. ef-website.js --images-only — Puppeteer site scrape (last resort, slow)
 *
 * Every source is gap-fill + idempotent, so running the whole chain each night is
 * safe: each one only touches SKUs still missing a primary image. A source that
 * errors is logged and skipped — image enrichment is best-effort and must never
 * fail the pipeline, so this script always exits 0.
 *
 * Flags:
 *   --dry-run          only run sources that support it (no writes)
 *   --skip-puppeteer   skip the slow website scrape (source 4)
 *
 * Usage:
 *   node backend/pipelines/ef-images.js [--dry-run] [--skip-puppeteer]
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(__dirname, '../scripts');
const SCRAPERS = path.resolve(__dirname, '../scrapers');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_PUPPETEER = process.argv.includes('--skip-puppeteer');

// source list — supportsDryRun gates whether we run it in --dry-run mode
const SOURCES = [
  { label: 'Cloudinary API',  file: path.join(SCRIPTS, 'enrich-ef-cloudinary.cjs'), args: ['--no-activate'], supportsDryRun: true },
  { label: 'WordPress API',   file: path.join(SCRIPTS, 'import-ef-api-images.js'),  args: [], supportsDryRun: false },
  { label: 'Pentz web',       file: path.join(SCRIPTS, 'enrich-ef-pentz-web.cjs'),  args: [], supportsDryRun: true },
  { label: 'Website (Puppeteer)', file: path.join(SCRAPERS, 'ef-website.js'), args: ['--images-only'], supportsDryRun: false, puppeteer: true },
];

function run(source) {
  const args = [source.file, ...source.args];
  if (DRY_RUN && source.supportsDryRun) args.push('--dry-run');
  return new Promise((resolve) => {
    console.log(`\n═══ Image source: ${source.label} ═══`);
    const child = spawn('node', args, { env: { ...process.env }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
      if (code === 0) console.log(`  ✓ ${source.label} finished`);
      else console.warn(`  ⚠ ${source.label} exited ${code} — continuing (best-effort)`);
      resolve(code);
    });
    child.on('error', (err) => {
      console.warn(`  ⚠ ${source.label} failed to spawn: ${err.message} — continuing`);
      resolve(-1);
    });
  });
}

async function main() {
  console.log(`ef-images.js — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${SKIP_PUPPETEER ? ' (skip puppeteer)' : ''}`);
  for (const source of SOURCES) {
    if (source.puppeteer && (SKIP_PUPPETEER || DRY_RUN)) {
      console.log(`\n═══ Image source: ${source.label} — skipped ═══`);
      continue;
    }
    if (DRY_RUN && !source.supportsDryRun) {
      console.log(`\n═══ Image source: ${source.label} — skipped (no dry-run support) ═══`);
      continue;
    }
    await run(source);
  }
  console.log('\nef-images.js complete');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('[ef-images] FATAL:', err.message); process.exit(0); });
