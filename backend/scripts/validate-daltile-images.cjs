const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

const CONCURRENCY = 20;

async function checkUrl(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  // Get all unique Daltile primary image URLs
  const res = await pool.query(`
    SELECT DISTINCT m.url, COUNT(*) as usage_count
    FROM media_assets m
    JOIN products p ON p.id = m.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND m.asset_type = 'primary'
    GROUP BY m.url
    ORDER BY usage_count DESC
  `);
  
  console.log(`Unique primary image URLs: ${res.rows.length} (used by ${res.rows.reduce((s,r) => s + parseInt(r.usage_count), 0)} assets)`);
  
  let ok = 0, fail = 0;
  const failedUrls = [];
  
  for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
    const batch = res.rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async row => {
      const works = await checkUrl(row.url);
      return { url: row.url, count: parseInt(row.usage_count), works };
    }));
    
    for (const r of results) {
      if (r.works) ok += r.count;
      else { fail += r.count; failedUrls.push(r); }
    }
    
    if ((i + CONCURRENCY) % 200 === 0) process.stdout.write(`  Checked ${i + CONCURRENCY}/${res.rows.length} unique URLs\r`);
  }
  
  console.log(`\nWorking: ${ok} assets, Broken: ${fail} assets (${failedUrls.length} unique URLs)`);
  
  // Categorize failures
  const s7 = failedUrls.filter(f => f.url.includes('scene7.com'));
  const dam = failedUrls.filter(f => f.url.includes('digitalassets'));
  const other = failedUrls.filter(f => !f.url.includes('scene7') && !f.url.includes('digitalassets'));
  
  console.log(`\nBroken by type:`);
  console.log(`  Scene7: ${s7.reduce((s,r) => s + r.count, 0)} assets (${s7.length} URLs)`);
  console.log(`  DAM: ${dam.reduce((s,r) => s + r.count, 0)} assets (${dam.length} URLs)`);
  console.log(`  Other: ${other.reduce((s,r) => s + r.count, 0)} assets (${other.length} URLs)`);
  
  if (s7.length > 0) {
    console.log(`\nBroken Scene7 examples:`);
    s7.slice(0, 10).forEach(f => console.log(`  (${f.count}x) ${f.url.split('/').pop()}`));
  }
  if (dam.length > 0) {
    console.log(`\nBroken DAM examples:`);
    dam.slice(0, 10).forEach(f => console.log(`  (${f.count}x) ...${f.url.split('/').slice(-3).join('/')}`));
  }
  
  // Delete broken images so SKUs fall back through COALESCE chain
  if (failedUrls.length > 0) {
    const brokenUrlSet = failedUrls.map(f => f.url);
    console.log(`\nDeleting ${fail} broken media_assets...`);
    
    const delRes = await pool.query(`
      DELETE FROM media_assets 
      WHERE url = ANY($1) AND asset_type = 'primary'
        AND product_id IN (SELECT id FROM products WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'DAL'))
      RETURNING id
    `, [brokenUrlSet]);
    
    console.log(`Deleted: ${delRes.rowCount}`);
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
