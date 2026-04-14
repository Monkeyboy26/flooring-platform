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

  // Fetch various product types with their REAL URLs from listing pages
  const testProducts = [
    { name: 'SPC Vinyl', url: '/product?id=SPC+Diamond+Classic+Oak+Grey+9+x+60' },
    { name: 'Quartz', url: '/product?id=Alech+Glacier+Quartz+3cm+126+X63+(Silica+Free)' },
    { name: 'Quartzite', url: '/product?id=Allure+3cm+Polished+Quartzite' },
    { name: 'Granite', url: '/product?id=Amazon+Leather+Premium' },
    { name: 'Marble Slab', url: '/product?id=Matarazzo+3cm+Polished' },
    { name: 'Thin Slab', url: '/product?id=Zero.3+Must+White+Slab+Lux+39+x+118' },
    { name: 'Porcelain (multi-img)', url: '/product?id=Memento+Aspen+Matte+8+x+48' },
  ];

  for (const test of testProducts) {
    console.log('\n' + '='.repeat(100));
    console.log(`${test.name}: ${test.url}`);

    const detailResp = await fetch(`${BASE_URL}${test.url}`, {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies },
      signal: AbortSignal.timeout(30000)
    });
    const html = await detailResp.text();

    if (!html.includes('product-title')) {
      console.log('  EMPTY PAGE');
      continue;
    }

    // Category from h5.blue
    const blueH5 = html.match(/<h5[^>]*class="blue"[^>]*>([\s\S]*?)<\/h5>/);
    console.log('  h5.blue category:', blueH5 ? blueH5[1].replace(/<[^>]+>/g, '').trim() : 'N/A');

    // Title
    const titleMatch = html.match(/class="product-title">\s*([\s\S]*?)\s*<\/div>/);
    console.log('  Title:', titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'N/A');

    // Item code
    const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
    console.log('  Item code:', codeMatch ? codeMatch[1] : 'N/A');

    // Collection
    const collMatch = html.match(/<h4>([^<]+?)\s+Collection<\/h4>/i);
    console.log('  Collection heading:', collMatch ? collMatch[1].trim() : 'N/A');

    // Available finish + trims
    const finishMatch = html.match(/available finish(?:es)?:\s*([^<\n]+)/i);
    console.log('  Finish:', finishMatch ? finishMatch[1].trim() : 'N/A');
    const trimsMatch = html.match(/available trims:\s*([^<\n]+)/i);
    console.log('  Trims:', trimsMatch ? trimsMatch[1].trim() : 'N/A');

    // Collection catalog PDF
    const pdfMatch = html.match(/href="([^"]*products-pdf[^"]*\.pdf)"/i);
    console.log('  Catalog PDF:', pdfMatch ? pdfMatch[1] : 'N/A');

    // Product ID from form
    const prodIdMatch = html.match(/name="product_id"\s+value="(\d+)"/);
    console.log('  Product ID:', prodIdMatch ? prodIdMatch[1] : 'N/A');

    // Description
    const descMatch = html.match(/id="description"[^>]*>([\s\S]*?)<\/div>\s*(?:<div id="detailDescription|<div style)/);
    if (descMatch) {
      const desc = descMatch[1].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      console.log('  Description:', desc.substring(0, 250));
    }

    // All gallery images (id="img_N")
    const galleryImgs = [...html.matchAll(/id="img_(\d+)"\s+src="([^"]+)"/g)];
    console.log(`  Gallery images (id="img_N"): ${galleryImgs.length}`);
    galleryImgs.forEach(m => console.log(`    img_${m[1]}: ${m[2]}`));

    // All /750/ images
    const imgs750 = [...html.matchAll(/src="(\/static\/images\/product\/750\/[^"]+)"/g)];
    console.log(`  /750/ images: ${imgs750.length}`);

    // All /1000/ images
    const imgs1000 = [...html.matchAll(/src="(\/static\/images\/product\/1000\/[^"]+)"/g)];
    console.log(`  /1000/ images: ${imgs1000.length}`);
    imgs1000.forEach(m => console.log(`    ${m[1]}`));

    // Other sizes links
    const otherSizes = html.match(/other sizes:([\s\S]*?)(?:<br|<\/div)/i);
    if (otherSizes) {
      const links = [...otherSizes[1].matchAll(/href="\/product\?id=([^"]+)"/g)];
      console.log(`  Other sizes: ${links.map(m => decodeURIComponent(m[1].replace(/\+/g, ' '))).join(' | ')}`);
    }

    // Collection listing at bottom (other products in same collection)
    const collectionCards = [...html.matchAll(/class="collection-listing-wrapper"[\s\S]*?<a\s+href="\/product\?id=([^"]+)"/g)];
    if (collectionCards.length === 0) {
      // Try a broader match
      const allProdLinks = [...html.matchAll(/<a\s+href="\/product\?id=([^"]+)"[^>]*><div class="card listing">/g)];
      if (allProdLinks.length > 0) {
        console.log(`  Collection products: ${allProdLinks.length}`);
        allProdLinks.slice(0, 3).forEach(m => console.log(`    ${decodeURIComponent(m[1].replace(/\+/g, ' '))}`));
      }
    }

    // Check the full info area content between product-title and cart form
    const infoStart = html.indexOf('product-title');
    const infoEnd = html.indexOf('<form action="/cart.php"');
    if (infoStart > 0 && infoEnd > infoStart) {
      const infoArea = html.substring(infoStart, infoEnd)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      console.log('  Info area text:', infoArea.substring(0, 400));
    }

    await new Promise(r => setTimeout(r, 1000));
  }
})();
