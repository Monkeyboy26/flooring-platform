const XLSX = require('xlsx');
const wb = XLSX.readFile('/tmp/az-porcelain.xlsx');
const ws = wb.Sheets['Sheet1 (1)'];
const data = XLSX.utils.sheet_to_json(ws);

// Show all fields for a row with full box data
const withBox = data.filter(r => r['SqftPER Box'] > 0 && r['Pieces Per Box'] > 0);
console.log(`${withBox.length} rows with box data\n`);

const sample = withBox[5];
const keys = Object.keys(sample).filter(k => sample[k] !== null && sample[k] !== undefined);
console.log('Sample row with box data:');
for (const k of keys) console.log(`  ${k}: ${sample[k]}`);

// Check what Bianco Carrara / Carrara White has
console.log('\n--- Carrara White rows with packaging ---');
const carrara = data.filter(r => {
  const name = (r['PRODUCT NAME'] || '').toLowerCase();
  return (name.includes('carrara white') || name.includes('bianco carrara'))
    && (r['Pieces Per Box'] > 0 || r['SqftPER Box'] > 0 || r['SqftPER Piece'] > 0);
});
for (const r of carrara) {
  console.log(`  ${r['PRODUCT CODE']}: ${r['PRODUCT NAME']} | pcs/box=${r['Pieces Per Box']||'-'} sqft/box=${r['SqftPER Box']||'-'} sqft/pc=${r['SqftPER Piece']||'-'} soldBy=${r['Sold By']||'-'}`);
}
