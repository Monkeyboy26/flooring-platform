#!/usr/bin/env node
/**
 * CLI runner for the WPT scraper.
 * Usage: node backend/scripts/run-wpt-scraper.js
 */
import pg from 'pg';
import { run } from '../scrapers/wpt.js';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim';
const pool = new pg.Pool({ connectionString: DB_URL });

try {
  const stats = await run(pool, {});
  console.log('\nDone.', JSON.stringify(stats, null, 2));
} catch (err) {
  console.error('FATAL:', err);
  process.exit(1);
} finally {
  await pool.end();
}
