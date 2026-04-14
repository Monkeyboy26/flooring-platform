#!/usr/bin/env node
/**
 * Test Daltile FTP with various TLS/security modes.
 */
import { Client } from 'basic-ftp';
import { Readable } from 'stream';

const creds = {
  host: 'daltileb2b.daltile.com',
  port: 21,
  user: '7149990009',
  password: 'W5y5p6L6',
};

async function tryMode(label, opts) {
  const client = new Client();
  client.ftp.verbose = false;
  try {
    console.log(`\n=== ${label} ===`);
    await client.access({ ...creds, ...opts });
    console.log('Connected!');

    // List
    const inbox = await client.list('/Inbox');
    console.log(`/Inbox: ${inbox.length} files`);

    // Try write
    const stream = Readable.from(['TEST']);
    await client.uploadFrom(stream, '/Inbox/test.txt');
    console.log('✓ Write to /Inbox succeeded!');
    try { await client.remove('/Inbox/test.txt'); } catch {}
  } catch (err) {
    console.log(`${err.code || 'ERR'}: ${err.message.split('\n')[0]}`);
  } finally {
    client.close();
  }
}

async function main() {
  // Explicit TLS (STARTTLS on port 21)
  await tryMode('Explicit TLS (STARTTLS)', { secure: true });

  // Explicit TLS with rejectUnauthorized=false
  await tryMode('Explicit TLS (no cert check)', {
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });

  // Implicit TLS (port 990)
  await tryMode('Implicit TLS (port 990)', {
    port: 990,
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });

  // Passive mode explicit
  await tryMode('Plain FTP passive', { secure: false });
}

main().catch(console.error);
