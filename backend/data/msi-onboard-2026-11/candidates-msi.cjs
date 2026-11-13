// Build the scoped discontinuation candidate list:
// active MSI SKUs absent from the Jan-2026 pricelist, limited to categories
// the pricelist actually covers, excluding trim/molding suffix SKUs.
const fs = require('fs');
const items = new Set(JSON.parse(fs.readFileSync(__dirname + '/msi-pricelist-items.json', 'utf8')));

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const COVERED = new Set(['LVP (Plank)', 'Engineered Hardwood', 'Porcelain Tile', 'Ceramic Tile',
  'Mosaic Tile', 'Natural Stone', 'Stacked Stone', 'Wall Panels', '(none)']);
const TRIM_SUFFIX = /-(EC|ST|SR|T|TL|QR|OSN|FSN|RD|SN|LMR|BN)(-EE)?$|-EE$/;

const lines = fs.readFileSync(__dirname + '/prod-msi-active.csv', 'utf8').trim().split('\n');
const candidates = [];
for (const line of lines) {
  const [vendorSku, skuId, productId, pname, cat] = parseCsvLine(line);
  const key = vendorSku.trim().toUpperCase();
  if (items.has(key)) continue;
  if (!COVERED.has(cat)) continue;
  if ((cat === 'LVP (Plank)' || cat === 'Engineered Hardwood') && TRIM_SUFFIX.test(key)) continue;
  candidates.push({ vendorSku: key, skuId, productId, name: pname, cat });
}
console.log(`Candidates: ${candidates.length}`);
const byCat = {};
candidates.forEach(c => byCat[c.cat] = (byCat[c.cat] || 0) + 1);
console.log(JSON.stringify(byCat, null, 1));
console.log('\n(none)-category candidates:');
candidates.filter(c => c.cat === '(none)').forEach(c => console.log(`  ${c.vendorSku} | ${c.name}`));
fs.writeFileSync(__dirname + '/msi-drop-candidates.json', JSON.stringify(candidates, null, 1));
