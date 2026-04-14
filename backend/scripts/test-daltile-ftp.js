#!/usr/bin/env node

/**
 * Quick test: connect to Daltile B2B FTP and list files in Outbox.
 * Usage: node backend/scripts/test-daltile-ftp.js
 */

import { Client } from 'basic-ftp';

const config = {
  host: 'daltileb2b.daltile.com',
  port: 21,
  user: '7149990009',
  password: 'W5y5p6L6',
  secure: false,
};

async function main() {
  const client = new Client();
  client.ftp.verbose = false;

  try {
    console.log(`Connecting to ${config.host}...`);
    await client.access(config);
    console.log('Connected successfully.\n');

    // List root
    console.log('=== Root Directory ===');
    const root = await client.list('/');
    for (const f of root) {
      console.log(`  ${f.type === 2 ? '[DIR]' : '[FILE]'}  ${f.name}  (${f.size} bytes)`);
    }
    console.log('');

    // List Outbox
    console.log('=== /Outbox ===');
    try {
      const outbox = await client.list('/Outbox');
      if (outbox.length === 0) {
        console.log('  (empty)');
      }
      for (const f of outbox) {
        const modified = f.modifiedAt ? f.modifiedAt.toISOString() : 'unknown';
        console.log(`  ${f.type === 2 ? '[DIR]' : '[FILE]'}  ${f.name}  (${f.size} bytes, modified: ${modified})`);
      }
    } catch (err) {
      console.log(`  Could not list /Outbox: ${err.message}`);
    }
    console.log('');

    // List Inbox
    console.log('=== /Inbox ===');
    try {
      const inbox = await client.list('/Inbox');
      if (inbox.length === 0) {
        console.log('  (empty)');
      }
      for (const f of inbox) {
        console.log(`  ${f.type === 2 ? '[DIR]' : '[FILE]'}  ${f.name}  (${f.size} bytes)`);
      }
    } catch (err) {
      console.log(`  Could not list /Inbox: ${err.message}`);
    }

    // If there are files in outbox, peek at the first one
    try {
      const outbox = await client.list('/Outbox');
      const dataFiles = outbox.filter(f => f.type !== 2);
      if (dataFiles.length > 0) {
        const first = dataFiles[0];
        console.log(`\n=== Preview: /Outbox/${first.name} (first 2000 chars) ===`);
        const chunks = [];
        await client.downloadTo({
          write(chunk) { chunks.push(chunk); },
          end() {},
          on() { return this; },
          once() { return this; },
          emit() { return this; },
          removeListener() { return this; },
        }, `/Outbox/${first.name}`);
        const content = Buffer.concat(chunks).toString('utf-8');
        console.log(content.slice(0, 2000));
        if (content.length > 2000) console.log(`\n... (${content.length} total chars)`);
      }
    } catch (err) {
      console.log(`  Preview failed: ${err.message}`);
    }

  } catch (err) {
    console.error('FTP connection failed:', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

main();
