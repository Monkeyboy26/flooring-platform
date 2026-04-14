#!/usr/bin/env node
/**
 * Test which FTP directories we can write to on Daltile B2B.
 */
import { Client } from 'basic-ftp';
import { Readable } from 'stream';

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

  await client.access(config);
  console.log('Connected\n');

  // List root to see all directories
  console.log('=== Root ===');
  const root = await client.list('/');
  for (const f of root) {
    console.log(`  ${f.type === 2 ? '[DIR]' : '[FILE]'}  ${f.name}  (${f.size} bytes)`);
  }

  // Try writing to each possible location
  const testContent = 'TEST FILE - DELETE ME';
  const testFile = 'test-upload.txt';
  const dirsToTry = ['/', '/Inbox', '/Outbox', '/Outbox/Archive'];

  for (const dir of dirsToTry) {
    const path = dir === '/' ? `/${testFile}` : `${dir}/${testFile}`;
    try {
      const stream = Readable.from([testContent]);
      await client.uploadFrom(stream, path);
      console.log(`\n✓ Can WRITE to ${dir} — uploaded ${path}`);
      // Clean up
      try { await client.remove(path); console.log(`  Cleaned up ${path}`); } catch {}
    } catch (err) {
      console.log(`\n✗ Cannot WRITE to ${dir} — ${err.code}: ${err.message.split('\n')[0]}`);
    }
  }

  // Also check what's in each dir
  for (const dir of ['/Inbox', '/Outbox', '/Outbox/Archive']) {
    try {
      const listing = await client.list(dir);
      console.log(`\n${dir}: ${listing.length} files`);
      for (const f of listing) {
        console.log(`  ${f.type === 2 ? '[DIR]' : '[FILE]'}  ${f.name}  (${f.size} bytes)`);
      }
    } catch (err) {
      console.log(`\n${dir}: Cannot list — ${err.message.split('\n')[0]}`);
    }
  }

  client.close();
}

main().catch(console.error);
