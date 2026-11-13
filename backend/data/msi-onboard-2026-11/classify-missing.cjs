// Classify pricelist items missing from the active catalog:
//  - reactivate: SKU exists in DB but inactive (or product inactive)
//  - create: genuinely absent
const fs = require('fs');
const full = require('./msi-pricelist-full.json');

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

const db = new Map(); // vendor_sku -> {skuStatus, skuId, productId, productActive, productName}
for (const line of fs.readFileSync('./prod-msi-all.csv', 'utf8').trim().split('\n')) {
  const [vsku, status, skuId, productId, pActive, pName] = parseCsvLine(line);
  db.set(vsku.trim().toUpperCase(), { status, skuId, productId, pActive: pActive === 't', pName });
}

const reactivate = [], create = [];
for (const r of full) {
  const st = String(r.Status || '').trim().toLowerCase();
  if (st && st !== 'active' && st !== 'new') continue;
  const hit = db.get(r.__item);
  if (hit) {
    if (hit.status !== 'active' || !hit.pActive) reactivate.push({ ...r, __db: hit });
    continue; // active ones already carried
  }
  create.push(r);
}

console.log(`Reactivate (exists but inactive): ${reactivate.length}`);
reactivate.slice(0, 15).forEach(r => console.log(`  ${r.__item} | sku:${r.__db.status} product-active:${r.__db.pActive} | ${r.__db.pName}`));
console.log(`\nCreate (absent): ${create.length}`);

// Distribution by item prefix and by web-link first segment
const byPrefix = {}, bySeg = {};
for (const r of create) {
  const pre = (r.__item.match(/^([A-Z]+)-?/) || [,'?'])[1];
  byPrefix[pre] = (byPrefix[pre] || 0) + 1;
  const link = String(r['Web Link'] || '');
  const seg = (link.match(/msisurfaces\.com\/([^/]+)\//) || [,'(no-link)'])[1];
  bySeg[seg] = (bySeg[seg] || 0) + 1;
}
console.log('\nBy item prefix:', JSON.stringify(Object.entries(byPrefix).sort((a,b)=>b[1]-a[1])));
console.log('\nBy web-link segment:');
Object.entries(bySeg).sort((a,b)=>b[1]-a[1]).forEach(([s,n]) => console.log(`  ${s}: ${n}`));

fs.writeFileSync('./msi-reactivate.json', JSON.stringify(reactivate, null, 1));
fs.writeFileSync('./msi-create.json', JSON.stringify(create, null, 1));
