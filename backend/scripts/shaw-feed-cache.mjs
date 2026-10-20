/**
 * shaw-feed-cache.mjs — fetch + parse ALL live Shaw 832 files over SFTP once and
 * cache priced items (with coverage) to /tmp so a coverage backfill can match
 * offline. READ-ONLY (no DB writes). Mirrors scripts/daltile-feed-cache.mjs.
 *
 * NOTE: the Shaw importer's run() only grabs the NEWEST unprocessed file; this
 * merges every 832/catalog file it can list so the full catalog is available.
 *
 *   docker exec -e DB_HOST=db flooring-api node scripts/shaw-feed-cache.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SftpClient = require('ssh2-sftp-client');
import fs from 'fs';
import { pool } from '../db.js';
import { __test__ } from '../scrapers/shaw-832.js';
const { parse832, findRemote832Files, getSftpConfig } = __test__;

const SHAW = '4da72c7d-2f82-458b-aec5-5ec0ba8a554c';
const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [SHAW])).rows[0].edi_config;
const sftpConfig = getSftpConfig({ config: cfg });

const sftp = new SftpClient();
const items = [];
try {
  await sftp.connect(sftpConfig);
  const files = await findRemote832Files(sftp, msg => console.error(msg));
  console.error(`found ${files.length} candidate file(s)`);
  for (const f of files) {
    const local = `/tmp/shawfc-${f.name}`;
    try {
      await sftp.fastGet(f.remotePath, local);
      const cat = parse832(fs.readFileSync(local, 'utf-8'));
      items.push(...(cat.items || []));
    } catch (e) { console.error('parse/download fail', f.name, e.message); }
    try { fs.unlinkSync(local); } catch {}
  }
} finally { await sftp.end().catch(() => {}); }

// de-dupe by vendor_sku (keep the first row that carries coverage, else first seen)
const bySku = new Map();
for (const it of items) {
  if (!it.vendor_sku) continue;
  const prev = bySku.get(it.vendor_sku);
  if (!prev || (!prev.sqft_per_box && it.sqft_per_box)) {
    bySku.set(it.vendor_sku, {
      vendor_sku: it.vendor_sku, product_name: it.product_name, color: it.color,
      sqft_per_box: it.sqft_per_box, pieces_per_box: it.pieces_per_box,
      sell_by: it.sell_by, uom: it.sell_unit_uom || null, cost: it.cost ?? null,
    });
  }
}
const out = [...bySku.values()];
fs.writeFileSync('/tmp/shaw-feed-priced.json', JSON.stringify(out));
console.log(`cached ${out.length} unique EDI items (${out.filter(x => x.sqft_per_box > 0).length} with coverage) -> /tmp/shaw-feed-priced.json`);
await pool.end();
