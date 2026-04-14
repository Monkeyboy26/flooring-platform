/**
 * Try alternate slug patterns for Bellezza products that returned 404.
 * Individual product pages bypass SiteGround captcha, so we can probe them directly.
 *
 * Usage: docker compose exec api node scripts/bellezza-fix-slugs.js
 */
import puppeteer from 'puppeteer';

// Products that returned 404 or 0 images, with candidate slugs to try
const CANDIDATES = {
  'Arena Chiaro': [
    'arena-chiaro', 'arena-chiaro-matte', 'arena-chiaro-polished',
    'arena-chiaro-24x48', 'arena-chiaro-12x24', 'arena-chiaro-porcelain',
  ],
  'Angelo Silk Shimmer': [
    'angelo-silk-shimmer', 'angelo-silk-shimmer-silver', 'angelo-silk-shimmer-gold',
    'angelo-silk-shimmer-porcelain',
  ],
  'Calaca Gold': [
    'calaca-gold', 'calaca-gold-matte', 'calaca-gold-deco', 'calaca-gold-deco-top',
    'calaca-gold-deco-top-matte',
  ],
  'Calacatta Gold': [
    'calacatta-gold', 'calacatta-gold-polished', 'calacatta-gold-lux',
    'calacatta-gold-semi-polished', 'calacatta-gold-lux-polished',
    'calacatta-gold-12x24', 'calacatta-gold-24x48',
  ],
  'Calacatta Hex Gloss': [
    'calacatta-hex-gloss', 'calacatta-hex-gloss-polished',
    'calacatta-hex-gloss-wall', 'calacatta-hex',
  ],
  'Calacatta Brick Gloss': [
    'calacatta-brick-gloss', 'calacatta-brick', 'calacatta-brick-wall',
    'calacatta-brick-gloss-wall-tile',
  ],
  'Calcutta Gold': [
    'calcutta-gold', 'calcutta-gold-polished', 'calcutta-gold-24x48',
    'calcutta-gold-matte-porcelain',
  ],
  'Concretus': [
    'concretus', 'concretus-dark', 'concretus-light', 'concretus-matte',
    'concretus-dark-matte', 'concretus-light-matte',
  ],
  'Docks': [
    'docks', 'docks-beige', 'docks-white', 'docks-matte',
  ],
  'Elegance Marble Pearl': [
    'elegance-marble-pearl', 'elegance-marble-pearl-polished', 'elegance-marble',
    'elegance-pearl',
  ],
  'Granby Beige': [
    'granby-beige', 'granby-beige-matte', 'granby-beige-porcelain',
    'granby-beige-24x48',
  ],
  'Grunge': [
    'grunge', 'grunge-beige', 'grunge-smoke', 'grunge-matte',
    'grunge-beige-matte', 'grunge-smoke-matte', 'grunge-multi',
  ],
  'Harley Lux': [
    'harley-lux', 'harley-lux-black', 'harley-lux-graphite', 'harley-lux-super-white',
    'harley-lux-white',
  ],
  'Leccese Cesellata': [
    'leccese', 'leccese-cesellata-porcelain', 'leccese-cesellata-matte',
  ],
  'Lingot': [
    'lingot', 'lingot-aqua', 'lingot-blue', 'lingot-coral', 'lingot-mint', 'lingot-white',
  ],
  'Manhattan': [
    'manhattan', 'manhattan-mud', 'manhattan-pearl', 'manhattan-matte',
  ],
  'Markina Gold': [
    'markina-gold', 'markina-gold-24x48', 'markina-gold-matte',
  ],
  'Mixit Concept': [
    'mixit-concept', 'mixit-concept-blanco', 'mixit-concept-gris', 'mixit-concept-matte',
    'mixit',
  ],
  'Montblanc Gold': [
    'montblanc-gold', 'montblanc-gold-24x48', 'montblanc-gold-matte',
    'mont-blanc-gold', 'mont-blanc-gold-polished',
  ],
  'Myrcella': [
    'myrcella', 'myrcella-beige', 'myrcella-bone', 'myrcella-grey', 'myrcella-mocca',
    'myrcella-matte',
  ],
  'Naples White': [
    'naples-white', 'naples-white-polished', 'naples-white-matte',
    'naples-white-porcelain',
  ],
  'Palatino': [
    'palatino', 'palatino-ivory', 'palatino-ivory-matte', 'palatino-matte',
    'deco-palatino', 'deco-palatino-ivory',
  ],
  'Puccini': [
    'puccini', 'puccini-blanco', 'puccini-marfil', 'puccini-perla',
    'puccini-polished', 'puccini-matte',
  ],
  'Spatula': [
    'spatula', 'spatula-antracite', 'spatula-grey', 'spatula-white', 'spatula-bone',
    'spatula-matte', 'spatula-r10',
  ],
  'Statuario Nice': [
    'statuario-nice', 'statuario-nice-matte', 'statuario',
  ],
  'Volga': [
    'volga', 'volga-grafito', 'volga-gris', 'volga-matte',
  ],
  'Milano Mosaic': [
    'milano-mosaic', 'milano-gold-mosaic', 'milano-silver-mosaic',
    'milano-gold-matte', 'milano-silver-matte',
  ],
  'Hex XL Coimbra': [
    'hex-xl-coimbra', 'hex-xl-coimbra-porcelain', 'coimbra',
    'hex-coimbra', 'coimbra-matte',
  ],
  'Hex XL Fosco': [
    'hex-xl-fosco', 'hex-xl-fosco-porcelain', 'fosco',
    'hex-fosco', 'fosco-matte',
  ],
  'Hex XL Inverno Grey': [
    'hex-xl-inverno-grey', 'hex-xl-inverno', 'inverno-grey',
    'hex-inverno-grey', 'inverno-grey-matte',
  ],
  'Gio': [
    'gio-black-grey-white-matte-hexagon', 'gio-black-taupe-white-matte-hexagon',
    'gio-black-white-glossy-hexagon', 'gio-white-glossy-hexagon-2x2',
    'gio-white-matte-hexagon-2x2', 'gio-white-matte-hexagon-4x4',
    'gio-matte-hexagon', 'gio-glossy-hexagon', 'gio-hexagon',
  ],
  'Altea': [
    'altea-ash-blue-4x4-3x6', 'altea-black-4x4-3x6', 'altea-dusty-pink-4x4-3x6',
    'altea-pine-green-4x4-3x6', 'altea-rosewood-4x4-3x6', 'altea-smoke-4x4-3x6',
    'altea-thistle-blue-4x4-3x6', 'altea-white-4x4-3x6', 'altea-matcha-4x4-3x6',
  ],
  'Amazonia': [
    'amazonia-artic', 'amazonia-carbon', 'amazonia-chalk',
    'amazonia-sand', 'amazonia-sapphire',
  ],
  // Discovered from hexagon pages
  'Frammenti': [
    'frammenti-fr-10-bianco-3-x16', 'frammenti-fr-10-bianco-8x8',
    'frammenti-fr-12-blu-notte-3-x16', 'frammenti-fr-2-azzurro-3-x16',
    'frammenti-fr-2-azzurro-micro-macro-8-x8', 'frammenti-fr-5-grigio-3-x16',
    'frammenti-fr-8-nero-micro-macro-8x8',
  ],
  // Discovered GIO from hexagon page
  'Recycled Glass Hexagon': [
    'natureglass-black-hexagon', 'natureglass-smooth-grey-hex',
    'natureglass-white-hexagon', 'nero-marquina-matte-hexagon',
    'silver-matte-hexagon', 'statuario-white-matte-hexagon',
    'white-hexagon-4x4', 'grey-hexagon',
  ],
  'Limit': [
    'limit-blanc-2%c2%bdx-10', 'limit-bleu-clair-2%c2%bdx-10',
    'limit-bleu-izu-2%c2%bdx-10',
  ],
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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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

  for (const [productName, slugs] of Object.entries(CANDIDATES)) {
    const found = [];
    for (const slug of slugs) {
      const url = `https://bellezzaceramica.com/product/${slug}/`;
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        const status = resp?.status();
        if (status && status < 400) {
          const title = await page.title();
          if (!title.toLowerCase().includes('robot') && !title.toLowerCase().includes('challenge')) {
            // Check if it has product images
            await new Promise(r => setTimeout(r, 800));
            const hasImages = await page.evaluate(() => {
              const imgs = document.querySelectorAll('.woocommerce-product-gallery img, .wp-post-image');
              return imgs.length;
            });
            found.push({ slug, title: title.substring(0, 60), images: hasImages });
            console.log(`  [OK] ${productName}: ${slug} (${hasImages} imgs) — "${title.substring(0, 50)}"`);
          } else {
            console.log(`  [CAPTCHA] ${productName}: ${slug}`);
          }
        }
        // Small delay between requests
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        // timeout or nav error, skip
      }
    }
    if (found.length === 0) {
      console.log(`  [MISS] ${productName}: no working slugs found`);
    }
    results[productName] = found;
  }

  console.log('\n\n=== SUMMARY: WORKING SLUGS ===\n');
  for (const [name, found] of Object.entries(results)) {
    if (found.length > 0) {
      const slugList = found.map(f => `'${f.slug}'`).join(', ');
      console.log(`  '${name}': [${slugList}],`);
    } else {
      console.log(`  // '${name}': NOT FOUND`);
    }
  }

  console.log('\n=== STATS ===');
  const foundCount = Object.values(results).filter(f => f.length > 0).length;
  const totalCount = Object.keys(results).length;
  console.log(`Found: ${foundCount} / ${totalCount}`);

  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
