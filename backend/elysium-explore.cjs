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
  console.log('Login:', cookies ? 'OK' : 'FAILED');

  // Test a variety of product types
  const testUrls = [
    '/product?id=4EVER+Havana+Matte+8+x+48',        // Porcelain Tile
    '/product?id=Aether+Blue+11.50+x+12',             // Mosaic
    '/product?id=Vinyluxe+Canopy+Chestnut+7+x+60',    // SPC Vinyl
    '/product?id=Calacatta+Gold+Polished',             // Marble Slab
    '/product?id=Classic+White+Quartz',                // Quartz (if exists)
  ];

  for (const url of testUrls) {
    console.log('\n' + '='.repeat(100));
    console.log('URL:', url);

    let html;
    try {
      const detailResp = await fetch(`${BASE_URL}${url}`, {
        headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
        signal: AbortSignal.timeout(30000)
      });
      html = await detailResp.text();
    } catch (e) {
      console.log('FETCH ERROR:', e.message);
      continue;
    }

    console.log('HTML length:', html.length);

    // ---- FULL STRUCTURE DUMP ----

    // 1. All section IDs and classes
    const sectionIds = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    console.log('\nAll IDs:', sectionIds.join(', '));

    // 2. All tab/section headers
    const tabs = [...html.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([^<]+)/g)];
    if (tabs.length) console.log('Tabs:', tabs.map(m => `${m[2].trim()} (#${m[1]})`).join(' | '));

    // 3. All <h1>-<h6> tags
    const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)];
    console.log('\nHeadings:');
    headings.forEach(m => {
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text) console.log(`  <h${m[1]}>: ${text.substring(0, 120)}`);
    });

    // 4. Product title area
    const titleMatch = html.match(/class="product-title">([\s\S]*?)<\/div>/);
    console.log('\nProduct title:', titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'N/A');

    // 5. Blue heading (category)
    const blueH5 = html.match(/<h5[^>]*class="blue"[^>]*>([\s\S]*?)<\/h5>/);
    console.log('Blue h5 (category):', blueH5 ? blueH5[1].replace(/<[^>]+>/g, '').trim() : 'N/A');

    // 6. Item code
    const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
    console.log('Item code:', codeMatch ? codeMatch[1] : 'N/A');

    // 7. Collection
    const collMatch = html.match(/>([^<]+?)\s+Collection</i);
    console.log('Collection:', collMatch ? collMatch[1].trim() : 'N/A');

    // 8. ALL table rows (specs/packaging)
    const tableRows = [...html.matchAll(/<tr[^>]*>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)];
    if (tableRows.length) {
      console.log('\nTable rows:');
      tableRows.forEach(m => {
        const label = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const value = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (label && value) console.log(`  ${label}: ${value}`);
      });
    }

    // 9. Specification section
    const specSection = html.match(/id="specification"([\s\S]*?)(?=id="|<\/section|$)/);
    if (specSection) {
      console.log('\nSpec section (raw, trimmed):');
      const specText = specSection[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(specText.substring(0, 500));
    }

    // 10. Packaging section
    const pkgSection = html.match(/id="packaging"([\s\S]*?)(?=id="|<\/section|$)/);
    if (pkgSection) {
      console.log('\nPackaging section (raw, trimmed):');
      const pkgText = pkgSection[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(pkgText.substring(0, 500));
    }

    // 11. All images
    const allImgs = [...html.matchAll(/src="([^"]*\/static\/images\/[^"]+)"/g)];
    console.log('\nAll images:');
    allImgs.forEach(m => console.log(`  ${m[1]}`));

    // 12. JavaScript variables (pricing, sqft, etc.)
    const jsVars = [...html.matchAll(/var\s+(\w+)\s*=\s*([^;]{1,100})/g)];
    if (jsVars.length) {
      console.log('\nJS variables:');
      jsVars.forEach(m => console.log(`  ${m[1]} = ${m[2].trim()}`));
    }

    // 13. Check for form/cart info
    const cartForm = html.match(/<form[^>]*action="\/cart\.php"([\s\S]*?)<\/form>/);
    if (cartForm) {
      const inputs = [...cartForm[1].matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)];
      console.log('\nCart form inputs:');
      inputs.forEach(m => console.log(`  ${m[1]} = ${m[2]}`));
    }

    // 14. Available finish
    const finishMatch = html.match(/available finish[es]*:\s*([\s\S]*?)(?:<br|<\/p|<\/div)/i);
    if (finishMatch) console.log('Available finish:', finishMatch[1].replace(/<[^>]+>/g, '').trim());

    // 15. Other sizes
    const otherSizes = [...html.matchAll(/href="\/product\?id=([^"]+)"/g)]
      .map(m => decodeURIComponent(m[1].replace(/\+/g, ' ')))
      .filter(name => name !== decodeURIComponent(url.split('id=')[1].replace(/\+/g, ' ')));
    if (otherSizes.length) console.log('Other sizes:', otherSizes.join(' | '));

    // 16. Description
    const descMatch = html.match(/id="description"[^>]*>([\s\S]*?)<\/div>/);
    if (descMatch) {
      const desc = descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      console.log('Description:', desc.substring(0, 200));
    }

    // 17. Dump the full product area between product-title and footer for inspection
    const prodStart = html.indexOf('product-title');
    const prodEnd = html.indexOf('<footer') > 0 ? html.indexOf('<footer') : html.indexOf('</body');
    if (prodStart > 0 && prodEnd > prodStart) {
      const productHTML = html.substring(prodStart - 200, Math.min(prodEnd, prodStart + 8000))
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/\s+/g, ' ');
      console.log('\n--- PRODUCT AREA HTML (first 4000 chars) ---');
      console.log(productHTML.substring(0, 4000));
    }
  }

  pool.end();
})();
