// Quick test: fetch MSI product pages and check extraction
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function test() {
  const urls = [
    'https://www.msisurfaces.com/porcelain-sovana/sovana-maple-18x18-matte/',
    'https://www.msisurfaces.com/luxury-vinyl-planks/andover/dakworth/',
    'https://www.msisurfaces.com/stacked-stone/sierra-blue/',
  ];

  for (const url of urls) {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (resp.status !== 200) { console.log(url + ' -> HTTP ' + resp.status); continue; }
    const html = await resp.text();

    // Extract SKU codes
    const skus = [];
    const skuRegex = /ID#:\s*([A-Z0-9][-A-Z0-9]{4,})/gi;
    let m;
    while ((m = skuRegex.exec(html)) !== null) {
      const code = m[1].toUpperCase();
      if (!skus.includes(code)) skus.push(code);
    }

    // Extract images
    const imgs = [];
    const imgRegex = /https?:\/\/cdn\.msisurfaces\.com\/images\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
    while ((m = imgRegex.exec(html)) !== null) {
      if (!imgs.includes(m[0])) imgs.push(m[0]);
    }

    console.log('URL:', url);
    console.log('SKUs:', skus.length ? skus.join(', ') : 'NONE');
    console.log('Images:', imgs.length);
    if (imgs.length > 0) console.log('  First:', imgs[0]);
    console.log();
  }
}
test();
