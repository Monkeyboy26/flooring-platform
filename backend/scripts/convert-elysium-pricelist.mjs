/**
 * Convert the Elysium Tiles price list PDF into the CSV consumed by
 * scrapers/elysium.js full mode (backend/data/elysium-pricelist.csv).
 *
 * Usage (inside the api container):
 *   node scripts/convert-elysium-pricelist.mjs <pdf-path> [out-csv-path]
 *
 * Collection per item comes from, in order:
 *   1. the existing DB product for that item code (internal_sku ELY-<code>)
 *   2. longest known-collection prefix of the item name (case-insensitive)
 *   3. first word of the item name
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pdfPath = process.argv[2];
const outPath = process.argv[3] || path.resolve(__dirname, '../data/elysium-pricelist.csv');
if (!pdfPath) {
  console.error('Usage: node scripts/convert-elysium-pricelist.mjs <pdf-path> [out-csv-path]');
  process.exit(1);
}

const { PDFParse } = await import('pdf-parse');
const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });
const data = await parser.getText();
await parser.destroy();

const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

// ── Collection lookups from DB ───────────────────────────────────────────
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const dbRows = await pool.query(`
  SELECT s.internal_sku, p.collection
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  WHERE v.code = 'ELY' AND p.collection IS NOT NULL AND p.collection != ''
`);
const codeToCollection = new Map();
const knownCollections = new Set();
for (const r of dbRows.rows) {
  const code = (r.internal_sku || '').replace(/^ELY-/, '');
  if (code) codeToCollection.set(code, r.collection);
  knownCollections.add(r.collection);
}
await pool.end();

// Longest-first for prefix matching
const collectionsByLength = [...knownCollections].sort((a, b) => b.length - a.length);

function resolveCollection(code, itemName) {
  const fromDb = codeToCollection.get(code);
  if (fromDb) return { collection: fromDb, source: 'db' };
  const lower = itemName.toLowerCase();
  for (const c of collectionsByLength) {
    const cl = c.toLowerCase();
    if (lower === cl || lower.startsWith(cl + ' ')) return { collection: c, source: 'prefix' };
  }
  return { collection: itemName.split(/\s+/)[0], source: 'first-word' };
}

// ── Parse product rows ───────────────────────────────────────────────────
// e.g. `13 M722 Aether Blue 11.50 x 12 $17.28 sh mosaic 11.5" x 12" 11pc / 10.54sf 0.96 $34.56`
const ROW_RE = /^\d+\s+([A-Z]{1,3}\d{2,6}[A-Z]?)\s+(.+?)\s+\$([\d.,]+)\s+(sf|sh|pc|set|ea)\s+(.+)$/i;

const rows = [];
const stats = { total: 0, db: 0, prefix: 0, 'first-word': 0, unparsed: 0 };
const clean = (s) => (s || '').replace(/,/g, ';').trim();

for (const line of lines) {
  const m = line.match(ROW_RE);
  if (!m) continue;
  const [, code, itemName, priceStr, per] = m;
  let tail = m[5].trim();

  // Parse the tail right-to-left: [type size] [packaging] [sf/pc] [$sale] $msrp [yes]
  let msrp = '', sale = '', sfpc = '', packaging = '', size = '', poolRated = '';

  let mm = tail.match(/\$([\d.,]+)\s*$/);
  if (mm) { msrp = mm[1].replace(/,/g, ''); tail = tail.slice(0, mm.index).trim(); }

  mm = tail.match(/\byes\s*$/i);
  if (mm) { poolRated = 'yes'; tail = tail.slice(0, mm.index).trim(); }

  mm = tail.match(/\$([\d.,]+)\s*$/);
  if (mm) { sale = mm[1].replace(/,/g, ''); tail = tail.slice(0, mm.index).trim(); }

  mm = tail.match(/\byes\s*$/i);
  if (mm) { poolRated = 'yes'; tail = tail.slice(0, mm.index).trim(); }

  mm = tail.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*$/);
  if (mm && /pc\s*\/\s*[\d.]*\s*sf/i.test(tail.slice(0, mm.index))) {
    sfpc = mm[1];
    tail = tail.slice(0, mm.index).trim();
  }

  mm = tail.match(/(\d+\s*pc\s*\/\s*(?:[\d.]+\s*sf)?)\s*$/i);
  if (mm) {
    packaging = mm[1].replace(/\s+/g, '').replace('pc/', 'pc / ');
    if (/\/\s*$/.test(packaging)) packaging = ''; // incomplete (slab rows) — drop
    tail = tail.slice(0, mm.index).trim();
  }

  mm = tail.match(/([\d.]+\s*["″]?\s*[xX×]\s*[\d.]+\s*["″]?)\s*$/);
  if (mm) { size = mm[1].trim(); tail = tail.slice(0, mm.index).trim(); }

  const type = tail; // whatever remains between per and size

  const { collection, source } = resolveCollection(code, itemName);
  stats[source]++;
  stats.total++;

  rows.push([
    clean(code), clean(itemName), clean(collection), priceStr.replace(/,/g, ''),
    per.toLowerCase(), clean(type.toLowerCase()), clean(size), clean(packaging),
    sfpc, sale, msrp, poolRated,
  ]);
}

if (!rows.length) {
  console.error('No product rows parsed — PDF layout may have changed.');
  process.exit(1);
}

const header = 'Item Code,Item Name,Collection,Price,Per,Type,Size,Packaging,SF/PC,Sale,MSRP,PoolRated';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + '\n' + rows.map(r => r.join(',')).join('\n') + '\n');

console.log(`Wrote ${rows.length} rows to ${outPath}`);
console.log(`Collections — from DB: ${stats.db}, prefix match: ${stats.prefix}, first-word fallback: ${stats['first-word']}`);
const typeCounts = {};
for (const r of rows) typeCounts[r[5]] = (typeCounts[r[5]] || 0) + 1;
console.log('Types:', JSON.stringify(typeCounts));
