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
      const t = part.trim();
      if (!t) continue;
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
  form.append('action', 'login');
  form.append('url', '');
  form.append('email', process.env.ELYSIUM_USERNAME);
  form.append('password', process.env.ELYSIUM_PASSWORD);

  const resp = await fetch(`${BASE_URL}/login.php`, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': initialCookies },
    body: form.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  const loginCookies = await extractCookies(resp);
  const cookies = mergeCookies(initialCookies, loginCookies);
  console.log('Login cookies:', cookies ? 'OK' : 'FAILED');

  // Fetch authenticated detail page
  const detailResp = await fetch(`${BASE_URL}/product?id=4EVER+Havana+Matte+8+x+48`, {
    headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
    signal: AbortSignal.timeout(30000)
  });
  const html = await detailResp.text();

  console.log('\n=== Authenticated Page Check ===');
  console.log('Has product-title:', html.includes('product-title'));
  console.log('Has id="specification":', html.includes('id="specification"'));
  console.log('Has id="packaging":', html.includes('id="packaging"'));
  console.log('Has id="img_0":', html.includes('id="img_0"'));
  console.log('Has totalPrice:', html.includes('totalPrice'));
  console.log('Has sqftPer:', html.includes('sqftPer'));
  console.log('Has soldBy:', html.includes('soldBy'));
  console.log('Has item code:', html.includes('item code'));
  console.log('Has other sizes:', html.includes('other sizes'));
  console.log('Has Logout:', html.includes('Logout') || html.includes('logout') || html.includes('Log Out'));

  // Extract title
  const titleMatch = html.match(/class="product-title">([\s\S]*?)<\/div>/);
  console.log('\nTitle:', titleMatch ? titleMatch[1].trim().substring(0, 100) : 'NOT FOUND');

  // Extract image
  const imgMatch = html.match(/id="img_0"\s+src="([^"]+)"/);
  console.log('Image:', imgMatch ? imgMatch[1].substring(0, 120) : 'NOT FOUND');

  // Also check for any img with /750/ path
  const img750 = html.match(/src="(\/static\/images\/product\/750\/[^"]+)"/);
  console.log('750 Image:', img750 ? img750[1].substring(0, 120) : 'NOT FOUND');

  // Item code
  const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
  console.log('Item code:', codeMatch ? codeMatch[1] : 'NOT FOUND');

  // Price
  const priceMatch = html.match(/var\s+totalPrice\s*=\s*([\d.]+)\s*\*/);
  console.log('Price per box:', priceMatch ? priceMatch[1] : 'NOT FOUND');

  const sqftMatch = html.match(/var\s+sqftPer\s*=\s*([\d.]+)/);
  console.log('SqftPer:', sqftMatch ? sqftMatch[1] : 'NOT FOUND');

  // Collection
  const collMatch = html.match(/>Collection<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  console.log('Collection:', collMatch ? collMatch[1].replace(/<[^>]+>/g,'').trim() : 'NOT FOUND');

  // Other sizes
  const otherMatch = html.match(/other sizes:([\s\S]*?)(?:<\/p>|<br|<div)/i);
  if (otherMatch) {
    const links = [...otherMatch[1].matchAll(/href="\/product\?id=([^"]+)"/g)];
    console.log('Other sizes:', links.map(m => decodeURIComponent(m[1].replace(/\+/g,' '))).join(' | '));
  } else {
    console.log('Other sizes: NOT FOUND');
  }

  // Packaging
  const sqftBox = html.match(/Square Feet Per Box[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
  console.log('SqFt/Box:', sqftBox ? sqftBox[1].replace(/<[^>]+>/g,'').trim() : 'NOT FOUND');

  const pcsBox = html.match(/Pieces Per Box[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
  console.log('Pcs/Box:', pcsBox ? pcsBox[1].replace(/<[^>]+>/g,'').trim() : 'NOT FOUND');

  // Print a chunk of HTML around the product title area for debugging
  const h1Idx = html.indexOf('<h1');
  if (h1Idx > 0) {
    console.log('\n=== HTML around <h1> ===');
    console.log(html.substring(Math.max(0, h1Idx - 200), h1Idx + 500).replace(/\s+/g, ' ').substring(0, 600));
  }

  pool.end();
})();
