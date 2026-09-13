/**
 * MSI image gallery cleanup (idempotent, DRY-RUN by default).
 *
 * Three safe passes over MSI media_assets:
 *   1. JUNK PURGE — delete non-product filler wrongly attached to galleries:
 *      installation flyers, warranty cards, underlayment spec shots,
 *      social-media/download images, brochures, care guides, spec sheets.
 *   2. LIFESTYLE-AS-PRIMARY — a room scene must never be the main thumbnail.
 *      Where a product's primary is a room scene, promote its best product
 *      shot (a non-lifestyle alternate) to primary and demote the room scene
 *      to lifestyle. Products with ONLY a room scene are left untouched (never
 *      make a product image-less).
 *   3. LIFESTYLE CAP — keep at most CAP room-scene images per product (lowest
 *      sort_order first), delete the rest to de-clutter the gallery.
 *
 * Every deleted/updated row is written to a backup JSON for rollback.
 *
 * Usage:
 *   DB_PASSWORD=postgres node scripts/fix-msi-image-cleanup.mjs            # DRY RUN
 *   DB_PASSWORD=postgres node scripts/fix-msi-image-cleanup.mjs --apply    # commit
 *   ... --cap=3   # lifestyle images kept per product (default 3)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const APPLY = process.argv.includes('--apply');
const CAP = parseInt((process.argv.find(a => a.startsWith('--cap=')) || '--cap=3').split('=')[1], 10);

// Non-product filler. Deliberately specific so we never nuke a real tile shot.
const JUNK_RE = /\/flyers\/|\/social-media\/|\/brochures\/|underlayment|warranty|\/download\.|care-guide|care-and-maintenance|installation-guide|installation-warranty|spec-?sheet|-tds\.|\/logos?\/|placeholder/i;
// Room-scene / lifestyle markers in the URL (independent of asset_type tag).
const LIFESTYLE_RE = /roomscene|lifestyle|-rs-|_rs_|\/room[\/-]|\/scenes?\//i;

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const log = (...a) => console.log(...a);
  log(`MSI image cleanup — ${APPLY ? 'APPLY' : 'DRY RUN'} (lifestyle cap=${CAP})`);

  const { rows: media } = await pool.query(`
    SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, ma.sort_order
    FROM media_assets ma JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
    ORDER BY ma.product_id, ma.sort_order NULLS LAST, ma.id`, [VENDOR_ID]);

  const backup = { deleted: [], demoted: [], promoted: [] };
  const toDelete = new Set();

  // ── Pass 1: junk purge ──
  let junk = 0;
  for (const m of media) {
    if (JUNK_RE.test(m.url)) { toDelete.add(m.id); backup.deleted.push(m); junk++; }
  }

  // Group surviving media by product for passes 2 & 3
  const byProduct = new Map();
  for (const m of media) {
    if (toDelete.has(m.id)) continue;
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push(m);
  }

  // ── Pass 2: lifestyle-as-primary → promote a product shot ──
  let demoted = 0, promoted = 0;
  const isLifestyle = (m) => m.asset_type === 'lifestyle' || LIFESTYLE_RE.test(m.url);
  const promote = []; // {id} → primary
  const demote = [];  // {id} → lifestyle
  for (const [pid, list] of byProduct) {
    const primary = list.find(m => m.asset_type === 'primary');
    if (!primary || !isLifestyle(primary)) continue;
    // best replacement = first non-lifestyle image by sort order
    const shot = list.find(m => !isLifestyle(m) && m.id !== primary.id);
    if (!shot) continue; // only a room scene exists — leave it, don't blank the product
    demote.push(primary); demoted++;
    promote.push(shot); promoted++;
    backup.demoted.push(primary); backup.promoted.push(shot);
  }

  // ── Pass 3: cap lifestyle images per product ──
  let capped = 0;
  for (const [pid, list] of byProduct) {
    const lifeStyles = list.filter(m => isLifestyle(m) && !demote.find(d => d.id === m.id));
    if (lifeStyles.length <= CAP) continue;
    // keep the first CAP (lowest sort_order), delete the rest
    for (const m of lifeStyles.slice(CAP)) {
      if (!toDelete.has(m.id)) { toDelete.add(m.id); backup.deleted.push(m); capped++; }
    }
  }

  log('');
  log('════════ PLAN ════════');
  log(`  Junk images to delete:        ${junk}`);
  log(`  Lifestyle primaries to fix:   ${demoted} (promote ${promoted} product shots)`);
  log(`  Excess lifestyle to delete:   ${capped}`);
  log(`  Total media rows deleted:     ${toDelete.size}`);

  if (APPLY) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // promote/demote first (before any delete) so primary reassignment is clean
      for (const m of demote) await client.query("UPDATE media_assets SET asset_type='lifestyle' WHERE id=$1", [m.id]);
      for (const m of promote) await client.query("UPDATE media_assets SET asset_type='primary' WHERE id=$1", [m.id]);
      if (toDelete.size) await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [[...toDelete]]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    const bpath = path.join(__dirname, `../data/msi-image-cleanup-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
    log(`\n  Applied. Backup → ${bpath}`);
  } else {
    log('\n  DRY RUN — re-run with --apply to commit.');
    log('  Sample junk:');
    for (const m of backup.deleted.filter(d => JUNK_RE.test(d.url)).slice(0, 8)) log(`    [${m.asset_type}] ${m.url}`);
  }
  await pool.end();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
