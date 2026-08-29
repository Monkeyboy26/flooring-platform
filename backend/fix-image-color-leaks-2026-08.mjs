// Fix the confirmed cross-color primary-image leaks that the image-color-mismatch
// rule flags (a SKU's primary shows a different sibling color's photo). Principle
// from the scrapers: no image > wrong image — DELETE the wrong primary so the PDP
// falls back to a product-level image. The sibling the photo actually depicts
// already has its own primary (its color code exists), so we don't reassign.
//
// Reuses the rule's exact detection (single source of truth) — run it, delete the
// offending primary rows, with a backup.
//
//   node fix-image-color-leaks-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';
import { RULES } from './quality/rules.js';

const APPLY = process.argv.includes('--apply');
const rule = RULES.find(r => r.key === 'image-color-mismatch');
const violations = await rule.run(pool, { vendorId: null });
console.log(`${violations.length} confirmed color-leak primaries`);

const toDelete = [];
for (const v of violations) {
  const { rows } = await pool.query(
    `SELECT id, url, original_url, sku_id, product_id FROM media_assets
     WHERE sku_id = $1 AND asset_type = 'primary' AND COALESCE(original_url, url) = $2`,
    [v.sku_id, v.detail.src]
  );
  for (const r of rows) toDelete.push({ ...r, summary: v.summary });
}
console.log(`${toDelete.length} primary media rows to delete`);
for (const d of toDelete.slice(0, 10)) console.log(`  ${d.summary.slice(0, 100)}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/image-color-leaks-backup-${stamp}.json`, JSON.stringify(toDelete, null, 2));
if (toDelete.length) {
  await pool.query(`DELETE FROM media_assets WHERE id = ANY($1)`, [toDelete.map(d => d.id)]);
}
console.log(`Deleted ${toDelete.length} wrong primaries. Backup: ./data/image-color-leaks-backup-${stamp}.json`);
await pool.end();
