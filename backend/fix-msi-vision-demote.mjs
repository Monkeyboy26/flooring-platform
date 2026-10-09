// Demote (not delete) primary images the AI vision check flagged as the wrong
// color/material. Re-labels asset_type 'primary' -> 'swatch': the storefront
// resolves images primary -> alternate -> lifestyle and NEVER shows 'swatch'
// (server.js media CTEs), so the wrong image disappears from the PDP hero and
// browse grid immediately, while the row is preserved for audit. Principle from
// the scrapers: no image > wrong image. Reuses the image-vision-mismatch rule
// (single source of truth) so only confident mismatches (confidence >= 0.7) are
// touched.
//
//   node fix-msi-vision-demote.mjs [--vendor MSI] [--dry-run | --apply]

import fs from 'fs';
import { pool } from './db.js';
import { RULES } from './quality/rules.js';

const APPLY = process.argv.includes('--apply');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const VENDOR = arg('--vendor', 'MSI');

let vendorId = null;
if (VENDOR) {
  const { rows } = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR]);
  if (!rows.length) { console.error(`Unknown vendor ${VENDOR}`); await pool.end(); process.exit(1); }
  vendorId = rows[0].id;
}

const rule = RULES.find(r => r.key === 'image-vision-mismatch');
const violations = await rule.run(pool, { vendorId });
console.log(`${violations.length} confident vision mismatches${VENDOR ? ` (${VENDOR})` : ''}`);

// Resolve each flagged SKU's current primary media row(s).
const toDemote = [];
for (const v of violations) {
  const { rows } = await pool.query(
    `SELECT id, url, original_url, sku_id, product_id, sort_order FROM media_assets
       WHERE sku_id = $1 AND asset_type = 'primary'`,
    [v.sku_id]
  );
  for (const r of rows) toDemote.push({ ...r, summary: v.summary });
}
console.log(`${toDemote.length} primary rows to demote -> swatch`);
for (const d of toDemote.slice(0, 10)) console.log(`  ${d.summary.slice(0, 110)}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/msi-vision-demote-backup-${stamp}.json`, JSON.stringify(toDemote, null, 2));
if (toDemote.length) {
  // Push sort_order out of the way too, so the re-label can't collide with an
  // existing swatch at sort_order 0 for the same SKU.
  await pool.query(
    `UPDATE media_assets SET asset_type = 'swatch', sort_order = sort_order + 100 WHERE id = ANY($1)`,
    [toDemote.map(d => d.id)]
  );
}
console.log(`Demoted ${toDemote.length} wrong primaries to swatch. Backup: ./data/msi-vision-demote-backup-${stamp}.json`);
await pool.end();
