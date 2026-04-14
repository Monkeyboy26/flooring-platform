/**
 * Discover all current product URLs on bellezzaceramica.com
 * by crawling category pages. Used to fix URL_MAP in bellezza.js scraper.
 *
 * Usage: docker compose exec api node scripts/bellezza-discover-urls.js
 */
import puppeteer from 'puppeteer';

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
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
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

  const categories = [
    'https://bellezzaceramica.com/product-category/porcelain-tiles/',
    'https://bellezzaceramica.com/product-category/porcelain-tiles/page/2/',
    'https://bellezzaceramica.com/product-category/porcelain-tiles/page/3/',
    'https://bellezzaceramica.com/product-category/porcelain-tiles/page/4/',
    'https://bellezzaceramica.com/product-category/porcelain-tiles/page/5/',
    'https://bellezzaceramica.com/product-category/porcelain-tiles/page/6/',
    'https://bellezzaceramica.com/product-category/wall-tiles/',
    'https://bellezzaceramica.com/product-category/wall-tiles/page/2/',
    'https://bellezzaceramica.com/product-category/wall-tiles/page/3/',
    'https://bellezzaceramica.com/product-category/mosaic/',
    'https://bellezzaceramica.com/product-category/mosaic/page/2/',
    'https://bellezzaceramica.com/product-category/outdoor/',
    'https://bellezzaceramica.com/product-category/accessories/',
    'https://bellezzaceramica.com/product-category/panels/',
    'https://bellezzaceramica.com/product-category/glass-tiles/',
    'https://bellezzaceramica.com/product-category/hexagon/',
    'https://bellezzaceramica.com/product-category/hexagon/page/2/',
    'https://bellezzaceramica.com/product-category/subway-tiles/',
    'https://bellezzaceramica.com/product-category/subway-tiles/page/2/',
    'https://bellezzaceramica.com/product-category/trim/',
    'https://bellezzaceramica.com/product-category/uncategorized/',
    'https://bellezzaceramica.com/shop/',
    'https://bellezzaceramica.com/shop/page/2/',
    'https://bellezzaceramica.com/shop/page/3/',
    'https://bellezzaceramica.com/shop/page/4/',
    'https://bellezzaceramica.com/shop/page/5/',
    'https://bellezzaceramica.com/shop/page/6/',
    'https://bellezzaceramica.com/shop/page/7/',
    'https://bellezzaceramica.com/shop/page/8/',
    'https://bellezzaceramica.com/shop/page/9/',
    'https://bellezzaceramica.com/shop/page/10/',
  ];

  const allProductUrls = new Set();

  for (const catUrl of categories) {
    try {
      const resp = await page.goto(catUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      if (!resp || resp.status() >= 400) {
        continue; // skip 404 pages silently
      }
      const title = await page.title();
      if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('challenge')) {
        console.log(`CAPTCHA on ${catUrl}`);
        continue;
      }
      await new Promise(r => setTimeout(r, 1500));

      // Scroll to load lazy content
      await page.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          window.scrollBy(0, 400);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
      await new Promise(r => setTimeout(r, 500));

      const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href*="/product/"]');
        return [...new Set([...anchors].map(a => a.href).filter(h => h.includes('/product/')))];
      });
      const newCount = links.filter(l => !allProductUrls.has(l)).length;
      for (const l of links) allProductUrls.add(l);
      if (links.length > 0) {
        console.log(`${catUrl} => ${links.length} links (${newCount} new)`);
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.log(`ERROR ${catUrl}: ${e.message}`);
    }
  }

  // Print all discovered URLs sorted
  console.log(`\n=== ALL PRODUCT URLS (${allProductUrls.size}) ===`);
  const sorted = [...allProductUrls].sort();
  for (const u of sorted) {
    // Extract just the slug
    const slug = u.replace('https://bellezzaceramica.com/product/', '').replace(/\/$/, '');
    console.log(slug);
  }

  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
