#!/usr/bin/env node
/**
 * One-time backfill: send 997 acknowledgments for specific already-received
 * Daltile 832 files. Mirrors the scraper's live ack path exactly.
 *
 * Usage: node backend/scripts/send-997-backfill.js <remotePath> [<remotePath> ...]
 */
import pg from 'pg';
import { Client as FTPClient } from 'basic-ftp';
import { Writable } from 'stream';
import { generate997 } from '../services/ediGenerator.js';
import { createFtpConnection, uploadFile } from '../services/ediFtp.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const FILES = process.argv.slice(2);
if (!FILES.length) { console.error('No files given'); process.exit(1); }

async function downloadString(client, remotePath) {
  const chunks = [];
  const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  await client.downloadTo(w, remotePath);
  return Buffer.concat(chunks).toString('utf-8');
}

async function run() {
  const v = await pool.query("SELECT id, edi_config FROM vendors WHERE code = 'DAL'");
  const vendorId = v.rows[0].id;
  const cfg = v.rows[0].edi_config;
  const inboxDir = cfg.inbox_dir || '/Inbox';

  const ftp = await createFtpConnection(cfg);
  let sent = 0;
  try {
    for (const remote of FILES) {
      const name = remote.split('/').pop();
      const raw = await downloadString(ftp, remote);
      const acks = await generate997(pool, vendorId, cfg, raw, name);
      if (!acks.length) { console.log(`${name}: no functional group — skipped`); continue; }
      for (const ack of acks) {
        const txn = await pool.query(
          `INSERT INTO edi_transactions
             (vendor_id, document_type, direction, filename, interchange_control_number, status, raw_content)
           VALUES ($1, '997', 'outbound', $2, $3, 'pending', $4) RETURNING id`,
          [vendorId, ack.filename, ack.icn, ack.content]
        );
        const txnId = txn.rows[0].id;
        try {
          await uploadFile(ftp, `${inboxDir}/${ack.filename}`, ack.content);
          await pool.query(`UPDATE edi_transactions SET status='sent', processed_at=CURRENT_TIMESTAMP WHERE id=$1`, [txnId]);
          sent++;
          const g = ack.ackGroup;
          console.log(`SENT ${name} -> ${inboxDir}/${ack.filename} (acks ${g.groupCode} #${g.groupControlNumber}, ${g.transactionSets.length} TS)`);
        } catch (err) {
          await pool.query(`UPDATE edi_transactions SET status='error', error_message=$2 WHERE id=$1`, [txnId, err.message]);
          console.error(`FAILED ${name}: ${err.message}`);
        }
      }
    }
  } finally {
    try { ftp.close(); } catch {}
  }
  console.log(`\nDone: ${sent} acknowledgment(s) sent.`);
  await pool.end();
}

run().catch(e => { console.error('ERROR:', e); process.exit(1); });
