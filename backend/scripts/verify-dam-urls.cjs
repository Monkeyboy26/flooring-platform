const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

async function main() {
  // Get all URLs we just updated to 570 rendition
  const res = await pool.query(`
    SELECT id, url FROM media_assets 
    WHERE url LIKE '%digitalassets.daltile.com%/renditions/cq5dam.web.570.570.jpeg'
  `);
  
  console.log(`Checking ${res.rows.length} URLs with 570 rendition...`);
  let ok = 0, fail = 0;
  const failedIds = [];
  
  for (let i = 0; i < res.rows.length; i += 10) {
    const batch = res.rows.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const r = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        return { id: row.id, ok: r.ok, url: row.url };
      } catch { return { id: row.id, ok: false, url: row.url }; }
    }));
    
    for (const r of results) {
      if (r.ok) { ok++; } 
      else { fail++; failedIds.push(r.id); }
    }
    if ((i + 10) % 100 === 0) process.stdout.write(`  ${i+10}/${res.rows.length}\r`);
  }
  
  console.log(`\n570 rendition: ${ok} OK, ${fail} failed`);
  
  if (failedIds.length > 0) {
    // For failed ones, try falling back to original (which is JPEG for .jpg files)
    console.log(`Reverting ${failedIds.length} failed URLs to original_url...`);
    for (const id of failedIds) {
      await pool.query(`UPDATE media_assets SET url = original_url WHERE id = $1 AND original_url IS NOT NULL`, [id]);
    }
    console.log('Reverted to original_url (which serves JPEG from .jpg source)');
  }
  
  // Also check the 1280 renditions for .tif files
  const tifRes = await pool.query(`
    SELECT id, url FROM media_assets 
    WHERE url LIKE '%digitalassets.daltile.com%/renditions/cq5dam.web.1280.1280.jpeg'
  `);
  
  console.log(`\nChecking ${tifRes.rows.length} URLs with 1280 rendition...`);
  let tokay = 0, tfail = 0;
  const tfailedIds = [];
  
  for (let i = 0; i < tifRes.rows.length; i += 10) {
    const batch = tifRes.rows.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const r = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        return { id: row.id, ok: r.ok, url: row.url };
      } catch { return { id: row.id, ok: false, url: row.url }; }
    }));
    
    for (const r of results) {
      if (r.ok) { tokay++; } 
      else { tfail++; tfailedIds.push({ id: r.id, url: r.url }); }
    }
    if ((i + 10) % 100 === 0) process.stdout.write(`  ${i+10}/${tifRes.rows.length}\r`);
  }
  
  console.log(`\n1280 rendition: ${tokay} OK, ${tfail} failed`);
  if (tfailedIds.length > 0) {
    console.log('Failed 1280 examples:');
    tfailedIds.slice(0, 5).forEach(f => console.log(`  ${f.url.split('/').slice(-4).join('/')}`));
    
    // Try 570 as fallback for failed 1280s
    let fixed570 = 0;
    for (const f of tfailedIds) {
      const url570 = f.url.replace('cq5dam.web.1280.1280.jpeg', 'cq5dam.web.570.570.jpeg');
      try {
        const r = await fetch(url570, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          await pool.query('UPDATE media_assets SET url = $1 WHERE id = $2', [url570, f.id]);
          fixed570++;
        }
      } catch {}
    }
    console.log(`Fixed ${fixed570} with 570 fallback`);
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
