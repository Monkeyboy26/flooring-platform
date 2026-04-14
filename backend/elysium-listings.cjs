const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_URL = 'http://elysiumtile.com';

async function extractCookies(resp) {
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  if (setCookies.length > 0) return setCookies.map(c => c.split(';')[0].trim()).join('; ');
  const raw = resp.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(',').map(c => c.split(';')[0].trim()).join('; ');
}
function mergeCookies(a, b) {
  const map = new Map();
  for (const str of [a, b]) {
    if (!str) continue;
    for (const part of str.split(';')) {
      const t = part.trim(); if (!t) continue;
      const eq = t.indexOf('=');
      if (eq > 0) map.set(t.slice(0, eq).trim(), t);
    }
  }
  return Array.from(map.values()).join('; ');
}

(async () => {
  // Login
  const loginResp = await fetch(`${BASE_URL}/login.php`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  await loginResp.text();
  const initialCookies = await extractCookies(loginResp);
  const form = new URLSearchParams();
  form.append('action', 'login'); form.append('url', '');
  form.append('email', process.env.ELYSIUM_USERNAME);
  form.append('password', process.env.ELYSIUM_PASSWORD);
  const resp = await fetch(`${BASE_URL}/login.php`, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': initialCookies },
    body: form.toString(), redirect: 'manual', signal: AbortSignal.timeout(15000)
  });
  const loginCookies = await extractCookies(resp);
  const cookies = mergeCookies(initialCookies, loginCookies);

  // 1. Pick a few products from each category in our DB and fetch detail pages to check the <h5 class="blue"> category
  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code = 'ELY'")).rows[0]?.id;

  // Show category distribution and sample mismatches
  const catDist = await pool.query(`
    SELECT c.name as pim_category, COUNT(*)::int as cnt
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1
    GROUP BY c.name ORDER BY cnt DESC
  `, [vendorId]);
  console.log('Current PIM categories:');
  catDist.rows.forEach(r => console.log(`  ${r.pim_category || 'NULL'}: ${r.cnt}`));

  // Sample a few products from each less common category
  const sampleCats = ['LVP (Plank)', 'Granite Countertops', 'Natural Stone', 'Marble Countertops', 'Quartzite Countertops', 'Quartz Countertops'];

  for (const catName of sampleCats) {
    const samples = await pool.query(`
      SELECT p.name, s.internal_sku
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND c.name = $2
      LIMIT 5
    `, [vendorId, catName]);

    if (samples.rows.length === 0) continue;
    console.log(`\n=== ${catName} (sample products) ===`);

    for (const row of samples.rows) {
      // Fetch the detail page to see what category Elysium says
      const encodedName = encodeURIComponent(row.name.replace(/ /g, '+'));
      // Get first SKU name for URL
      const skuData = await pool.query(`
        SELECT s.vendor_sku FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND p.name = $2 LIMIT 1
      `, [vendorId, row.name]);

      // Use the first entry URL we can find
      const firstSku = skuData.rows[0]?.vendor_sku || row.name;
      const url = `/product?id=${encodeURIComponent(firstSku).replace(/%20/g, '+')}`;

      try {
        const detailResp = await fetch(`${BASE_URL}${url}`, {
          headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
          signal: AbortSignal.timeout(15000)
        });
        const html = await detailResp.text();

        const blueH5 = html.match(/<h5[^>]*class="blue"[^>]*>([\s\S]*?)<\/h5>/);
        const actualCategory = blueH5 ? blueH5[1].replace(/<[^>]+>/g, '').trim() : 'EMPTY PAGE';
        const hasProductTitle = html.includes('product-title');

        console.log(`  ${row.name} -> Site says: "${actualCategory}" | Has content: ${hasProductTitle}`);
      } catch (e) {
        console.log(`  ${row.name} -> FETCH ERROR: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 2. Also check a few from each listing page to see real product names
  console.log('\n\n=== Checking listing page product samples ===');
  const listCategories = [
    { name: 'SPC Vinyl', type: 'SPC+Vinyl' },
    { name: 'Marble Slab', type: 'Marble+Slab' },
    { name: 'Thin Porcelain Slab', type: 'Thin+Porcelain+Slab+6mm' },
    { name: 'Quartz', type: 'Quartz' },
    { name: 'Quartzite', type: 'Quartzite' },
    { name: 'Granite', type: 'Granite' },
  ];

  for (const cat of listCategories) {
    const listUrl = `/category?type=${cat.type}&order_by=name&page=1`;
    try {
      const listResp = await fetch(`${BASE_URL}${listUrl}`, {
        headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
        signal: AbortSignal.timeout(15000)
      });
      const html = await listResp.text();

      // Extract first 5 product names
      const cards = [...html.matchAll(/<a\s+href="\/product\?id=([^"]+)"[^>]*>/g)];
      const names = cards.slice(0, 5).map(m => decodeURIComponent(m[1].replace(/\+/g, ' ')));
      console.log(`\n${cat.name} (${cards.length} cards on page 1):`);
      names.forEach(n => console.log(`  ${n}`));

      // Fetch first product detail to check its <h5 class="blue">
      if (names.length > 0) {
        const firstUrl = `/product?id=${cards[0][1]}`;
        const detResp = await fetch(`${BASE_URL}${firstUrl}`, {
          headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
          signal: AbortSignal.timeout(15000)
        });
        const detHtml = await detResp.text();
        const blueH5 = detHtml.match(/<h5[^>]*class="blue"[^>]*>([\s\S]*?)<\/h5>/);
        const hasContent = detHtml.includes('product-title');
        console.log(`  -> Detail page h5.blue: "${blueH5 ? blueH5[1].replace(/<[^>]+>/g,'').trim() : 'N/A'}" | Has content: ${hasContent}`);

        // Check images count
        const imgs750 = [...detHtml.matchAll(/src="(\/static\/images\/product\/750\/[^"]+)"/g)];
        const imgs1000 = [...detHtml.matchAll(/src="(\/static\/images\/product\/1000\/[^"]+)"/g)];
        console.log(`  -> Images: ${imgs750.length} at /750/, ${imgs1000.length} at /1000/`);
      }
    } catch (e) {
      console.log(`${cat.name}: ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  pool.end();
})();
