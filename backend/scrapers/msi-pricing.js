import { launchBrowser, delay, upsertPricing, appendLog, addJobError } from './base.js';
import { portalLogin, screenshot } from './msi-portal-auth.js';

const DEFAULT_CONFIG = {
  delayMs: 500
};

const INVENTORY_API = 'https://www.msisurfaces.com/inventory/tiledetails/?handler=CatagoryPartial&ItemId=';
const B2B_INVENTORY_API = 'https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * MSI Dealer Portal pricing scraper.
 *
 * Logs into the MyMSI B2B portal, then uses the authenticated session to:
 * 1. Check if the public inventory API returns dealer pricing with B2B cookies
 * 2. If not, navigate to individual product detail pages in the B2B portal
 *    and extract pricing from the product detail view
 *
 * The scraper iterates through all known MSI SKUs and attempts to extract
 * dealer cost from the B2B portal's product detail pages.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  let browser;

  try {
    await appendLog(pool, job.id, 'Launching browser for MSI dealer pricing...');
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Login to B2B portal
    await portalLogin(page, pool, job);

    // Grab authenticated cookies from the B2B session
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    await appendLog(pool, job.id, `Got ${cookies.length} session cookies`);

    // Load MSI SKUs that don't already have pricing — tiles/pavers first (for NonSlabSelector), slabs last
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku, s.sell_by, s.variant_type
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE v.code = 'MSI' AND s.vendor_sku IS NOT NULL
        AND (pr.cost IS NULL OR pr.cost = 0)
      ORDER BY
        CASE WHEN s.sell_by = 'unit' OR s.variant_type IN ('slab') OR s.vendor_sku LIKE 'RSL%' OR s.vendor_sku LIKE 'VSL%' OR s.vendor_sku LIKE 'CSL%'
             THEN 1 ELSE 0 END,
        s.vendor_sku
    `);

    const allSkus = skuResult.rows;
    const tileSkus = allSkus.filter(s => s.sell_by !== 'unit' && !['slab'].includes(s.variant_type) && !s.vendor_sku.match(/^[RVC]SL-/));
    const slabSkus = allSkus.filter(s => s.sell_by === 'unit' || ['slab'].includes(s.variant_type) || (s.vendor_sku && s.vendor_sku.match(/^[RVC]SL-/)));
    await appendLog(pool, job.id, `Loaded ${allSkus.length} MSI SKUs (${tileSkus.length} tiles, ${slabSkus.length} slabs/units)`);

    // Phase 1: Test if the public API returns pricing with B2B cookies
    // Try first 3 tile SKUs (not slabs — slabs won't return API data)
    await appendLog(pool, job.id, 'Testing if authenticated API returns dealer pricing...');

    let authReturnsPrice = false;
    const testSkus = tileSkus.slice(0, 3);

    for (const sku of testSkus) {
      const publicHtml = await fetchApi(INVENTORY_API + encodeURIComponent(sku.vendor_sku), null);
      const authHtml = await fetchApi(INVENTORY_API + encodeURIComponent(sku.vendor_sku), cookieHeader);

      // Also try the B2B domain version
      const b2bUrl = `https://b2b.msisurfaces.com/inventory/tiledetails/?handler=CatagoryPartial&ItemId=${encodeURIComponent(sku.vendor_sku)}`;
      const b2bHtml = await fetchApi(b2bUrl, cookieHeader);

      const publicHasPrice = publicHtml && (publicHtml.includes('Price') || publicHtml.includes('price') || publicHtml.includes('$'));
      const authHasPrice = authHtml && (authHtml.includes('Price') || authHtml.includes('price') || authHtml.includes('$'));
      const b2bHasPrice = b2bHtml && (b2bHtml.includes('Price') || b2bHtml.includes('price') || b2bHtml.includes('$'));

      await appendLog(pool, job.id, `  ${sku.vendor_sku}: public=${publicHtml ? publicHtml.length : 0}b(price:${publicHasPrice}) auth=${authHtml ? authHtml.length : 0}b(price:${authHasPrice}) b2b=${b2bHtml ? b2bHtml.length : 0}b(price:${b2bHasPrice})`);

      // Check if auth version has extra content (like price fields) that public doesn't
      if (authHtml && publicHtml && authHtml.length > publicHtml.length + 50) {
        await appendLog(pool, job.id, `    Auth response is ${authHtml.length - publicHtml.length} bytes larger — may contain pricing`);
        authReturnsPrice = true;
      }
      if (authHasPrice && !publicHasPrice) {
        authReturnsPrice = true;
      }
      if (b2bHasPrice) {
        authReturnsPrice = true;
        await appendLog(pool, job.id, `    B2B domain returns pricing!`);
      }
    }

    if (authReturnsPrice) {
      // Phase 2a: API-based extraction with authenticated cookies
      // API works for all SKU types — use full list
      await appendLog(pool, job.id, 'Authenticated API returns pricing data — using API extraction.');
      await extractPricesViaApi(pool, job, allSkus, cookieHeader, config);
    } else {
      // Phase 2b: Browser-based extraction — navigate to product detail pages
      // NonSlabSelector only shows tiles/pavers — process tiles first, then attempt slabs
      await appendLog(pool, job.id, 'API does not return pricing — falling back to browser-based extraction.');
      await appendLog(pool, job.id, `Processing ${tileSkus.length} tile SKUs via NonSlabSelector...`);
      await extractPricesViaBrowser(page, pool, job, tileSkus, config);
      if (slabSkus.length > 0) {
        await appendLog(pool, job.id, `Skipping ${slabSkus.length} slab/unit SKUs — NonSlabSelector does not support them. Use API mode or separate slab tool.`);
      }
    }

    await page.close();
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Fetch a URL with optional cookies, return HTML string or null.
 */
async function fetchApi(url, cookieHeader) {
  try {
    const headers = { 'User-Agent': USER_AGENT };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Extract price from inventory API HTML response.
 * Looks for price-related fields that appear in authenticated responses.
 */
function extractPriceFromHtml(html) {
  if (!html) return null;

  // Look for dollar amounts near "price", "cost", "dealer" keywords
  const pricePatterns = [
    /(?:dealer|cost|price|unit)\s*(?:price)?[:\s]*\$?\s*([\d,]+\.?\d{0,2})/i,
    /\$\s*([\d,]+\.\d{2})\s*(?:\/?\s*(?:sq\.?\s*ft|sf|each|pc|unit))/i,
    /Price[^<]*?<\/td>\s*<td[^>]*>\s*\$?\s*([\d,]+\.?\d{0,2})/i
  ];

  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match) {
      const price = parseFloat(match[1].replace(/,/g, ''));
      if (price > 0 && price < 10000) return price;
    }
  }

  return null;
}

/**
 * API-based price extraction using authenticated cookies.
 */
async function extractPricesViaApi(pool, job, skus, cookieHeader, config) {
  let found = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];

    try {
      // Try B2B domain first, then public domain with cookies
      const b2bUrl = `https://b2b.msisurfaces.com/inventory/tiledetails/?handler=CatagoryPartial&ItemId=${encodeURIComponent(sku.vendor_sku)}`;
      let html = await fetchApi(b2bUrl, cookieHeader);
      if (!html || html.includes('No Records')) {
        html = await fetchApi(INVENTORY_API + encodeURIComponent(sku.vendor_sku), cookieHeader);
      }

      const cost = extractPriceFromHtml(html);
      if (cost === null) continue;

      found++;

      // Determine price basis from HTML context
      const htmlLower = (html || '').toLowerCase();
      const priceBasis = (htmlLower.includes('each') || htmlLower.includes('per unit') || htmlLower.includes('/pc'))
        ? 'per_unit' : 'per_sqft';

      await upsertPricing(pool, sku.id, { cost, retail_price: 0, price_basis: priceBasis });
      updated++;
    } catch (err) {
      errors++;
      if (errors <= 10) {
        await appendLog(pool, job.id, `Error for ${sku.vendor_sku}: ${err.message}`);
        await addJobError(pool, job.id, `SKU ${sku.vendor_sku}: ${err.message}`);
      }
    }

    if ((i + 1) % 50 === 0 || i === skus.length - 1) {
      await appendLog(pool, job.id, `Progress: ${i + 1}/${skus.length}, found ${found}, updated ${updated}`, {
        products_found: found,
        products_updated: updated
      });
    }

    await delay(config.delayMs);
  }

  await appendLog(pool, job.id, `API price extraction complete. Found: ${found}, Updated: ${updated}, Errors: ${errors}`, {
    products_found: found,
    products_updated: updated
  });
}

/**
 * Browser-based price extraction.
 *
 * Discovery-first approach: search for one SKU, dump the full product card
 * HTML structure, click into the first result, and screenshot the detail page.
 * Then attempt bulk extraction if pricing is found.
 */
async function extractPricesViaBrowser(page, pool, job, skus, config) {
  await appendLog(pool, job.id, 'Navigating to B2B inventory tool...');

  await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  await delay(2000);

  // === DISCOVERY PHASE ===
  // Search for first SKU and dump the HTML structure of product cards
  const testSku = skus[0];
  await appendLog(pool, job.id, `Discovery: searching for ${testSku.vendor_sku}...`);

  await page.evaluate(() => {
    const itemId = document.querySelector('#ctl00_ContentPlaceHolder1_txtItemID');
    if (itemId) itemId.value = '';
  });
  await page.type('#ctl00_ContentPlaceHolder1_txtItemID', testSku.vendor_sku, { delay: 20 });

  await Promise.all([
    page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
  ]);
  await delay(3000);

  // Find product card elements by searching for product name text nodes
  // and examine the HTML structure around them
  const discoveryData = await page.evaluate(() => {
    const text = document.body.innerText || '';
    // Get all text content to find product names between pagination markers
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Find elements that contain product-name-like text
    // Product names appear as all-caps multi-word text on the results page
    const productCards = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const nodeText = node.textContent.trim();
      // Product names are typically all-caps, multi-word, 8-60 chars
      if (nodeText.length > 7 && nodeText.length < 60 &&
          nodeText === nodeText.toUpperCase() &&
          /^[A-Z][A-Z\s]+[A-Z]$/.test(nodeText) &&
          nodeText.includes(' ')) {
        // Skip known non-product text
        const skipTexts = ['TECH SUPPORT', 'MY ACCOUNT', 'CONTACT YOUR SALES REP', 'ADVANCE SEARCH',
          'PRODUCT NAME', 'ITEM ID CONTAINS', 'RESULT PER PAGE', 'FLOOR TILE', 'WALL TILE',
          'HARDSCAPE', 'PREFAB COUNTERTOPS', 'VANITY TOPS', 'FLOORS MATS', 'SINKS / FAUCETS',
          'COOKIE POLICY', 'PRIVACY POLICY', 'DO NOT SELL'];
        if (skipTexts.some(s => nodeText.includes(s))) continue;

        const el = node.parentElement;
        if (!el) continue;

        // Walk up to find the clickable card container
        let clickable = el.closest('a, [onclick], [role="link"], [role="button"]');
        let container = el.closest('div[class*="col"], div[class*="card"], div[class*="item"], div[class*="product"]') || el.parentElement;

        productCards.push({
          text: nodeText,
          elTag: el.tagName.toLowerCase(),
          elId: el.id || '',
          elClass: (el.className || '').toString().slice(0, 100),
          elHtml: el.outerHTML.slice(0, 300),
          clickableTag: clickable?.tagName.toLowerCase() || null,
          clickableHref: clickable?.getAttribute('href')?.slice(0, 150) || null,
          containerTag: container?.tagName.toLowerCase() || null,
          containerClass: (container?.className || '').toString().slice(0, 100),
          containerHtml: container?.outerHTML?.slice(0, 800) || '',
          // Check for background images (product thumbnails might be CSS bg)
          containerStyle: container?.getAttribute('style')?.slice(0, 200) || '',
          // Look for img children in the container
          hasChildImg: !!container?.querySelector('img'),
          childImgSrc: container?.querySelector('img')?.getAttribute('src')?.slice(0, 150) || '',
          // Check for background-image in children
          bgDivs: Array.from(container?.querySelectorAll('[style*="background"]') || [])
            .map(d => d.getAttribute('style').slice(0, 200)).slice(0, 3)
        });
      }
    }

    return {
      pageText: text.slice(0, 500),
      productCards: productCards.slice(0, 5)
    };
  });

  await appendLog(pool, job.id, `[Discovery] Found ${discoveryData.productCards.length} product card elements`);
  for (const card of discoveryData.productCards) {
    await appendLog(pool, job.id, `  Product: "${card.text}"`);
    await appendLog(pool, job.id, `    element: <${card.elTag}> id="${card.elId}" class="${card.elClass}"`);
    await appendLog(pool, job.id, `    element HTML: ${card.elHtml}`);
    await appendLog(pool, job.id, `    clickable ancestor: ${card.clickableTag ? `<${card.clickableTag}> href="${card.clickableHref}"` : 'none'}`);
    await appendLog(pool, job.id, `    container: <${card.containerTag}> class="${card.containerClass}"`);
    await appendLog(pool, job.id, `    container HTML: ${card.containerHtml.slice(0, 600)}`);
    await appendLog(pool, job.id, `    hasImg=${card.hasChildImg} imgSrc="${card.childImgSrc}"`);
    if (card.bgDivs.length > 0) {
      await appendLog(pool, job.id, `    bgDivs: ${JSON.stringify(card.bgDivs)}`);
    }
  }

  // Click the first product detail link (TileDetails.aspx)
  const clickResult = await page.evaluate(() => {
    const detailLink = document.querySelector('a[href*="TileDetails.aspx"]');
    if (detailLink) {
      const href = detailLink.getAttribute('href');
      const text = detailLink.textContent.trim().slice(0, 60);
      return { clicked: true, href, text };
    }
    return { clicked: false };
  });

  await appendLog(pool, job.id, `[Discovery] Click result: ${JSON.stringify(clickResult)}`);

  if (clickResult.clicked) {
    // Navigate to the TileDetails page using the href
    const detailUrl = clickResult.href.startsWith('http')
      ? clickResult.href
      : `https://b2b.msisurfaces.com/B2BTiles/${clickResult.href}`;
    await appendLog(pool, job.id, `[Discovery] Navigating to: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    await screenshot(page, 'pricing-product-detail');
    const currentDetailUrl = page.url();
    await appendLog(pool, job.id, `[Discovery] Product detail page URL: ${currentDetailUrl}`);

    // The product detail page has a table with Item ID links.
    // "Please Click on Item ID/Description for inventory details"
    // We need to click the Item ID link to get to the per-SKU detail page
    // which may contain pricing.
    const itemIdLink = await page.evaluate(() => {
      // The Item ID links in the product detail table are postback links like:
      // <a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$tabContainer1$TabPanel1$gvItemInfo$ctl02$lnkItem','')">VTGSELBOU9X48-2MM-12MIL</a>
      // They contain SKU codes (alphanumeric + dashes) and use ContentPlaceHolder postbacks
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const text = a.textContent.trim();
        if (text.length < 5 || text.length > 50) continue;

        // Match SKU-like text: mostly uppercase letters, digits, dashes
        // e.g. VTGSELBOU9X48-2MM-12MIL, NANTMARE1224-E, etc.
        if (!/^[A-Z0-9][A-Z0-9\-_]+$/.test(text)) continue;

        // Must be a postback link in the content area
        if (href.includes('__doPostBack') && href.includes('ContentPlaceHolder')) {
          return { text, type: 'postback' };
        }
        // Or a direct URL link
        if (href.startsWith('http') || (href.startsWith('/') && !href.startsWith('//'))) {
          return { href, text, type: 'url' };
        }
      }
      return null;
    });

    if (itemIdLink) {
      await appendLog(pool, job.id, `[Discovery] Found Item ID link: "${itemIdLink.text}" → ${(itemIdLink.href || '').slice(0, 100)}`);

      // Click through to the Item ID detail page
      if (itemIdLink.type === 'postback') {
        // ASP.NET postback — click the link and wait for navigation or update
        await Promise.all([
          page.evaluate((linkText) => {
            const links = document.querySelectorAll('a');
            for (const a of links) {
              if (a.textContent.trim() === linkText) { a.click(); return; }
            }
          }, itemIdLink.text),
          // Wait for either a full navigation or network idle (UpdatePanel async postback)
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
        ]);
        await delay(3000);
        // Check if page URL changed — if not, the postback may have updated the panel
        const postClickUrl = page.url();
        await appendLog(pool, job.id, `[Discovery] After postback click, URL: ${postClickUrl}`);
      } else {
        const itemDetailUrl = itemIdLink.href.startsWith('http')
          ? itemIdLink.href
          : `https://b2b.msisurfaces.com/B2BTiles/${itemIdLink.href}`;
        await page.goto(itemDetailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(3000);
      }

      await screenshot(page, 'pricing-item-detail');
      await appendLog(pool, job.id, `[Discovery] Item detail page URL: ${page.url()}`);

      const itemDetailData = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const dollarMatches = text.match(/\$\s*[\d,]+\.?\d{0,2}/g) || [];
        const priceKeywords = text.match(/(?:price|cost|dealer|wholesale|msrp|retail|unit price|per sq|per unit|each)[^\n]{0,80}/gi) || [];
        // Get all table content for analysis
        const tables = Array.from(document.querySelectorAll('table')).map(t => t.innerText.slice(0, 500));
        return {
          text: text.slice(0, 4000),
          dollarMatches: dollarMatches.slice(0, 20),
          priceKeywords: priceKeywords.slice(0, 10),
          tables: tables.slice(0, 5),
          title: document.title
        };
      });

      await appendLog(pool, job.id, `[Discovery] Item detail title: ${itemDetailData.title}`);
      await appendLog(pool, job.id, `[Discovery] Item detail text (first 2500): ${itemDetailData.text.slice(0, 2500)}`);
      await appendLog(pool, job.id, `[Discovery] Dollar amounts: ${JSON.stringify(itemDetailData.dollarMatches)}`);
      await appendLog(pool, job.id, `[Discovery] Price keywords: ${JSON.stringify(itemDetailData.priceKeywords)}`);
      for (let t = 0; t < itemDetailData.tables.length; t++) {
        await appendLog(pool, job.id, `[Discovery] Table ${t}: ${itemDetailData.tables[t]}`);
      }

      if (itemDetailData.dollarMatches.length > 0 || itemDetailData.priceKeywords.length > 0) {
        await appendLog(pool, job.id, 'PRICING FOUND on item detail page! Proceeding with bulk extraction.');
      } else {
        await appendLog(pool, job.id, 'No pricing found on item detail page either. Check screenshots in uploads/ for page structure.');
        return;
      }
    } else {
      await appendLog(pool, job.id, '[Discovery] No Item ID link found on product detail page.');
      // Dump page text and links for debugging
      const pageData = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const links = Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim().slice(0, 60),
          href: (a.getAttribute('href') || '').slice(0, 120)
        })).filter(l => l.text.length > 0);
        const dollarMatches = text.match(/\$\s*[\d,]+\.?\d{0,2}/g) || [];
        return { text: text.slice(0, 2000), links: links.slice(0, 20), dollarMatches };
      });
      await appendLog(pool, job.id, `[Discovery] Page text: ${pageData.text.slice(0, 1500)}`);
      await appendLog(pool, job.id, `[Discovery] Dollar amounts: ${JSON.stringify(pageData.dollarMatches)}`);
      for (const l of pageData.links.slice(0, 15)) {
        await appendLog(pool, job.id, `  Link: "${l.text}" → ${l.href}`);
      }
      if (pageData.dollarMatches.length === 0) {
        await appendLog(pool, job.id, 'No pricing found. Check screenshots.');
        return;
      }
    }
  } else {
    await appendLog(pool, job.id, 'RESULT: Could not click any product card. The product cards may not be interactive or use a non-standard click mechanism.');
    await screenshot(page, 'pricing-no-clickable-products');
    return;
  }

  // === EXTRACTION PHASE ===
  // If we found pricing data in discovery, proceed with bulk extraction
  await appendLog(pool, job.id, 'Pricing data detected — proceeding with bulk extraction...');

  let found = 0;
  let updated = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  // Navigate back to the search page to start extraction
  await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
    waitUntil: 'networkidle2', timeout: 60000
  });
  await delay(2000);

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];

    try {
      // Ensure we're on the search page with the search input available
      const hasSearchInput = await page.evaluate(() => !!document.querySelector('#ctl00_ContentPlaceHolder1_txtItemID'));
      if (!hasSearchInput) {
        const currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('Login') || !currentUrl.includes('b2b.msisurfaces.com')) {
          await appendLog(pool, job.id, 'Session expired — re-authenticating...');
          await portalLogin(page, pool, job);
        }
        await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
          waitUntil: 'networkidle2', timeout: 60000
        });
        await delay(2000);
        // Verify search input is back
        const inputBack = await page.evaluate(() => !!document.querySelector('#ctl00_ContentPlaceHolder1_txtItemID'));
        if (!inputBack) {
          // Session still broken — try full re-login
          await appendLog(pool, job.id, 'Search page not loading — forcing re-login...');
          await page.goto('https://www.msisurfaces.com/customer-portal/', { waitUntil: 'networkidle2', timeout: 60000 });
          await portalLogin(page, pool, job);
          await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
            waitUntil: 'networkidle2', timeout: 60000
          });
          await delay(2000);
        }
      }

      // Step 1: Search for this SKU
      await page.evaluate(() => {
        const el = document.querySelector('#ctl00_ContentPlaceHolder1_txtItemID');
        if (el) el.value = '';
      });
      await page.type('#ctl00_ContentPlaceHolder1_txtItemID', sku.vendor_sku, { delay: 20 });

      await Promise.all([
        page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
      ]);
      await delay(1500);

      // Step 2: Click first TileDetails link
      const detailHref = await page.evaluate(() => {
        const link = document.querySelector('a[href*="TileDetails.aspx"]');
        return link ? link.getAttribute('href') : null;
      });

      if (!detailHref) { consecutiveErrors = 0; continue; }

      consecutiveErrors = 0; // Search worked — session is alive
      const tileDetailUrl = detailHref.startsWith('http')
        ? detailHref
        : `https://b2b.msisurfaces.com/B2BTiles/${detailHref}`;
      await page.goto(tileDetailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(1500);

      // Step 3: Click the Item ID postback link to get to pricing page
      // Find a link that matches or contains this SKU code
      const itemClicked = await page.evaluate((vendorSku) => {
        const links = document.querySelectorAll('a');
        // First try exact match
        for (const a of links) {
          const text = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          if (text === vendorSku && href.includes('__doPostBack')) {
            a.click();
            return text;
          }
        }
        // Then try partial match (SKU might be a prefix of the full item code)
        for (const a of links) {
          const text = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          if (href.includes('__doPostBack') && href.includes('ContentPlaceHolder') &&
              text.length > 5 && /^[A-Z0-9][A-Z0-9\-_]+$/.test(text) &&
              text.includes(vendorSku)) {
            a.click();
            return text;
          }
        }
        // Last resort: click first SKU-like postback link in the table
        for (const a of links) {
          const text = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          if (href.includes('__doPostBack') && href.includes('gvItemInfo') &&
              text.length > 5 && /^[A-Z0-9][A-Z0-9\-_]+$/.test(text)) {
            a.click();
            return text;
          }
        }
        return null;
      }, sku.vendor_sku);

      if (!itemClicked) continue;

      // Wait for postback to complete
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await delay(2000);

      // Step 4: Extract Price/Each and Price/Sqft from the item detail
      const priceData = await page.evaluate(() => {
        const text = document.body.innerText || '';

        // Match "Price/Each\t$X.XX" and "Price/Sqft\t$X.XX"
        const eachMatch = text.match(/Price\/Each\s*\$?([\d,]+\.?\d{0,2})/i);
        const sqftMatch = text.match(/Price\/Sqft\s*\$?([\d,]+\.?\d{0,2})/i);

        const priceEach = eachMatch ? parseFloat(eachMatch[1].replace(/,/g, '')) : null;
        const priceSqft = sqftMatch ? parseFloat(sqftMatch[1].replace(/,/g, '')) : null;

        // Also get packaging data while we're here
        const sqftPerPcMatch = text.match(/Sqft\s*Per\s*Pc\s*(\d+\.?\d*)/i);
        const sqftPerBoxMatch = text.match(/Sqft\s*Per\s*Box\s*(\d+\.?\d*)/i);
        const eachPerBoxMatch = text.match(/Each\s*in\s*Box\s*(\d+)/i);
        const weightMatch = text.match(/Approx\s*Weight\s*Per\s*Pc\s*([\d.]+)/i);

        if (!priceEach && !priceSqft) return null;

        return {
          priceEach,
          priceSqft,
          sqftPerPc: sqftPerPcMatch ? parseFloat(sqftPerPcMatch[1]) : null,
          sqftPerBox: sqftPerBoxMatch ? parseFloat(sqftPerBoxMatch[1]) : null,
          eachPerBox: eachPerBoxMatch ? parseInt(eachPerBoxMatch[1]) : null,
          weightPerPc: weightMatch ? parseFloat(weightMatch[1]) : null
        };
      });

      if (priceData) {
        found++;

        // Use Price/Sqft if available, otherwise Price/Each
        const cost = priceData.priceSqft || priceData.priceEach;
        const priceBasis = priceData.priceSqft ? 'per_sqft' : 'per_unit';

        try {
          await upsertPricing(pool, sku.id, { cost, retail_price: 0, price_basis: priceBasis });
          updated++;
        } catch (pricingErr) {
          errors++;
          if (errors <= 15) await appendLog(pool, job.id, `Error ${sku.vendor_sku}: ${pricingErr.message}`);
          continue;
        }

        if (found <= 10) {
          await appendLog(pool, job.id, `  ${sku.vendor_sku}: $${priceData.priceSqft}/sqft $${priceData.priceEach}/each (sqft/box: ${priceData.sqftPerBox})`);
        }
      }

      // Go back to search page
      await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
        waitUntil: 'networkidle2', timeout: 20000
      });
      await delay(500);

    } catch (err) {
      errors++;
      const errMsg = err.message || String(err);
      if (errors <= 25) await appendLog(pool, job.id, `Error ${sku.vendor_sku}: ${errMsg}`);

      // Track consecutive errors — if we get 10 in a row, session is dead
      consecutiveErrors++;

      if (consecutiveErrors >= 10) {
        // Session is likely dead — force re-login
        await appendLog(pool, job.id, `${consecutiveErrors} consecutive errors — forcing re-login...`);
        try {
          await page.goto('https://www.msisurfaces.com/customer-portal/', { waitUntil: 'networkidle2', timeout: 60000 });
          await portalLogin(page, pool, job);
          await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
            waitUntil: 'networkidle2', timeout: 60000
          });
          await delay(2000);
          consecutiveErrors = 0;
          await appendLog(pool, job.id, 'Re-login successful — resuming extraction.');
        } catch (reloginErr) {
          await appendLog(pool, job.id, `Re-login failed: ${reloginErr.message}. Aborting.`);
          break;
        }
      } else {
        // Try to recover by navigating back to search page
        try {
          const curUrl = page.url();
          if (curUrl.includes('login') || curUrl.includes('Login') || !curUrl.includes('b2b.msisurfaces.com')) {
            await portalLogin(page, pool, job);
            consecutiveErrors = 0;
          }
          await page.goto('https://b2b.msisurfaces.com/B2BTiles/NonSlabSelector.aspx', {
            waitUntil: 'networkidle2', timeout: 60000
          });
          await delay(1000);
        } catch {}
      }
    }

    if ((i + 1) % 25 === 0 || i === skus.length - 1) {
      await appendLog(pool, job.id, `Progress: ${i + 1}/${skus.length}, found ${found}, updated ${updated}, errors ${errors}`, {
        products_found: found, products_updated: updated
      });
    }
    await delay(config.delayMs);
  }

  await appendLog(pool, job.id, `Browser extraction complete. Found: ${found}, Updated: ${updated}, Errors: ${errors}`, {
    products_found: found, products_updated: updated
  });
}
