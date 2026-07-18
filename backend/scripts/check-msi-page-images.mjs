import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

// Try a popular MSI porcelain product
const url = 'https://www.msisurfaces.com/porcelain-tile/arabescato-carrara-polished-porcelain/';
console.log('Navigating to:', url);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
console.log('Page title:', await page.title());
console.log('URL:', page.url());
const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || 'NO BODY');
console.log('Body preview:', bodyText.slice(0, 300));

// Wait for content to load
await page.waitForSelector('h1', { timeout: 15000 }).catch(() => console.log('No h1 found'));
await new Promise(r => setTimeout(r, 3000));

// Get total image count unfiltered
const totalImgs = await page.evaluate(() => document.querySelectorAll('img').length);
console.log('Total <img> tags:', totalImgs);

// Get ALL image src values without filtering
const allSrcs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('img')).map(i => i.src || i.getAttribute('data-src') || '').filter(Boolean)
);
console.log('Image sources:');
for (const src of allSrcs.slice(0, 20)) console.log('  ' + src.slice(0, 150));

// Expand accordions/tabs
await page.evaluate(() => {
  document.querySelectorAll('.accordion-header, [data-toggle="collapse"], button[aria-expanded="false"]')
    .forEach(t => { try { t.click(); } catch {} });
  document.querySelectorAll('.collapse').forEach(el => {
    el.classList.add('in', 'show');
    el.style.display = '';
    el.style.height = 'auto';
  });
  document.querySelectorAll('.tab-pane').forEach(el => {
    el.classList.add('active', 'in', 'show');
    el.style.display = '';
  });
});
await new Promise(r => setTimeout(r, 2000));

const allImgs = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  return imgs.map(img => ({
    src: img.src || '',
    dataSrc: img.getAttribute('data-src') || '',
    alt: (img.alt || '').slice(0, 80),
    parentClasses: (img.parentElement?.className || '').slice(0, 100),
  })).filter(i => (i.src || i.dataSrc) && !i.src.includes('.svg') && !i.src.startsWith('data:'));
});

// Group by domain
const domains = {};
for (const img of allImgs) {
  const url = img.src || img.dataSrc;
  try {
    const domain = new URL(url).hostname;
    if (!domains[domain]) domains[domain] = [];
    domains[domain].push({ url: url.slice(0, 150), alt: img.alt, parentClasses: img.parentClasses });
  } catch {}
}

for (const [domain, imgs] of Object.entries(domains)) {
  console.log(`\n=== ${domain} (${imgs.length} images) ===`);
  for (const img of imgs.slice(0, 8)) {
    console.log(`  ${img.url}`);
    if (img.alt) console.log(`    alt: ${img.alt}`);
  }
  if (imgs.length > 8) console.log(`  ... and ${imgs.length - 8} more`);
}

// Also check for roomscene specific patterns
console.log('\n=== Images containing "room" or "scene" or "lifestyle" ===');
for (const img of allImgs) {
  const url = (img.src + ' ' + img.dataSrc).toLowerCase();
  if (url.includes('room') || url.includes('scene') || url.includes('lifestyle') || url.includes('installed')) {
    console.log(`  ${img.src || img.dataSrc}`);
  }
}

await browser.close();
