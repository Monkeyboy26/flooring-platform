/**
 * daltile-feed-cache.mjs — fetch + parse the live 832 feed once, cache priced items
 * to /tmp so the crosswalk-grow matcher can iterate offline. READ-ONLY.
 */
import fs from 'fs';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
const { parse832 } = __test__;
const DAL = '550e8400-e29b-41d4-a716-446655440003';

const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const ftp = await createFtpConnection(cfg);
const items = [];
try {
  const files = (await findRemote832Files(ftp)).filter(f => !/archive/i.test(f.remotePath));
  for (const f of files) {
    const local = '/tmp/dalfc-' + f.name;
    await ftp.downloadTo(local, f.remotePath);
    try { items.push(...parse832(fs.readFileSync(local, 'utf-8')).items); } catch (e) { console.error('parse fail', f.name, e.message); }
    try { fs.unlinkSync(local); } catch {}
  }
} finally { try { ftp.close(); } catch {} }

const priced = items.filter(it => it.vendor_sku && it.cost != null && it.cost > 0).map(it => ({
  vendor_sku: it.vendor_sku, product_name: it.product_name, color: it.color, collection: it.collection,
  cost: it.cost, uom: it.unit_of_measure, sqft_per_box: it.sqft_per_box, pieces_per_box: it.pieces_per_box,
}));
fs.writeFileSync('/tmp/dal-feed-priced.json', JSON.stringify(priced));
console.log(`cached ${priced.length} priced EDI items -> /tmp/dal-feed-priced.json`);
await pool.end();
