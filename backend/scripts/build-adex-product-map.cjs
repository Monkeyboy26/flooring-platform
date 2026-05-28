/**
 * Build ADEX USA product map from adexusa.com
 *
 * Scrapes all collection subserie pages and extracts:
 *  - Gallery carousel images (swiper-slide background-image CSS)
 *  - Product cards (.product-xana) with thumbnail, name, ADEX code, category
 *
 * Usage: node backend/scripts/build-adex-product-map.cjs
 * Output: backend/data/adex-product-map.json
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://adexusa.com';
const OUTPUT = path.join(__dirname, '..', 'data', 'adex-product-map.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 400;

const COLLECTIONS = [
  'floor', 'habitat', 'hampton', 'horizon',
  'levante', 'mosaic', 'neri', 'ocean', 'studio',
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  await delay(DELAY_MS);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!resp.ok) {
    console.error(`  FETCH FAILED ${resp.status}: ${url}`);
    return null;
  }
  return resp.text();
}

/**
 * Strip WordPress image size suffix to get original resolution.
 * "image-en-hash-1024x257.jpg" -> "image-en-hash.jpg"
 */
function stripWpSizeSuffix(url) {
  return url.replace(/-\d+x\d+(\.\w+)$/, '$1');
}

/**
 * Extract subseries names from a collection page.
 * Looks for links like ?subserie=Frost Glossy
 */
function extractSubseries(html) {
  const subseries = new Set();
  const re = /[?&]subserie=([^"&]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = decodeURIComponent(m[1]).trim();
    if (name) subseries.add(name);
  }
  return [...subseries];
}

/**
 * Extract gallery carousel images from swiper-slide background-image URLs.
 */
function extractGalleryImages(html) {
  const images = [];
  const seen = new Set();
  // swiper-slide divs have inline style with background-image: url(...)
  const re = /class="swiper-slide[^"]*"[^>]*style="[^"]*background-image:\s*url\(&quot;([^&]+)&quot;\)|class="swiper-slide[^"]*"[^>]*style="[^"]*background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawUrl = m[1] || m[2];
    if (!rawUrl) continue;
    const url = stripWpSizeSuffix(rawUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    const filename = url.split('/').pop() || '';
    if (/logo|favicon|icon/i.test(filename)) continue;
    images.push({ url, filename });
  }
  return images;
}

/**
 * Extract product links from gallery carousel info-productos sections.
 * Each gallery slide has a corresponding info-productos block listing
 * the products visible in that lifestyle photo (e.g., "Chair Molding | Field Tile").
 * Returns one array per slide; each entry has { name, detailUrl }.
 */
function extractGalleryProductLinks(html) {
  const blocks = [];
  const blockRe = /class="info-productos\b/gi;
  const starts = [];
  let m;
  while ((m = blockRe.exec(html))) {
    starts.push(m.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : start + 2000;
    const block = html.slice(start, Math.min(end, start + 2000));

    const links = [];
    const linkRe = /href="((?:https?:\/\/adexusa\.com)?\/product\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(block))) {
      const rawUrl = lm[1].trim();
      const name = lm[2].trim();
      const detailUrl = rawUrl.startsWith('http') ? rawUrl : BASE_URL + rawUrl;
      links.push({ name, detailUrl });
    }

    blocks.push(links);
  }

  return blocks;
}

/**
 * Extract product cards from subserie page HTML.
 *
 * Strategy: scan the HTML sequentially, tracking the current category (h2)
 * and subcategory (h3) from .seccion-formato sections, then extract product
 * data from each .product-xana block.
 */
function extractProductCards(html) {
  const products = [];

  // Build an ordered list of markers: section headings and product cards
  // by scanning their positions in the HTML.

  // Find all h2 headings (category markers)
  const sectionH2s = [];
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let m;
  while ((m = h2Re.exec(html))) {
    const h2Text = m[1].replace(/<[^>]+>/g, '').trim();
    if (h2Text) sectionH2s.push({ pos: m.index, text: h2Text });
  }

  // Find all h3 headings (subcategories within sections)
  const h3s = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  while ((m = h3Re.exec(html))) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) h3s.push({ pos: m.index, text });
  }

  // Find main product-xana card divs only (not child __imagen/__contenido divs).
  // Main cards have "product-xana tmb" while children have "product-xana__".
  const cardRe = /class="product-xana\s+tmb/gi;
  const cardPositions = [];
  while ((m = cardRe.exec(html))) {
    cardPositions.push(m.index);
  }

  for (let ci = 0; ci < cardPositions.length; ci++) {
    const start = cardPositions[ci];
    const end = ci + 1 < cardPositions.length ? cardPositions[ci + 1] : start + 6000;
    const block = html.slice(start, Math.min(end, start + 6000));

    // Extract background-image URL (product thumbnail)
    // Do NOT strip WP size suffix — some product card images only exist at thumbnail size
    let imageUrl = null;
    const bgRe = /background-image:\s*url\(&quot;([^&]+)&quot;\)|background-image:\s*url\(["']?([^"');\s]+)["']?\)/i;
    const bgMatch = block.match(bgRe);
    if (bgMatch) {
      imageUrl = bgMatch[1] || bgMatch[2];
    }

    // Extract product name from h5
    let name = null;
    const h5Match = block.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
    if (h5Match) {
      name = h5Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // Extract ADEX code + dimensions from .tax-productos
    // Format varies: "2.8"x5.8" | ADSTA836" or "5.5"x6.3" | ADFAI600 | Glazed Porcelain Tiles"
    let code = null;
    let dimensions = null;
    const taxMatch = block.match(/class="[^"]*tax-productos[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i);
    if (taxMatch) {
      const taxText = taxMatch[1].replace(/<[^>]+>/g, '').trim();
      const codeParts = taxText.match(/\b(AD[A-Z]{1,4}[A-Z0-9]+)\b/);
      if (codeParts) code = codeParts[1];
      const dimParts = taxText.match(/^([^|]+)\|/);
      if (dimParts) {
        const dim = dimParts[1].replace(/,\s*$/, '').trim();
        if (dim) dimensions = dim;
      }
    }

    // Extract detail page URL from anchor tag (absolute or relative)
    let detailUrl = null;
    const linkMatch = block.match(/href="((?:https?:\/\/adexusa\.com)?\/product\/[^"]+)"/i);
    if (linkMatch) {
      detailUrl = linkMatch[1].startsWith('http') ? linkMatch[1] : BASE_URL + linkMatch[1];
    }

    // Determine category (most recent h2 before this card position)
    let category = null;
    for (let i = sectionH2s.length - 1; i >= 0; i--) {
      if (sectionH2s[i].pos < start) { category = sectionH2s[i].text; break; }
    }

    // Determine subcategory (most recent non-empty h3 before this card)
    let subcategory = null;
    for (let i = h3s.length - 1; i >= 0; i--) {
      if (h3s[i].pos < start) { subcategory = h3s[i].text; break; }
    }

    if (code || name) {
      products.push({
        code,
        name,
        dimensions,
        category,
        subcategory,
        imageUrl,
        detailUrl,
      });
    }
  }

  return products;
}

async function run() {
  console.log('=== Building ADEX USA Product Map ===\n');

  const result = {
    generated: new Date().toISOString(),
    domain: 'adexusa.com',
    summary: { collections: 0, subseries: 0, productCards: 0, galleryImages: 0 },
    collections: {},
  };

  for (const collection of COLLECTIONS) {
    console.log(`\n--- ${collection.toUpperCase()} ---`);

    // Fetch collection page to discover subseries
    const collUrl = `${BASE_URL}/series/${collection}/`;
    const collHtml = await fetchHtml(collUrl);
    if (!collHtml) {
      console.log('  SKIP: could not fetch collection page');
      continue;
    }

    const subseries = extractSubseries(collHtml);
    console.log(`  Found ${subseries.length} subseries: ${subseries.slice(0, 8).join(', ')}${subseries.length > 8 ? '...' : ''}`);

    const collData = {
      subseries: subseries,
      colors: {},
    };

    let collProducts = 0;
    let collGallery = 0;

    if (subseries.length === 0) {
      // No subseries (e.g., Floor) — scrape product cards from the main page
      console.log('  No subseries links — scraping main page directly');
      const galleryImages = extractGalleryImages(collHtml);
      const galleryLinks = extractGalleryProductLinks(collHtml);
      for (let gi = 0; gi < galleryImages.length; gi++) {
        galleryImages[gi].products = gi < galleryLinks.length ? galleryLinks[gi] : [];
      }
      const productCards = extractProductCards(collHtml);
      const categories = [...new Set(productCards.map(p => p.category).filter(Boolean))];

      collData.colors['_all'] = {
        galleryImages,
        categories,
        products: productCards,
      };

      collProducts = productCards.length;
      collGallery = galleryImages.length;
      console.log(`    Main page: ${galleryImages.length} gallery, ${productCards.length} products`);
    } else {
      for (const sub of subseries) {
        const subUrl = `${BASE_URL}/series/${collection}/?subserie=${encodeURIComponent(sub)}`;
        const html = await fetchHtml(subUrl);
        if (!html) continue;

        const galleryImages = extractGalleryImages(html);
        const galleryLinks = extractGalleryProductLinks(html);
        for (let gi = 0; gi < galleryImages.length; gi++) {
          galleryImages[gi].products = gi < galleryLinks.length ? galleryLinks[gi] : [];
        }
        const productCards = extractProductCards(html);

        // Determine unique categories present
        const categories = [...new Set(productCards.map(p => p.category).filter(Boolean))];

        collData.colors[sub] = {
          galleryImages,
          categories,
          products: productCards,
        };

        collProducts += productCards.length;
        collGallery += galleryImages.length;

        const firstCode = productCards.length > 0 ? productCards[0].code : '-';
        console.log(`    ${sub}: ${galleryImages.length} gallery, ${productCards.length} products (${firstCode})`);
      }
    }

    result.collections[collection] = collData;
    result.summary.collections++;
    result.summary.subseries += subseries.length;
    result.summary.productCards += collProducts;
    result.summary.galleryImages += collGallery;

    console.log(`  Totals: ${collGallery} gallery images, ${collProducts} product cards`);
  }

  // ── Inspiration Gallery ──
  console.log('\n=== Inspiration Gallery ===');
  result.inspirationGallery = await scrapeInspirationGallery();
  result.summary.inspirationImages = result.inspirationGallery.length;

  // Write output
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`Collections: ${result.summary.collections}`);
  console.log(`Subseries:   ${result.summary.subseries}`);
  console.log(`Products:    ${result.summary.productCards}`);
  console.log(`Gallery:     ${result.summary.galleryImages}`);
  console.log(`Inspiration: ${result.summary.inspirationImages}`);
  console.log(`Saved to:    ${OUTPUT}`);
}

/**
 * Scrape the ADEX Inspiration Gallery (/inspiration-gallery/).
 * Each gallery image links to an /ambientes/ page that lists associated products
 * with their ADEX codes. We extract: image URL, product codes, collection, room type.
 * Entries without associated products are skipped per user requirement.
 */
async function scrapeInspirationGallery() {
  // 1. Collect all /ambientes/ URLs from paginated gallery index
  const ambienteUrls = [];
  for (let page = 1; page <= 30; page++) {
    const pageUrl = page === 1
      ? `${BASE_URL}/inspiration-gallery/`
      : `${BASE_URL}/inspiration-gallery/page/${page}`;
    const html = await fetchHtml(pageUrl);
    if (!html) break;

    const urlRe = /href="((?:https?:\/\/adexusa\.com)?\/ambientes\/[^"]+)"/gi;
    let m;
    const before = ambienteUrls.length;
    while ((m = urlRe.exec(html))) {
      const url = m[1].startsWith('http') ? m[1] : BASE_URL + m[1];
      if (!ambienteUrls.includes(url)) ambienteUrls.push(url);
    }
    console.log(`  Page ${page}: ${ambienteUrls.length - before} new ambientes`);

    if (!html.includes(`/page/${page + 1}`)) break;
  }
  console.log(`  Total ambientes URLs: ${ambienteUrls.length}`);

  // 2. Fetch each ambientes page and extract data
  const entries = [];
  for (let i = 0; i < ambienteUrls.length; i++) {
    const html = await fetchHtml(ambienteUrls[i]);
    if (!html) continue;

    // Extract room scene image — large <a href="...jpg"> or <img src="...uploads/...jpg">
    let imageUrl = null;
    const imgLinkRe = /<a[^>]*href="(https?:\/\/adexusa\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png))"[^>]*>/i;
    const imgMatch = html.match(imgLinkRe);
    if (imgMatch) {
      imageUrl = stripWpSizeSuffix(imgMatch[1]);
    } else {
      // Fallback: <img src="...uploads/..."> in main content
      const imgSrcRe = /<img[^>]*src="(https?:\/\/adexusa\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png))"[^>]*>/i;
      const srcMatch = html.match(imgSrcRe);
      if (srcMatch) imageUrl = stripWpSizeSuffix(srcMatch[1]);
    }

    // Extract associated product codes from the ASSOCIATED PRODUCTS section
    // Use the full section until the Share/nav area (product cards can be 3500+ chars each)
    const codes = [];
    const assocIdx = html.indexOf('ASSOCIATED PRODUCTS');
    if (assocIdx !== -1) {
      // Find end boundary: "Share" button or "Inspiration Gallery" nav link after products
      let endIdx = html.indexOf('>Share<', assocIdx + 100);
      if (endIdx === -1) endIdx = html.indexOf('Inspiration Gallery', assocIdx + 100);
      if (endIdx === -1) endIdx = assocIdx + 20000;
      const section = html.slice(assocIdx, endIdx);
      const codeRe = /\b(AD[A-Z]{1,4}[A-Z0-9]+)\b/g;
      let cm;
      while ((cm = codeRe.exec(section))) {
        if (!codes.includes(cm[1])) codes.push(cm[1]);
      }
    }

    // Extract collection name
    let collection = null;
    const collMatch = html.match(/Collection Room Scene:\s*<a[^>]*>([^<]+)<\/a>/i);
    if (collMatch) collection = collMatch[1].trim();

    // Extract room type
    let roomType = null;
    const roomMatch = html.match(/Type of room\s*(?:<[^>]*>\s*)*([A-Za-z ]+)/i);
    if (roomMatch) roomType = roomMatch[1].trim();

    // Only include entries with associated products (user: "skip if it doesn't specify")
    if (imageUrl && codes.length > 0) {
      entries.push({
        pageUrl: ambienteUrls[i],
        imageUrl,
        collection,
        roomType,
        productCodes: codes,
      });
    }

    if ((i + 1) % 25 === 0 || i === ambienteUrls.length - 1) {
      console.log(`  Processed ${i + 1}/${ambienteUrls.length} ambientes (${entries.length} with products)`);
    }
  }

  console.log(`  Inspiration gallery entries with products: ${entries.length}`);
  return entries;
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
