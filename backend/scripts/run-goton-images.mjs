/**
 * Standalone runner for the Goton image-enrichment scraper (scrapers/goton.js
 * exports run(pool, job, source) for the job runner). Rebuild the product map first:
 *   node scripts/build-goton-product-map.cjs
 *   node scripts/run-goton-images.mjs
 */
import pg from 'pg';
import { run } from '../scrapers/goton.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const { rows } = await pool.query("SELECT id FROM vendors WHERE code='GOT'");
if (!rows.length) { console.error('Goton (GOT) not found'); process.exit(1); }
const job = { id: null };            // appendLog is best-effort (.catch swallows)
const source = { vendor_id: rows[0].id };

await run(pool, job, source);
await pool.end();
