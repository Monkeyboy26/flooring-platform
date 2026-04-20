#!/usr/bin/env node
/**
 * Test script: verify isDnavAccessory() detection against live DNav data.
 */
async function main() {
  const { pool } = await import('../db.js');
  const { triwestLogin } = await import('../scrapers/triwest-auth.js');
  const { searchByManufacturer } = await import('../scrapers/triwest-search.js');

  const jobId = '00d73f2e-965b-4a04-a5c8-869a79417697';
  console.log('Logging into DNav...');
  const { browser, page } = await triwestLogin(pool, jobId);
  console.log('Searching PRO...');
  const rows = await searchByManufacturer(page, 'PRO', pool, jobId);
  console.log(`Total DNav rows: ${rows.length}`);
  await browser.close().catch(() => {});

  // Updated detection logic
  const ACCESSORY_PATTERN_WORDS = [
    'STAIRNOSE', 'STAIR NOSE', 'STAIR NS', 'STR NS', 'FLUSH SN',
    'REDUCER', 'T-MLDG', 'T MLDG', 'T-MOLD',
    'QTR RND', 'QUARTER ROUND', 'END CAP', 'SQR NOSE', 'SQUARE NOSE',
    'THRESHOLD', 'BULLNOSE', 'MULTI-PURPOSE', 'MULTI PURPOSE',
    'FLUSH MOUNT', 'FLUSH MT', 'BABY THRESHOLD', 'BABY THRESH',
    'OVERLAP', 'TRANSITION', 'SCOTIA', 'SHOE MOLD', 'SHOE MOULD',
    'CLEANER', 'TOUCH UP', 'REPAIR KIT', 'REFRESHER', 'OSMO',
    'COLOR SET', 'CUSTOM MOLD', 'STAIN', 'OIL REFRESH',
    'MAINTENANCE', 'FABRICATED',
  ];
  const ACCESSORY_RE = /\b(stair\s*nos?e?|stair\s*ns|str\s*ns|flush\s*sn|reducer|t[- ]?mold|t[- ]?mldg|bullnose|quarter\s*round|qtr\s*rnd|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[- ]?purpose|transition|scotia|shoe\s*mold|cleaner|touch\s*up|repair\s*kit|oil\s*refresh|stain\b|custom\s*mold|maintenance|fabricated|color\s*set)/i;

  function isDnavAccessory(row) {
    const combined = `${row.pattern || ''} ${row.productName || ''} ${row.rawDescription || ''} ${row.color || ''}`.toUpperCase();
    for (const ap of ACCESSORY_PATTERN_WORDS) {
      if (combined.includes(ap)) return true;
    }
    if (ACCESSORY_RE.test(combined)) return true;
    if (row.unit === 'PC' || row.unit === 'EA' || row.unit === 'ST') return true;
    return false;
  }

  let accCount = 0, floorCount = 0;
  const unclear = [];

  for (const r of rows) {
    const isAcc = isDnavAccessory(r);
    if (isAcc) {
      accCount++;
    } else if (r.unit !== 'CT' || r.sqftPrice == null || r.sqftPrice === 0) {
      unclear.push(r);
    } else {
      floorCount++;
    }
  }

  console.log(`\nDetected accessories: ${accCount}`);
  console.log(`Flooring: ${floorCount}`);
  console.log(`Unclear/missed: ${unclear.length}`);

  if (unclear.length > 0) {
    console.log('\n=== STILL MISSED ===');
    for (const u of unclear) {
      console.log(`  [${u.unit}] ${u.itemNumber} | pat: ${u.pattern} | prod: ${u.productName} | color: ${u.color} | sqft: ${u.sqftPrice}`);
    }
  } else {
    console.log('\nAll non-flooring items correctly detected as accessories!');
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
