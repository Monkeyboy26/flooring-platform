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

// Per-vendor matching config. Unified key model: every vendor supplies
//   accWhere  — SQL filter selecting its accessory SKUs
//   accKey(r) — match key string from an accessory row (null = skip)
//   floorKey(r) — match key string from a floor row
//   label(r)  — optional accessory_label to set for display
// An accessory links to every floor SKU whose floorKey equals its accKey.
// Rows carry {vendor_sku, collection, name, variant_name, accessory_label}.
const norm = (s) => (s || '').toLowerCase().replace(/\bgr[ae]y\b/g, 'gry').replace(/\s+/g, ' ').trim();
const seg = (vsku, i) => (vsku || '').split('-')[i] || '';

const CONFIG = {
  // Galleher: accessories in "<Collection> Trims", variant "Type — Color".
  GALL: {
    accWhere: `p.collection ~* 'Trims?$' AND s.variant_name ~ '—'`,
    accKey: (r) => {
      const base = r.collection.replace(/\s*Trims?$/i, '').trim();
      const color = (r.variant_name.split('—')[1] || '').replace(/,\s*\([^)]*\)\s*$/, '').trim();
      return color ? `${norm(base)}|${norm(color)}` : null;
    },
    floorKey: (r) => `${norm(r.collection)}|${norm(r.name)}`,
    label: (r) => (r.variant_name.split('—')[0] || '').trim() || null,
  },
  // NOTE: Tile World (TW) is intentionally NOT configured. Its flooring
  // products are catch-all buckets that mix real planks with miscategorized
  // trims (e.g. a quarter-round SKU sitting in lvp-plank), and its
  // "collections" lump multiple distinct product lines together. Color-based
  // linking there produces wrong associations — TW needs its categorization
  // untangled (data-quality pass) before accessories can be linked safely.

  // Engineered Floors: vendor_sku = 1-<LINE>-<COLOR>-<SIZE>-<TYPE>. Match on
  // line-code + color-code (segments 2 & 3). Accessory_label already clean.
  EF: {
    accWhere: `s.variant_type='accessory' AND s.vendor_sku ~ '^1-[A-Za-z0-9]+-[0-9]+-'`,
    accKey: (r) => `${seg(r.vendor_sku,1).toLowerCase()}|${seg(r.vendor_sku,2).toLowerCase()}`,
    floorKey: (r) => (/^1-[A-Za-z0-9]+-[0-9]+-/.test(r.vendor_sku||'')
      ? `${seg(r.vendor_sku,1).toLowerCase()}|${seg(r.vendor_sku,2).toLowerCase()}` : null),
    label: (r) => r.accessory_label || null,
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

  // Floor products index: floorKey -> [{pid, sku_id}]
  const { rows: floors } = await pool.query(`
    SELECT p.id AS pid, p.collection, p.name, s.id AS sku_id, s.vendor_sku
    FROM products p JOIN categories c ON c.id=p.category_id
    JOIN skus s ON s.product_id=p.id AND s.status='active'
    WHERE p.vendor_id=$1 AND c.slug = ANY($2)`, [vid, FLOOR_CATS]);
  const floorIdx = new Map();
  for (const f of floors) {
    const k = cfg.floorKey(f);
    if (!k) continue;
    if (!floorIdx.has(k)) floorIdx.set(k, []);
    floorIdx.get(k).push(f);
  }

  const links = []; // {parent_sku_id, accessory_sku_id}
  const labelUpdates = []; // {sku_id, label}
  const unmatched = [];
  for (const a of accs) {
    const k = cfg.accKey(a);
    if (!k) { unmatched.push({ ...a, reason: 'no key' }); continue; }
    const targets = floorIdx.get(k);
    if (!targets || !targets.length) { unmatched.push({ ...a, key: k, reason: 'no floor match' }); continue; }
    for (const t of targets) links.push({ parent_sku_id: t.sku_id, accessory_sku_id: a.sku_id });
    const lbl = cfg.label ? cfg.label(a) : null;
    if (lbl && a.accessory_label !== lbl) labelUpdates.push({ sku_id: a.sku_id, label: lbl });
  }

  log('');
  log('════════ PLAN ════════');
  log(`  Accessory SKUs considered:   ${accs.length}`);
  log(`  Matched → links to insert:   ${links.length} (distinct accessories: ${new Set(links.map(l=>l.accessory_sku_id)).size})`);
  log(`  Accessory labels to set:     ${labelUpdates.length}`);
  log(`  Unmatched accessories:       ${unmatched.length}`);
  log('');
  log('  Unmatched samples:');
  for (const u of unmatched.slice(0, 12)) log(`    ${u.vendor_sku}  "${u.variant_name}"  [${u.reason}${u.key?`: ${u.key}`:''}]`);

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
