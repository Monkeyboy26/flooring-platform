#!/usr/bin/env node
/**
 * Dry-run validation for the 997 acknowledgment generator.
 * Downloads one REAL Daltile 832 file and generates the 997 WITHOUT uploading.
 *
 * Usage: node backend/scripts/test-997.js [remotePath]
 */
import pg from 'pg';
import { Client as FTPClient } from 'basic-ftp';
import { Writable } from 'stream';
import { parseReceivedEnvelope, generate997 } from '../services/ediGenerator.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const REMOTE = process.argv[2] || '/users/7149990009/Outbox/Archive/004459087.832';

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

  const ftp = new FTPClient();
  ftp.ftp.verbose = false;
  await ftp.access({ host: cfg.ftp_host, port: cfg.ftp_port || 21, user: cfg.ftp_user, password: cfg.ftp_pass, secure: false });
  console.log(`Downloading ${REMOTE} ...`);
  const raw = await downloadString(ftp, REMOTE);
  ftp.close();
  console.log(`Got ${raw.length} bytes\n`);

  // Show the envelope segments we key off of
  console.log('--- Received envelope (ISA/GS/ST/GE/IEA) ---');
  const segSep = raw.includes('~') ? '~' : '\n';
  for (const s of raw.split(segSep).map(x => x.trim()).filter(Boolean)) {
    const id = s.split(cfg.element_separator || '*')[0];
    if (['ISA', 'GS', 'ST', 'GE', 'IEA'].includes(id)) console.log('  ' + s.slice(0, 110));
  }

  const parsed = parseReceivedEnvelope(raw, cfg);
  console.log('\n--- Parsed ---');
  console.log('  usageIndicator:', parsed.usageIndicator);
  console.log('  groups:', JSON.stringify(parsed.groups.map(g => ({ code: g.groupCode, ctrl: g.groupControlNumber, ver: g.version, ts: g.transactionSets.length }))));

  const acks = await generate997(pool, vendorId, cfg, raw, REMOTE.split('/').pop());
  console.log(`\n--- Generated ${acks.length} 997(s) [DRY RUN, not uploaded] ---`);
  for (const a of acks) {
    console.log(`\nfilename: ${a.filename}  icn: ${a.icn}`);
    console.log(a.content);
  }
  await pool.end();
}

run().catch(e => { console.error('ERROR:', e); process.exit(1); });
