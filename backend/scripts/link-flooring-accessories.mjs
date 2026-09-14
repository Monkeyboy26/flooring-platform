/**
 * Link coordinating trim/molding accessories to their flooring products via the
 * sku_accessories relation (NON-destructive: inserts link rows only, never moves
 * or deletes a SKU/product). Accessories keep their own "<Collection> Trims"
 * product; the relation makes them surface on the flooring PDP.
 *
 * Vendor conventions are config-driven. GALL (Galleher): accessories live in a
 * "<Collection> Trims" collection; each trim SKU's variant_name is
 * "<Type> — <Color>" (e.g. "T-Molding — Berwick"). The coordinating floor is the
 * product in collection "<Collection>" whose name = "<Color>".
 *
 * Usage:
 *   DB_PASSWORD=postgres node scripts/link-flooring-accessories.mjs GALL          # DRY RUN
 *   DB_PASSWORD=postgres node scripts/link-flooring-accessories.mjs GALL --apply
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const VENDOR = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2].toUpperCase() : 'GALL';

const FLOOR_CATS = ['engineered-hardwood', 'lvp-plank', 'laminate', 'wood-look-tile'];

// Per-vendor matching config. Each returns, for an accessory SKU row
// {collection, variant_name, name}, the { baseCollection, color, accType } used
// to find the coordinating floor product (collection ILIKE baseCollection AND
// lower(name)=lower(color)).
const CONFIG = {
  GALL: {
    accWhere: `p.collection ~* 'Trims?$' AND s.variant_name ~ '—'`,
    parse: (r) => {
      const baseCollection = r.collection.replace(/\s*Trims?$/i, '').trim();
      const parts = r.variant_name.split('—');
      const accType = (parts[0] || '').trim();
      const color = (parts[1] || '').replace(/,\s*\([^)]*\)\s*$/, '').trim(); // drop trailing ", (SKU)"
      return { baseCollection, color, accType };
    },
  },
};

async function main() {
  const cfg = CONFIG[VENDOR];
  if (!cfg) { console.error(`No config for vendor ${VENDOR}. Known: ${Object.keys(CONFIG).join(', ')}`); process.exit(1); }
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const log = (...a) => console.log(...a);
  log(`Link flooring accessories — vendor ${VENDOR} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const { rows: vrows } = await pool.query('SELECT id FROM vendors WHERE code=$1', [VENDOR]);
  if (!vrows.length) { console.error('vendor not found'); process.exit(1); }
  const vid = vrows[0].id;

  // Accessory SKUs
  const { rows: accs } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type, s.accessory_label,
           p.id AS acc_pid, p.collection, p.name
    FROM skus s JOIN products p ON p.id=s.product_id
    WHERE p.vendor_id=$1 AND s.status='active' AND (${cfg.accWhere})`, [vid]);

  // Floor products index: (lower(collection), lower(name)) -> {pid, sku_id}
  const { rows: floors } = await pool.query(`
    SELECT p.id AS pid, p.collection, p.name, s.id AS sku_id
    FROM products p JOIN categories c ON c.id=p.category_id
    JOIN skus s ON s.product_id=p.id AND s.status='active'
    WHERE p.vendor_id=$1 AND c.slug = ANY($2)`, [vid, FLOOR_CATS]);
  const floorIdx = new Map();
  for (const f of floors) {
    const k = `${(f.collection||'').toLowerCase().trim()}|||${(f.name||'').toLowerCase().trim()}`;
    if (!floorIdx.has(k)) floorIdx.set(k, []);
    floorIdx.get(k).push(f);
  }

  const links = []; // {parent_sku_id, accessory_sku_id}
  const labelUpdates = []; // {sku_id, label}
  const unmatched = [];
  for (const a of accs) {
    const { baseCollection, color, accType } = cfg.parse(a);
    if (!color) { unmatched.push({ ...a, reason: 'no color' }); continue; }
    const k = `${baseCollection.toLowerCase().trim()}|||${color.toLowerCase().trim()}`;
    const targets = floorIdx.get(k);
    if (!targets || !targets.length) { unmatched.push({ ...a, baseCollection, color, reason: 'no floor match' }); continue; }
    for (const t of targets) links.push({ parent_sku_id: t.sku_id, accessory_sku_id: a.sku_id });
    if (accType && a.accessory_label !== accType) labelUpdates.push({ sku_id: a.sku_id, label: accType });
  }

  log('');
  log('════════ PLAN ════════');
  log(`  Accessory SKUs considered:   ${accs.length}`);
  log(`  Matched → links to insert:   ${links.length} (distinct accessories: ${new Set(links.map(l=>l.accessory_sku_id)).size})`);
  log(`  Accessory labels to set:     ${labelUpdates.length}`);
  log(`  Unmatched accessories:       ${unmatched.length}`);
  log('');
  log('  Unmatched samples:');
  for (const u of unmatched.slice(0, 12)) log(`    ${u.vendor_sku}  "${u.variant_name}"  [${u.reason}${u.baseCollection?`: ${u.baseCollection}/${u.color}`:''}]`);

  if (APPLY) {
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (const l of links) {
        const r = await client.query(
          `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id) VALUES ($1,$2)
           ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`, [l.parent_sku_id, l.accessory_sku_id]);
        inserted += r.rowCount;
      }
      for (const u of labelUpdates)
        await client.query(`UPDATE skus SET accessory_label=$1, variant_type='accessory' WHERE id=$2`, [u.label, u.sku_id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    const bpath = path.join(__dirname, `../data/${VENDOR.toLowerCase()}-accessory-links-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(bpath, JSON.stringify({ links, labelUpdates }, null, 2));
    log(`\n  Applied: ${inserted} new links, ${labelUpdates.length} labels set. Backup → ${bpath}`);
  } else {
    log('\n  DRY RUN — re-run with --apply to commit.');
  }
  await pool.end();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
