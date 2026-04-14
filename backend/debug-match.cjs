const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({ host: 'db', port: 5432, user: 'postgres', password: 'postgres', database: 'flooring_pim' });

async function main() {
  const wb = XLSX.readFile('/tmp/az-porcelain.xlsx');
  const ws = wb.Sheets['Sheet1 (1)'];
  const plRows = XLSX.utils.sheet_to_json(ws);

  // Get DB product names
  const dbResult = await pool.query(`
    SELECT DISTINCT p.name, p.collection
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.name ILIKE '%arizona%' AND p.status = 'active'
    ORDER BY p.name LIMIT 30
  `);

  console.log('=== DB product names (first 30) ===');
  for (const r of dbResult.rows) console.log(`  "${r.name}" (coll: "${r.collection}")`);

  console.log('\n=== Pricelist names (first 30 unique) ===');
  const seen = new Set();
  for (const r of plRows) {
    const name = r['PRODUCT NAME'] || '';
    // Extract base name (before size and finish keywords)
    const base = name.replace(/\s+(Marble|Porcelain|Limestone|Travertine|Granite)\s+(Tile|Mosaic|Slab)\s+\d.*$/i, '');
    if (!seen.has(base)) {
      seen.add(base);
      console.log(`  "${name}" → base: "${base}"`);
      if (seen.size >= 30) break;
    }
  }

  // Try to find common products between the two
  console.log('\n=== Checking for DB products that loosely match pricelist ===');
  const dbNames = dbResult.rows.map(r => r.name.toLowerCase());
  const plNames = [...seen].map(n => n.toLowerCase());

  // Simple word overlap matching
  for (const dbName of dbNames.slice(0, 10)) {
    const words = dbName.split(/\s+/).filter(w => w.length > 3);
    for (const plName of plNames) {
      const matchCount = words.filter(w => plName.includes(w)).length;
      if (matchCount >= 2) {
        console.log(`  DB: "${dbName}" ↔ PL: "${plName}" (${matchCount} word matches)`);
      }
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
