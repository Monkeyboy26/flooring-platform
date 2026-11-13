// Diff prod active MSI SKUs vs Jan-2026 pricelist item numbers (analysis only).
const fs = require('fs');
const items = new Set(JSON.parse(fs.readFileSync(__dirname + '/msi-pricelist-items.json', 'utf8')));

// simple CSV parse (fields may contain quoted commas)
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

const lines = fs.readFileSync(__dirname + '/prod-msi-active.csv', 'utf8').trim().split('\n');
let inList = 0, notInList = 0, noVendorSku = 0;
const dropByCat = {}, keepByCat = {};
const dropProducts = new Map(), allProducts = new Map(); // productId -> {name, cat, total, dropped}
const dropSamples = [];

for (const line of lines) {
  const [vendorSku, skuId, productId, pname, cat] = parseCsvLine(line);
  let rec = allProducts.get(productId);
  if (!rec) { rec = { name: pname, cat, total: 0, dropped: 0 }; allProducts.set(productId, rec); }
  rec.total++;
  const key = (vendorSku || '').trim().toUpperCase();
  const hit = key && items.has(key);
  if (!key) noVendorSku++;
  if (hit) {
    inList++;
    keepByCat[cat] = (keepByCat[cat] || 0) + 1;
  } else {
    notInList++;
    rec.dropped++;
    dropByCat[cat] = (dropByCat[cat] || 0) + 1;
    if (dropSamples.length < 15) dropSamples.push(`${key || '(no vendor_sku)'} | ${pname} | ${cat}`);
  }
}

let productsFullyDropped = 0, productsPartial = 0, productsUntouched = 0;
for (const rec of allProducts.values()) {
  if (rec.dropped === 0) productsUntouched++;
  else if (rec.dropped === rec.total) productsFullyDropped++;
  else productsPartial++;
}

console.log(`Active MSI SKUs on prod:  ${lines.length}`);
console.log(`  in pricelist (keep):    ${inList}`);
console.log(`  NOT in pricelist (drop):${notInList}  (${(notInList/lines.length*100).toFixed(1)}%)`);
console.log(`  of which no vendor_sku: ${noVendorSku}`);
console.log(`\nProducts: ${allProducts.size} total | fully dropped: ${productsFullyDropped} | partially: ${productsPartial} | untouched: ${productsUntouched}`);

console.log('\nDropped SKUs by category:');
Object.entries(dropByCat).sort((a,b)=>b[1]-a[1]).forEach(([c,n]) => {
  const kept = keepByCat[c] || 0;
  console.log(`  ${c}: drop ${n} / keep ${kept}`);
});

console.log('\nSample dropped SKUs:');
dropSamples.forEach(s => console.log('  ' + s));

// pricelist items we don't even carry
let notCarried = 0;
const carried = new Set(lines.map(l => parseCsvLine(l)[0].trim().toUpperCase()));
for (const it of items) if (!carried.has(it)) notCarried++;
console.log(`\nPricelist items not in our active catalog: ${notCarried} of ${items.size}`);

// LVP/hardwood drop breakdown: trim-suffix SKUs vs base planks
const TRIM_SUFFIX = /-(EC|ST|SR|T|TL|QR|OSN|FSN|RD|SN|LMR|BN)(-EE)?$|-EE$/;
let lvpTrimDrop = 0, lvpPlankDrop = 0, hwTrimDrop = 0, hwPlankDrop = 0;
const plankDropSamples = [];
for (const line of lines) {
  const [vendorSku, , , pname, cat] = parseCsvLine(line);
  const key = vendorSku.trim().toUpperCase();
  if (items.has(key)) continue;
  if (cat === 'LVP (Plank)') {
    if (TRIM_SUFFIX.test(key)) lvpTrimDrop++; else { lvpPlankDrop++; if (plankDropSamples.length < 12) plankDropSamples.push(`${key} | ${pname}`); }
  } else if (cat === 'Engineered Hardwood') {
    if (TRIM_SUFFIX.test(key)) hwTrimDrop++; else hwPlankDrop++;
  }
}
console.log(`\nLVP drops: ${lvpTrimDrop} trim/molding SKUs, ${lvpPlankDrop} actual planks`);
console.log(`Hardwood drops: ${hwTrimDrop} trim/molding, ${hwPlankDrop} planks`);
console.log('Dropped LVP planks sample:');
plankDropSamples.forEach(s => console.log('  ' + s));
