const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

  // Check if generic 'daltile' products can match named collections
  const generic = await pool.query(`
    SELECT DISTINCT p.name, p.id
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL' AND p.collection = 'daltile' AND ma.id IS NULL
    ORDER BY p.name
  `);

  // Get all named collections with images
  const namedCols = await pool.query(`
    SELECT DISTINCT p.collection
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL' AND p.collection <> 'daltile'
  `);
  const colNames = new Set(namedCols.rows.map(r => r.collection.toLowerCase()));

  // Try to extract series name from generic product names
  const matches = {};
  const misses = {};

  for (const p of generic.rows) {
    // Product names like "Acreage Plank Mt", "Advantage Bn P43c9 Ls Mt"
    // Try progressively shorter prefixes
    const words = p.name.split(/\s+/);
    let matched = false;

    for (let len = Math.min(3, words.length); len >= 1; len--) {
      const guess = words.slice(0, len).join(' ');
      if (colNames.has(guess.toLowerCase())) {
        if (!matches[guess]) matches[guess] = 0;
        matches[guess]++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const key = words.slice(0, 2).join(' ');
      if (!misses[key]) misses[key] = 0;
      misses[key]++;
    }
  }

  console.log('=== Generic daltile products that MATCH named collections ===');
  const sortedMatches = Object.entries(matches).sort((a, b) => b[1] - a[1]);
  let totalMatched = 0;
  for (const [name, count] of sortedMatches) {
    console.log(`  ${name}: ${count} products`);
    totalMatched += count;
  }
  console.log(`Total matchable: ${totalMatched} / ${generic.rows.length}`);

  console.log('\n=== Generic daltile products that DO NOT match ===');
  const sortedMisses = Object.entries(misses).sort((a, b) => b[1] - a[1]);
  let totalMissed = 0;
  for (const [name, count] of sortedMisses) {
    console.log(`  ${name}: ${count} products`);
    totalMissed += count;
  }
  console.log(`Total unmatched: ${totalMissed}`);

  await pool.end();
}
main().catch(e => console.error(e));
