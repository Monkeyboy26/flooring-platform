// One-off: run the conformance audit (SQL rules only, no image network sweep)
// to reconcile quality_violations against current data + the updated rules.js.
import pg from 'pg';
import { runQualityAudit } from './quality/runner.js';
const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});
const res = await runQualityAudit(pool, { triggeredBy: 'manual-dq-cleanup', checkImages: false });
console.log(JSON.stringify(res, null, 2));
await pool.end();
