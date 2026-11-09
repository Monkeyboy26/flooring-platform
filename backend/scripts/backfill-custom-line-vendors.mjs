// Backfill vendor_id onto existing vendorless custom (off-catalog) order/quote
// lines so they stop silently falling off their purchase orders.
//
// Phase 0 of the custom-item overhaul closed the WRITE paths that let a custom
// line be stored with a NULL vendor_id (see [[po-vendorless-custom-line-drop]]).
// This script repairs rows CREATED BEFORE that fix:
//
//   order_items / quote_items where
//     sku_id IS NULL AND product_id IS NULL AND vendor_id IS NULL
//     AND COALESCE(item_type,'material') <> 'labor' AND NOT COALESCE(is_sample,false)
//     AND NOT COALESCE(is_custom_rug,false)
//
// Rows WITH a custom_vendor name → resolve to a real vendor_id (reuse an existing
// vendor by case-insensitive name, else create a one-off vendor record, mirroring
// server.js findOrCreateOneOffVendor). A created one-off vendor may lack an email;
// setting vendor_id still fixes PO *generation* (the line now appears on the PO) —
// sending just needs an email filled in later. Such vendors are reported.
//
// Rows WITHOUT any vendor name (vendorless AND nameless) cannot be resolved and
// are LISTED for a manual call — never guessed.
//
// estimate_items had no vendor columns until Phase 0, so pre-existing custom
// estimate lines carry no recoverable vendor; they are only reported, not written.
//
// Dry-run by default. --apply writes, after a JSON backup of every touched row in
// backend/data/custom-line-vendor-backfill-backup-<ISO>.json.
//
// Usage:
//   node backend/scripts/backfill-custom-line-vendors.mjs            # dry-run
//   node backend/scripts/backfill-custom-line-vendors.mjs --apply    # write
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// quote_items has no item_type column (labor is an order/estimate concept only),
// so the labor exclusion is applied only where the column exists.
const vendorlessWhere = (hasItemType) => `
  sku_id IS NULL AND product_id IS NULL AND vendor_id IS NULL
  ${hasItemType ? "AND COALESCE(item_type, 'material') <> 'labor'" : ''}
  AND NOT COALESCE(is_sample, false)
  AND NOT COALESCE(is_custom_rug, false)
`;

// Mirror server.js findOrCreateOneOffVendor: reuse by name, else create one-off.
async function findOrCreateOneOffVendor(client, name, email) {
  const trimmed = String(name).trim();
  const existing = await client.query(
    'SELECT id, email FROM vendors WHERE LOWER(name) = LOWER($1) LIMIT 1', [trimmed]);
  if (existing.rows.length) {
    const v = existing.rows[0];
    if (email && !v.email) {
      await client.query('UPDATE vendors SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [email, v.id]);
    }
    return { id: v.id, created: false, email: v.email || email || null };
  }
  let code = null;
  for (let attempt = 0; attempt < 50 && !code; attempt++) {
    const candidate = String(100 + Math.floor(Math.random() * 900));
    if (!(await client.query('SELECT 1 FROM vendors WHERE code = $1 OR public_code = $1', [candidate])).rows.length) code = candidate;
  }
  if (!code) {
    for (let n = 100; n <= 999 && !code; n++) {
      if (!(await client.query('SELECT 1 FROM vendors WHERE code = $1 OR public_code = $1', [String(n)])).rows.length) code = String(n);
    }
  }
  if (!code) throw new Error('No vendor code available (100-999 exhausted)');
  const ins = await client.query(
    `INSERT INTO vendors (name, code, public_code, email, is_active, is_one_off)
     VALUES ($1, $2, $2, $3, true, true) RETURNING id`,
    [trimmed, code, email || null]);
  return { id: ins.rows[0].id, created: true, email: email || null };
}

async function scan(client, table, idCol, hasItemType) {
  const { rows } = await client.query(
    `SELECT id, ${idCol} AS parent_id, product_name, custom_vendor, unit_price, subtotal
       FROM ${table} WHERE ${vendorlessWhere(hasItemType)} ORDER BY id`);
  return rows.map(r => ({ ...r, table, idCol }));
}

async function main() {
  const client = await pool.connect();
  try {
    const orderRows = await scan(client, 'order_items', 'order_id', true);
    const quoteRows = await scan(client, 'quote_items', 'quote_id', false);
    const named = [...orderRows, ...quoteRows].filter(r => r.custom_vendor && String(r.custom_vendor).trim());
    const nameless = [...orderRows, ...quoteRows].filter(r => !(r.custom_vendor && String(r.custom_vendor).trim()));

    // estimate_items (report only — no recoverable vendor pre-Phase-0)
    let estCount = 0;
    try {
      const est = await client.query(`SELECT COUNT(*)::int AS n FROM estimate_items WHERE ${vendorlessWhere(true)}`);
      estCount = est.rows[0].n;
    } catch { /* columns may predate migration in a stale env */ }

    console.log(`\n=== Vendorless custom lines ===`);
    console.log(`  order_items:    ${orderRows.length}`);
    console.log(`  quote_items:    ${quoteRows.length}`);
    console.log(`  estimate_items: ${estCount} (report only — no recoverable vendor)`);
    console.log(`  → resolvable (have a name): ${named.length}`);
    console.log(`  → UNRESOLVABLE (no name):   ${nameless.length}\n`);

    if (nameless.length) {
      console.log('UNRESOLVABLE — need a manual vendor decision (not touched):');
      for (const r of nameless) {
        console.log(`  [${r.table}] ${r.parent_id}  "${r.product_name || '(no name)'}"  $${r.subtotal}`);
      }
      console.log('');
    }

    if (!named.length) { console.log('No resolvable rows. Done.'); return; }

    if (!APPLY) {
      console.log('DRY RUN — would resolve these (pass --apply to write):');
      const byName = {};
      for (const r of named) { const k = String(r.custom_vendor).trim(); (byName[k] ||= []).push(r); }
      for (const [name, rows] of Object.entries(byName)) {
        console.log(`  "${name}" → ${rows.length} line(s) across ${new Set(rows.map(r => r.table + ':' + r.parent_id)).size} doc(s)`);
      }
      console.log('\nRe-run with --apply to write.');
      return;
    }

    // --- APPLY ---
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(DATA_DIR, `custom-line-vendor-backfill-backup-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ when: ts, order_items: orderRows, quote_items: quoteRows }, null, 2));
    console.log(`Backup written: ${backupPath}\n`);

    await client.query('BEGIN');
    const resolvedCache = new Map(); // lower(name) -> vendorId
    const createdVendors = [];
    let touched = 0;
    for (const r of named) {
      const name = String(r.custom_vendor).trim();
      const key = name.toLowerCase();
      let vendorId = resolvedCache.get(key);
      if (!vendorId) {
        const v = await findOrCreateOneOffVendor(client, name, null);
        vendorId = v.id;
        resolvedCache.set(key, vendorId);
        if (v.created) createdVendors.push({ name, email: v.email });
      }
      await client.query(`UPDATE ${r.table} SET vendor_id = $1 WHERE id = $2`, [vendorId, r.id]);
      touched++;
    }
    await client.query('COMMIT');

    console.log(`Updated ${touched} line(s). Resolved ${resolvedCache.size} distinct vendor name(s).`);
    if (createdVendors.length) {
      console.log(`\nCreated ${createdVendors.length} one-off vendor record(s) — add an email before sending their POs:`);
      for (const v of createdVendors) console.log(`  "${v.name}"${v.email ? '' : '  (NO EMAIL)'}`);
    }
    if (nameless.length) {
      console.log(`\n${nameless.length} nameless line(s) were NOT touched — resolve those manually (listed above).`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
