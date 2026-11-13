// Extract FULL rows from the Jan-26 xlsb for item numbers, with all columns.
const XLSX = require('/Users/kianassarpour/Desktop/flooring-platform/backend/node_modules/xlsx');
const fs = require('fs');

const FILE = '/Users/kianassarpour/Desktop/flooring-platform/backend/data/msi-pricelist-jan26.xlsb';
const wb = XLSX.readFile(FILE);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['PriceList'], { header: 1 });

let headerIdx = -1;
for (let i = 0; i < 30; i++) {
  if (rows[i] && rows[i].some(c => String(c).toUpperCase().includes('ITEM NUMBER'))) { headerIdx = i; break; }
}
const headers = rows[headerIdx].map(h => String(h || '').trim());
console.log('Headers:', JSON.stringify(headers));

const out = [];
for (let i = headerIdx + 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row) continue;
  const rec = {};
  headers.forEach((h, j) => { if (h) rec[h] = row[j] !== undefined ? row[j] : null; });
  const item = String(rec[headers.find(h => h.toUpperCase().includes('ITEM NUMBER'))] || '').trim();
  if (!item || item.length < 3) continue;
  rec.__item = item.toUpperCase();
  out.push(rec);
}
console.log('Total data rows:', out.length);
console.log('\nSample rows:');
out.slice(0, 3).forEach(r => console.log(JSON.stringify(r)));
fs.writeFileSync(__dirname + '/msi-pricelist-full.json', JSON.stringify(out));
