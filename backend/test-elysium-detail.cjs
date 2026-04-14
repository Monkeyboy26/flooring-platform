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

  // Fetch 3 different product types
  const testUrls = [
    '/product?id=4EVER+Havana+Matte+8+x+48',    // Porcelain Tile
    '/product?id=Aether+Blue+11.50+x+12',         // Mosaic
    '/product?id=Vinyluxe+Canopy+Chestnut+7+x+60', // SPC Vinyl
  ];

  for (const url of testUrls) {
    console.log('\n' + '='.repeat(80));
    console.log('URL:', url);
    const detailResp = await fetch(`${BASE_URL}${url}`, {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
      signal: AbortSignal.timeout(30000)
    });
    const html = await detailResp.text();

    // Extract the product info section (around item code area)
    const productInfoStart = html.indexOf('product-title');
    if (productInfoStart > 0) {
      // Get ~2000 chars from product-title area
      const chunk = html.substring(productInfoStart - 100, productInfoStart + 2000)
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/\s+/g, ' ');
      console.log('\nProduct info area:');
      console.log(chunk.substring(0, 1500));
    }

    // Extract ALL text content between product-title and footer
    const titleMatch = html.match(/class="product-title">([\s\S]*?)<\/div>/);
    console.log('\nTitle:', titleMatch ? titleMatch[1].trim() : 'N/A');

    const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
    console.log('Item code:', codeMatch ? codeMatch[1] : 'N/A');

    // Check for any price info
    const pricePatterns = [
      /\$\s*([\d,.]+)/,
      /price[^>]*>\s*([\d,.]+)/i,
      /var\s+\w*[Pp]rice\w*\s*=\s*([\d.]+)/,
    ];
    for (const p of pricePatterns) {
      const m = html.match(p);
      if (m) console.log('Price match:', m[0].substring(0, 60));
    }

    // Check for collection anywhere in the page
    const collPatterns = [
      /collection[:\s]*<[^>]*>([^<]+)/i,
      />([^<]+)\s+Collection</i,
      /collection[:\s]+"?([^"<\n]+)/i,
    ];
    for (const p of collPatterns) {
      const m = html.match(p);
      if (m) console.log('Collection match:', m[0].substring(0, 80));
    }

    // Check for available finish / other sizes
    const finishMatch = html.match(/available finish:\s*([^<\n]+)/i);
    if (finishMatch) console.log('Finish:', finishMatch[1].trim());

    const otherSizes = [...html.matchAll(/href="\/product\?id=([^"]+)"/g)]
      .filter(m => m[1] !== url.split('id=')[1])
      .map(m => decodeURIComponent(m[1].replace(/\+/g, ' ')));
    if (otherSizes.length) console.log('Other sizes:', otherSizes.join(' | '));

    // Check for images
    const imgMatch = html.match(/id="img_0"\s+src="([^"]+)"/);
    console.log('Image:', imgMatch ? imgMatch[1] : 'N/A');

    // Check all images with /750/ path
    const allImgs = [...html.matchAll(/src="(\/static\/images\/product\/750\/[^"]+)"/g)];
    if (allImgs.length) console.log('All 750 images:', allImgs.map(m => m[1].split('/').pop()).join(' | '));

    // Check for Out of Stock / Discontinued / Coming Soon
    if (html.includes('Out of Stock')) console.log('STATUS: Out of Stock');
    if (html.includes('Discontinued')) console.log('STATUS: Discontinued');
    if (html.includes('Coming Soon')) console.log('STATUS: Coming Soon');

    // Check for description
    const descMatch = html.match(/id="description"[^>]*>([\s\S]*?)(?:<\/div>)/);
    if (descMatch) {
      const desc = descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      console.log('Description:', desc.substring(0, 150));
    }
  }

  pool.end();
})();
