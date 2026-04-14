/**
 * Second pass: probe slug candidates for remaining unmapped Bellezza products.
 * Usage: docker compose exec api node scripts/bellezza-fix-slugs2.js
 */
import puppeteer from 'puppeteer';

// Generate candidate slugs from a product name
function generateSlugs(name) {
  const base = name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const slugs = new Set();
  slugs.add(base);

  // Try with common suffixes/prefixes
  for (const suffix of ['', '-matte', '-polished', '-porcelain', '-tile', '-mosaic', '-24x48', '-12x24']) {
    slugs.add(base + suffix);
  }

  // Try without trailing words
  const parts = base.split('-');
  if (parts.length > 1) {
    slugs.add(parts.slice(0, -1).join('-'));
    slugs.add(parts[0]); // just first word
  }

  return [...slugs];
}

const PRODUCTS = [
  'Angelo Silk Shimmer',
  'Anima Antracita',
  'Antwerp',
  'Arena Chiaro',
  'Arhus',
  'Armani White',
  'Austral Blanco',
  'Black Marble Mosaic',
  'Calacatta Brick Gloss',
  'Camden',
  'Ceppo',
  'Chamonix',
  'Chateau Mosaic',
  'District',
  'Enigma White',
  'Fry',
  'Granby Beige',
  'Grande',
  'Hudson',
  'Ibiza',
  'LN520 Stacked Linear',
  'Larin Marfil',
  'Lingot',
  'Magna White',
  'Manhattan',
  'Milano Mosaic',
  'Nord',
  'Park',
  'Penny Calacatta Gold',
  'Penny Fosco',
  'Penny Grafito',
  'Scanda White',
  'Schluter Trim',
  'Sekos White',
  'Sun Blanco',
  'Temper',
];

// Extra hand-crafted candidates for tricky names
const EXTRA_SLUGS = {
  'Angelo Silk Shimmer': ['angelo-silk-shimmer', 'angelo-silk', 'silk-shimmer'],
  'Arena Chiaro': ['arena-chiaro', 'arena-chiaro-matte', 'arena'],
  'Black Marble Mosaic': ['black-marble-mosaic', 'black-marble', 'marble-mosaic'],
  'Calacatta Brick Gloss': ['calacatta-brick-gloss', 'calacatta-brick', 'brick-gloss'],
  'Chateau Mosaic': ['chateau-mosaic', 'chateau'],
  'Granby Beige': ['granby-beige', 'granby'],
  'LN520 Stacked Linear': ['ln520-stacked-linear', 'ln520', 'stacked-linear'],
  'Larin Marfil': ['larin-marfil', 'larin'],
  'Lingot': ['lingot', 'lingot-aqua', 'lingot-blue', 'lingot-white'],
  'Manhattan': ['manhattan', 'manhattan-mud', 'manhattan-pearl'],
  'Milano Mosaic': ['milano-mosaic', 'milano-gold-mosaic', 'milano-silver-mosaic', 'milano-gold', 'milano-silver'],
  'Penny Calacatta Gold': ['penny-calacatta-gold', 'penny-calacatta', 'penny-gold'],
  'Penny Fosco': ['penny-fosco'],
  'Penny Grafito': ['penny-grafito'],
  'Schluter Trim': ['schluter-trim', 'schluter', 'schluter-jolly'],
  'Sun Blanco': ['sun-blanco', 'sun'],
};

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const results = {};

  for (const name of PRODUCTS) {
    const slugs = new Set(generateSlugs(name));
    if (EXTRA_SLUGS[name]) {
      for (const s of EXTRA_SLUGS[name]) slugs.add(s);
    }

    const found = [];
    for (const slug of slugs) {
      const url = `https://bellezzaceramica.com/product/${slug}/`;
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 });
        const status = resp?.status();
        if (status && status < 400) {
          const title = await page.title();
          if (!title.toLowerCase().includes('robot') && !title.toLowerCase().includes('challenge')) {
            await new Promise(r => setTimeout(r, 500));
            const imgCount = await page.evaluate(() => {
              return document.querySelectorAll('.woocommerce-product-gallery img, .wp-post-image').length;
            });
            found.push({ slug, title: title.substring(0, 60), images: imgCount });
            console.log(`  [OK] ${name}: ${slug} (${imgCount} imgs)`);
          }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        // skip timeouts
      }
    }

    if (found.length === 0) {
      console.log(`  [MISS] ${name}`);
    }
    results[name] = found;
  }

  console.log('\n\n=== WORKING SLUGS ===\n');
  for (const [name, found] of Object.entries(results)) {
    if (found.length > 0) {
      const slugList = found.map(f => `'${f.slug}'`).join(', ');
      console.log(`  '${name}': [${slugList}],`);
    } else {
      console.log(`  // '${name}': NOT FOUND`);
    }
  }

  const foundCount = Object.values(results).filter(f => f.length > 0).length;
  console.log(`\nFound: ${foundCount} / ${PRODUCTS.length}`);

  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
