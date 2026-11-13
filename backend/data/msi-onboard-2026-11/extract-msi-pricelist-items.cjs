// Extract ITEM NUMBER set from the MSI Jan-2026 xlsb pricelist (read-only).
const XLSX = require('/Users/kianassarpour/Desktop/flooring-platform/backend/node_modules/xlsx');
const fs = require('fs');

const FILE = '/Users/kianassarpour/Desktop/flooring-platform/backend/data/msi-pricelist-jan26.xlsb';
const wb = XLSX.readFile(FILE);
console.log('Sheets:', wb.SheetNames.join(', '));

const items = new Set();
const perSheet = {};
for (const sheetName of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
  let headerIdx = -1, itemCol = -1, statusCol = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    if (!row) continue;
    const idx = row.findIndex(c => String(c).toUpperCase().includes('ITEM NUMBER') || String(c).toUpperCase() === 'ITEM #' || String(c).toUpperCase() === 'SKU');
    if (idx >= 0) {
      headerIdx = i; itemCol = idx;
      statusCol = row.findIndex(c => String(c).trim().toUpperCase() === 'STATUS');
      break;
    }
  }
  if (headerIdx === -1) { perSheet[sheetName] = 'no header found, rows=' + rows.length; continue; }
  let count = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const item = String(row[itemCol] || '').trim().toUpperCase();
    if (!item || item.length < 3) continue;
    if (statusCol >= 0) {
      const st = String(row[statusCol] || '').trim().toLowerCase();
      if (st && st !== 'active' && st !== 'new') continue;
    }
    items.add(item);
    count++;
  }
  perSheet[sheetName] = count;
}
console.log('Per-sheet counts:', JSON.stringify(perSheet, null, 1));
console.log('Total unique item numbers:', items.size);
fs.writeFileSync(__dirname + '/msi-pricelist-items.json', JSON.stringify([...items]));
