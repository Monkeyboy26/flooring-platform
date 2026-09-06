// Standalone runner for the variant-name deduper (quality/variantDedupe.js) —
// see that module for the why. Dry-run unless --apply; --vendor=CODE to scope.
//
// Prod: docker compose exec -T api node scripts/dedupe-variant-names.mjs --apply
// The nightly quality cron runs the same pass automatically (server.js).

import { pool } from '../db.js';
import { runVariantDedupe } from '../quality/variantDedupe.js';

const APPLY = process.argv.includes('--apply');
const vendorArg = process.argv.find(a => a.startsWith('--vendor='));

async function main() {
  let vendorId = null;
  if (vendorArg) {
    const code = vendorArg.split('=')[1];
    const { rows } = await pool.query(`SELECT id FROM vendors WHERE code = $1`, [code]);
    if (!rows.length) throw new Error(`unknown vendor code ${code}`);
    vendorId = rows[0].id;
  }

  const res = await runVariantDedupe(pool, { apply: APPLY, vendorId });
  console.log(`${res.groups} colliding group(s); ${res.renamed.length} rename(s), ${res.skuFallback.length} vendor_sku fallback(s)\n`);

  const byVendor = {};
  for (const r of res.renamed) byVendor[r.vendor_code] = (byVendor[r.vendor_code] || 0) + 1;
  console.table(byVendor);

  for (const r of res.renamed.slice(0, 20)) {
    console.log(`  [${r.vendor_code}] ${r.product_name}: "${r.from}" -> "${r.to}" (via ${r.via})`);
  }
  if (res.renamed.length > 20) console.log(`  ... and ${res.renamed.length - 20} more`);
  if (!APPLY) console.log('\nDry-run. Re-run with --apply to write.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
