// Ingest GENUINE service reviews into service_reviews, which backs the aggregateRating
// JSON-LD on installation / material / remodel pages (loadServiceReviews in seoRenderer.js).
//
// This NEVER fabricates ratings. It loads real reviews from a JSON file you provide —
// exported from Google Business Profile, or hand-entered from real customer reviews.
//
//   node scripts/seo/ingest-service-reviews.mjs path/to/reviews.json [--dry-run] [--replace]
//   docker compose exec -T api node scripts/seo/ingest-service-reviews.mjs /tmp/reviews.json
//
// reviews.json shape — an array of:
//   {
//     "author":   "Jane D.",          // required
//     "rating":   5,                   // required, 1–5
//     "body":     "Great crew...",     // optional (needed to show as a Review snippet)
//     "date":     "2026-08-01",        // optional (YYYY-MM-DD)
//     "external_id": "gbp:abc123",     // optional but recommended — dedupe key
//     "source":   "google"             // optional, defaults to "google"
//   }
//
// IDEMPOTENT: upserts on external_id when present. --replace clears the table first (use
// when re-syncing a full GBP export). Once ingested, the schema flips on within ~1h (cache).

import fs from 'fs';
import { pool } from '../../db.js';

const file = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');

if (!file || file.startsWith('--')) {
  console.error('Usage: node scripts/seo/ingest-service-reviews.mjs <reviews.json> [--dry-run] [--replace]');
  process.exit(1);
}

let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`Cannot read/parse ${file}: ${e.message}`); process.exit(1); }
if (!Array.isArray(data)) { console.error('Expected a JSON array of reviews.'); process.exit(1); }

// Validate — reject anything that isn't a real, well-formed review. No silent fabrication.
const clean = [];
const errors = [];
for (const [i, r] of data.entries()) {
  const author = (r.author || '').toString().trim();
  const rating = Number(r.rating);
  if (!author) { errors.push(`#${i}: missing author`); continue; }
  if (!(rating >= 1 && rating <= 5)) { errors.push(`#${i}: rating must be 1–5 (got ${r.rating})`); continue; }
  clean.push({
    source: (r.source || 'google').toString().slice(0, 40),
    author, rating,
    body: r.body ? r.body.toString() : null,
    date: r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
    external_id: r.external_id ? r.external_id.toString() : null,
  });
}

console.log(`${clean.length} valid review(s), ${errors.length} rejected${DRY_RUN ? ' (DRY RUN)' : ''}${REPLACE ? ' [--replace]' : ''}`);
errors.slice(0, 20).forEach(e => console.warn(`  ⚠ ${e}`));
if (!clean.length) { console.error('Nothing to ingest.'); await pool.end(); process.exit(1); }

if (DRY_RUN) {
  const avg = (clean.reduce((s, r) => s + r.rating, 0) / clean.length).toFixed(1);
  console.log(`\nWould store ${clean.length} reviews → aggregateRating ${avg} (${clean.length} reviews)`);
  clean.slice(0, 5).forEach(r => console.log(`  ${r.rating}★ ${r.author}${r.body ? ' — ' + r.body.slice(0, 60) : ''}`));
  await pool.end();
  process.exit(0);
}

if (REPLACE) { await pool.query('TRUNCATE service_reviews'); console.log('Cleared existing reviews.'); }

let ins = 0, upd = 0, noid = 0;
for (const r of clean) {
  if (r.external_id) {
    const res = await pool.query(`
      INSERT INTO service_reviews (source, author, rating, body, review_date, external_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (external_id) DO UPDATE SET
        source=EXCLUDED.source, author=EXCLUDED.author, rating=EXCLUDED.rating,
        body=EXCLUDED.body, review_date=EXCLUDED.review_date
      RETURNING (xmax = 0) AS inserted`,
      [r.source, r.author, r.rating, r.body, r.date, r.external_id]);
    if (res.rows[0].inserted) ins++; else upd++;
  } else {
    // No external_id → can't dedupe; insert fresh (use --replace to avoid piling up).
    await pool.query(`INSERT INTO service_reviews (source, author, rating, body, review_date) VALUES ($1,$2,$3,$4,$5)`,
      [r.source, r.author, r.rating, r.body, r.date]);
    noid++;
  }
}

const agg = await pool.query(`SELECT ROUND(AVG(rating)::numeric,1) AS avg, COUNT(*)::int AS cnt FROM service_reviews WHERE is_published = true`);
console.log(`\nDone: ${ins} inserted, ${upd} updated, ${noid} inserted without external_id`);
console.log(`aggregateRating now: ${agg.rows[0].avg}★ across ${agg.rows[0].cnt} reviews (live within ~1h render cache)`);
await pool.end();
