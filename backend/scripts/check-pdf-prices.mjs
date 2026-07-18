/**
 * Quick diagnostic: check what PDF items don't get prices
 */
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the parsePdf function by requiring the module's code
// (Can't easily import from import-thd.js, so replicate key logic)

const { PDFParse } = await import("pdf-parse");
const buf = fs.readFileSync("/app/data/thd-q3-2026.pdf");
const parser = new PDFParse({ data: buf });
const data = await parser.getText();
await parser.destroy();
const rawLines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

const ITEM_CODE_RE = /^(THD\d{4}-\d{5}[A-Z]?)\s*/;
const STATUS_KEYWORDS = [
  'DISCONTINUED', 'PRE DROP', 'PREDROP', 'NEW/COMING SOON',
  'SPECIAL ORDER', 'PRICE UPDATE', 'UPDATED PACKING INFO',
  'UPDATED ITEM CODE',
];
const UOM_VALUES = ['SF', 'SHT', 'EA'];
const PAGE_MARKER_RE = /^-- \d+ of \d+ --$/;

let currentCollection = null;
const merged = [];

for (let i = 0; i < rawLines.length; i++) {
  const line = rawLines[i];
  if (PAGE_MARKER_RE.test(line)) continue;

  if (line.startsWith('Image\t') || line.startsWith('Image \t')) {
    const headerFields = line.split('\t').map(f => f.trim());
    if (headerFields.length >= 4 && headerFields[2] && headerFields[2] !== 'Size') {
      currentCollection = headerFields[2];
    }
    continue;
  }

  const m = line.match(ITEM_CODE_RE);
  if (!m) continue;

  const itemCode = m[1];
  const rest = line.substring(m[0].length);

  // Check if this line has UOM (complete record) or needs multi-line join
  const tabs = rest.split('\t');
  if (tabs.some(f => UOM_VALUES.includes(f.trim().toUpperCase()))) {
    merged.push({ itemCode, text: rest, collection: currentCollection });
  } else {
    let accumulated = rest;
    while (i + 1 < rawLines.length) {
      const nextLine = rawLines[i + 1];
      if (ITEM_CODE_RE.test(nextLine)) break;
      if (nextLine.startsWith('Image\t') || nextLine.startsWith('Image \t')) break;
      if (PAGE_MARKER_RE.test(nextLine)) { i++; continue; }
      i++;
      accumulated += ' ' + nextLine;
      if (accumulated.split('\t').some(f => UOM_VALUES.includes(f.trim().toUpperCase()))) break;
    }
    merged.push({ itemCode, text: accumulated, collection: currentCollection });
  }
}

// Analyze each merged record
let withPrice = 0;
let noPrice = 0;
let discontinued = 0;
let tooFewFields = 0;
const noPriceByCollection = {};
const noPriceExamples = [];

for (const { itemCode, text, collection } of merged) {
  const fields = text.split('\t').map(f => f.trim()).filter(Boolean);

  if (fields.length < 3) {
    tooFewFields++;
    continue;
  }

  // Check status
  const upper = text.toUpperCase();
  const isDiscontinued = STATUS_KEYWORDS.slice(0, 3).some(s => upper.includes(s));
  if (isDiscontinued) {
    discontinued++;
    continue;
  }

  // Check for price ($ optional, look for decimal number near end)
  const remaining = [...fields];
  // Pop status from end
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1].toUpperCase();
    if (STATUS_KEYWORDS.some(s => last.startsWith(s))) {
      remaining.pop();
    }
  }
  // Check for price
  let hasPrice = false;
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1].trim();
    if (/^\$?\d+(?:\.\d+)?$/.test(last)) {
      hasPrice = true;
    }
  }

  if (hasPrice) {
    withPrice++;
  } else {
    noPrice++;
    if (!noPriceByCollection[collection]) noPriceByCollection[collection] = [];
    noPriceByCollection[collection].push(itemCode);
    if (noPriceExamples.length < 5) {
      noPriceExamples.push({ itemCode, collection, fields: fields.join(' | ') });
    }
  }
}

console.log("=== PDF Price Analysis ===");
console.log("Total merged records:", merged.length);
console.log("Too few fields (skipped):", tooFewFields);
console.log("Discontinued:", discontinued);
console.log("Active with price:", withPrice);
console.log("Active without price:", noPrice);

console.log("\nCollections with missing prices:");
for (const [coll, items] of Object.entries(noPriceByCollection).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${coll}: ${items.length} items (${items.slice(0, 3).join(', ')}${items.length > 3 ? '...' : ''})`);
}

console.log("\nSample items without price (raw fields):");
for (const ex of noPriceExamples) {
  console.log(`  ${ex.itemCode} [${ex.collection}]`);
  console.log(`    Fields: ${ex.fields}`);
}
