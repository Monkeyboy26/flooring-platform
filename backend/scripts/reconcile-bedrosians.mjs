#!/usr/bin/env node
/**
 * reconcile-bedrosians.mjs
 *
 * Runs the scraper's authoritative reconcile pass (reconcileBedProducts) against
 * the current DB WITHOUT a full re-scrape. Same function the scraper calls in
 * Phase 5, so this both fixes the live data now and validates the logic.
 *
 * Usage: node backend/scripts/reconcile-bedrosians.mjs
 */
import pg from 'pg';
import { reconcileBedProducts } from '../scrapers/bed.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const v = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%bedrosian%' LIMIT 1");
if (!v.rows.length) { console.error('Bedrosians vendor not found'); process.exit(1); }

console.log('Reconciling Bedrosians…');
const stats = await reconcileBedProducts(pool, v.rows[0].id);
console.log(JSON.stringify(stats, null, 2));
await pool.end();
