#!/usr/bin/env node
/**
 * EF SKU Diagnostic — Downloads real 832 from SFTP, extracts all identifier
 * formats, then probes the fcB2B API with each format to find what works.
 *
 * Usage:
 *   node backend/scripts/ef-sku-probe.cjs                # SFTP + probe
 *   node backend/scripts/ef-sku-probe.cjs --file /path   # Use local 832 file
 *   node backend/scripts/ef-sku-probe.cjs --skip-sftp    # Probe only (use DB SKUs)
 */

const SftpClient = require('ssh2-sftp-client');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SFTP_CONFIG = {
  host: process.env.ENGFLOORS_SFTP_HOST || 'ftp.engfloors.org',
  port: parseInt(process.env.ENGFLOORS_SFTP_PORT || '22', 10),
  username: process.env.ENGFLOORS_SFTP_USER || '18110',
  password: process.env.ENGFLOORS_SFTP_PASS || 'wSQiFrDM',
};

const FCB2B = {
  base_url: 'https://www.engfloors.info/B2B',
  api_key: 'ENGFLOORWSV1',
  secret_key: '1WDE34',
  client_id: '18110',
};

const REMOTE_DIRS = [
  '/opt/OpenAS2/data', '/opt/OpenAS2/data/toAny',
  '/opt/OpenAS2/data/fromAny', '/opt/OpenAS2',
  '/outbound', '/inbound', '/out', '/in', '/832',
  '/Outbound', '/Inbound', '/OUT', '/IN',
  '/data', '/data/outbound', '/data/inbound',
  '/edi', '/edi/outbound', '/edi/inbound',
  '/export', '/import',
  '/home/18110', '/sftpusers/18110',
  '/',
];

// LIN qualifier codes
const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku',
  MG: 'manufacturer_group', BP: 'buyer_part_number',
  IN: 'buyer_item_number', MN: 'model_number',
  GN: 'generic_name', UA: 'upc_case_code',
  CB: 'catalog_number', FS: 'standard_number',
  EC: 'ean', EN: 'ean', UK: 'upc_shipping',
  PI: 'purchaser_item', PN: 'part_number', VA: 'vendor_alpha',
};

const PID_CODES = {
  '08': 'description', GEN: 'category', '09': 'sub_product',
  '73': 'color', '74': 'pattern', '75': 'finish',
  '35': 'species', '37': 'material', '38': 'style',
  DIM: 'dimensions', MAC: 'material_class', '12': 'quality', '77': 'collection',
};

// ---------------------------------------------------------------------------
// EDI Parser (minimal — just to extract identifiers + descriptions)
// ---------------------------------------------------------------------------

function tokenize(raw) {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const segs = text.includes('~') ? text.split('~') : text.split('\n');
  return segs.map(s => s.trim()).filter(Boolean);
}

function parse832ForIdentifiers(raw) {
  const segments = tokenize(raw);
  const items = [];
  let current = null;

  for (const segStr of segments) {
    const el = segStr.split('*');
    const id = el[0];

    if (id === 'LIN') {
      if (current) items.push(current);
      // Parse ALL identifiers from LIN
      const identifiers = {};
      const rawQualifiers = {};
      for (let i = 2; i < el.length - 1; i += 2) {
        const qual = el[i], val = el[i + 1];
        if (qual && val) {
          identifiers[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
          rawQualifiers[qual] = val;
        }
      }
      current = {
        line_number: el[1] || null,
        identifiers,
        rawQualifiers,
        rawLIN: segStr,
        descriptions: [],
        g39Identifiers: {},
      };
    } else if (id === 'PID' && current) {
      const code = el[2] || null;
      const label = PID_CODES[code] || code || 'unknown';
      const desc = el[5] || null;
      if (desc) current.descriptions.push({ code, label, desc });
    } else if (id === 'G39' && current) {
      // G39 can carry additional identifiers
      for (let i = 2; i < Math.min(el.length, 6); i += 2) {
        const qual = el[i], val = el[i + 1];
        if (qual && val) {
          current.g39Identifiers[LIN_QUALIFIERS[qual] || qual] = val;
        }
      }
      if (el[17]) current.g39Description = el[17];
    } else if (id === 'SLN' && current) {
      // Sub-Line Number — might contain SKU variants
      if (!current.sublines) current.sublines = [];
      current.sublines.push({ raw: segStr, elements: el });
    } else if ((id === 'CTT' || id === 'SE') && current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

// ---------------------------------------------------------------------------
// HTTP helper for fcB2B
// ---------------------------------------------------------------------------

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'text/xml, application/xml' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function buildUrl(endpoint, sku) {
  const params = new URLSearchParams({
    ApiKey: FCB2B.api_key,
    Signature: FCB2B.secret_key,
    ClientIdentifier: FCB2B.client_id,
    SupplierItemSKU: sku,
    TimeStamp: new Date().toISOString(),
    GlobalIdentifier: crypto.randomUUID(),
  });
  return `${FCB2B.base_url}/${endpoint}?${params.toString()}`;
}

async function probeAPI(label, sku) {
  try {
    const url = buildUrl('InventoryInquiry', sku);
    const res = await httpsGet(url);
    // Check if response has actual inventory data vs error/empty
    const hasItems = res.body.includes('<AvailableItem') || res.body.includes('<Quantity');
    const hasError = res.body.includes('SKUNotFound') || res.body.includes('<error');
    const isEmpty = res.body.includes('<AvailableItems/>') || res.body.includes('<AvailableItems></AvailableItems>');

    let status;
    if (hasItems) status = 'HIT - DATA FOUND';
    else if (hasError) status = 'SKUNotFound';
    else if (isEmpty) status = 'Empty (no items)';
    else status = `HTTP ${res.status}`;

    console.log(`  [${status}] ${label}: "${sku}"`);
    if (hasItems) {
      console.log(`    >>> RESPONSE: ${res.body.substring(0, 500)}`);
    }
    return { label, sku, status, hasItems, body: res.body };
  } catch (err) {
    console.log(`  [ERROR] ${label}: "${sku}" — ${err.message}`);
    return { label, sku, status: 'error', hasItems: false };
  }
}

// ---------------------------------------------------------------------------
// SFTP download
// ---------------------------------------------------------------------------

async function downloadLatest832() {
  const sftp = new SftpClient();
  try {
    console.log(`\nConnecting to ${SFTP_CONFIG.host}:${SFTP_CONFIG.port} as ${SFTP_CONFIG.username}...`);
    await sftp.connect(SFTP_CONFIG);
    console.log('Connected. Scanning for 832 files...\n');

    const allFiles = [];
    for (const dir of REMOTE_DIRS) {
      try {
        const listing = await sftp.list(dir);
        const matching = listing
          .filter(f => f.type === '-')
          .filter(f => {
            const name = f.name.toLowerCase();
            return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
              || name.endsWith('.edi') || name.endsWith('.x12');
          });
        for (const f of matching) {
          const remotePath = `${dir}/${f.name}`.replace('//', '/');
          console.log(`  Found: ${remotePath} (${(f.size / 1024).toFixed(1)}KB, ${new Date(f.modifyTime).toISOString().slice(0, 19)})`);
          allFiles.push({ ...f, remotePath });
        }
      } catch { /* skip inaccessible dirs */ }
    }

    if (allFiles.length === 0) {
      console.log('\nNo 832 files found on remote server.');
      return null;
    }

    // Download newest
    allFiles.sort((a, b) => b.modifyTime - a.modifyTime);
    const target = allFiles[0];
    const localPath = `/tmp/ef_832_probe_${Date.now()}.edi`;
    console.log(`\nDownloading: ${target.remotePath}`);
    await sftp.fastGet(target.remotePath, localPath);
    console.log(`Saved to: ${localPath}`);
    return localPath;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => a === '--file') ? args[args.indexOf('--file') + 1] : null;
  const skipSftp = args.includes('--skip-sftp');

  let ediPath = fileArg;

  // Step 1: Get the real 832 file
  if (!ediPath && !skipSftp) {
    try {
      ediPath = await downloadLatest832();
    } catch (err) {
      console.error('SFTP failed:', err.message);
    }
  }

  // Step 2: Parse and show identifiers
  let sampleSkus = [];

  if (ediPath && fs.existsSync(ediPath)) {
    console.log('\n' + '='.repeat(70));
    console.log('PARSING EDI 832 — RAW IDENTIFIER ANALYSIS');
    console.log('='.repeat(70));

    const raw = fs.readFileSync(ediPath, 'utf-8');
    const items = parse832ForIdentifiers(raw);

    console.log(`\nTotal items in 832: ${items.length}\n`);

    // Show first 10 items with ALL their identifiers
    const showCount = Math.min(items.length, 10);
    for (let i = 0; i < showCount; i++) {
      const item = items[i];
      console.log(`--- Item ${i + 1} (LIN line ${item.line_number || '?'}) ---`);
      console.log(`  Raw LIN: ${item.rawLIN}`);
      console.log(`  Identifiers:`);
      for (const [key, val] of Object.entries(item.rawQualifiers)) {
        const label = LIN_QUALIFIERS[key] || key;
        console.log(`    ${key} (${label}): ${val}`);
      }
      if (Object.keys(item.g39Identifiers).length > 0) {
        console.log(`  G39 identifiers:`);
        for (const [key, val] of Object.entries(item.g39Identifiers)) {
          console.log(`    ${key}: ${val}`);
        }
      }
      if (item.g39Description) {
        console.log(`  G39 description: ${item.g39Description}`);
      }
      console.log(`  Descriptions:`);
      for (const d of item.descriptions) {
        console.log(`    ${d.label}: ${d.desc}`);
      }
      if (item.sublines && item.sublines.length > 0) {
        console.log(`  SLN sublines: ${item.sublines.length}`);
        for (const sl of item.sublines.slice(0, 3)) {
          console.log(`    ${sl.raw}`);
        }
      }
      console.log('');
    }

    // Collect unique identifier formats to probe
    console.log('\n' + '='.repeat(70));
    console.log('IDENTIFIER FORMAT SUMMARY');
    console.log('='.repeat(70));

    const qualifierCounts = {};
    for (const item of items) {
      for (const qual of Object.keys(item.rawQualifiers)) {
        qualifierCounts[qual] = (qualifierCounts[qual] || 0) + 1;
      }
    }
    console.log('\nLIN qualifier usage across all items:');
    for (const [qual, count] of Object.entries(qualifierCounts)) {
      console.log(`  ${qual} (${LIN_QUALIFIERS[qual] || qual}): ${count}/${items.length} items`);
    }

    // Build probe list from first 3 items — try every identifier
    for (const item of items.slice(0, 3)) {
      for (const [qual, val] of Object.entries(item.rawQualifiers)) {
        sampleSkus.push({ label: `LIN ${qual} (${LIN_QUALIFIERS[qual] || qual})`, sku: val });
      }
      for (const [key, val] of Object.entries(item.g39Identifiers)) {
        sampleSkus.push({ label: `G39 ${key}`, sku: val });
      }

      // Also try combinations
      const vn = item.rawQualifiers['VN'];
      const sk = item.rawQualifiers['SK'];
      const up = item.rawQualifiers['UP'];
      const mn = item.rawQualifiers['MN'];
      const colorDesc = item.descriptions.find(d => d.label === 'color');
      const styleDesc = item.descriptions.find(d => d.label === 'style');

      // If there's a style + color in PID, try combining them in various ways
      if (styleDesc && colorDesc) {
        sampleSkus.push({ label: 'style-color', sku: `${styleDesc.desc}-${colorDesc.desc}` });
      }
      if (vn && colorDesc) {
        sampleSkus.push({ label: 'VN-color', sku: `${vn}-${colorDesc.desc}` });
      }
    }
  }

  // Step 3: Probe the API with all candidate formats
  if (sampleSkus.length === 0) {
    // Fallback: try common EF style formats that user mentioned
    console.log('\nNo 832 data available. Using known style numbers to probe...');
    sampleSkus = [
      { label: 'bare style (4-digit)', sku: '4046' },
      { label: 'bare style (alpha)', sku: 'D020' },
      { label: 'bare style', sku: 'D2021' },
      { label: 'bare style', sku: 'EH002' },
      // Common EF SKU formats (guesses)
      { label: 'style-color guess', sku: '4046-2632' },
      { label: 'style-color guess', sku: '40462632' },
      { label: 'with EF prefix', sku: 'EF-4046' },
      { label: 'with EF prefix + color', sku: 'EF-4046-2632' },
      // DreamWeaver / Pentz patterns
      { label: 'brand prefix', sku: 'DW-4046' },
      { label: 'brand prefix', sku: 'PZ-4046' },
      { label: 'full descriptive', sku: 'DreamWeaver-4046' },
    ];
  }

  // Deduplicate
  const seen = new Set();
  sampleSkus = sampleSkus.filter(s => {
    if (seen.has(s.sku)) return false;
    seen.add(s.sku);
    return true;
  });

  console.log('\n' + '='.repeat(70));
  console.log(`PROBING fcB2B API — ${sampleSkus.length} candidate SKU formats`);
  console.log('='.repeat(70));
  console.log('');

  let hitCount = 0;
  for (const { label, sku } of sampleSkus) {
    const result = await probeAPI(label, sku);
    if (result.hasItems) hitCount++;
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n' + '='.repeat(70));
  console.log(`RESULTS: ${hitCount} hits out of ${sampleSkus.length} probes`);
  if (hitCount === 0) {
    console.log('\nNo SKU format returned inventory data.');
    console.log('Likely causes:');
    console.log('  1. Account not provisioned for web services (contact EF)');
    console.log('  2. The SupplierItemSKU format is something we haven\'t tried');
    console.log('  3. The items tested have zero inventory');
    console.log('\nNext step: Ask EF for a sample SupplierItemSKU that has stock.');
  }
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
