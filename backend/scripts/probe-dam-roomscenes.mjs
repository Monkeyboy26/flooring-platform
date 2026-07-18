/**
 * Probe DAM room-scene metadata to see if they're linked to products/SKUs.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const delay = ms => new Promise(r => setTimeout(r, ms));
const DAM_HOST = 'https://images.msisurfaces.com';
const QUERY_URL = `${DAM_HOST}/bin/querybuilder.json`;

const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--window-size=1200,900', '--window-position=100,50'],
  defaultViewport: null,
});

const page = await browser.newPage();

// ── B2B Login ──
console.log('Logging into B2B portal...');
await page.goto('https://b2b.msisurfaces.com/b2bcustomer/LoginControl.aspx', {
  waitUntil: 'networkidle2', timeout: 60000
});
await delay(2000);

const user = process.env.MSI_PORTAL_USERNAME;
const pass = process.env.MSI_PORTAL_PASSWORD;

await page.evaluate((u, p) => {
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const emailInput = document.querySelector('input[type="email"]') || document.querySelector('input[type="text"]');
  const passInput = document.querySelector('input[type="password"]');
  nativeSet.call(emailInput, u); emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  nativeSet.call(passInput, p); passInput.dispatchEvent(new Event('input', { bubbles: true }));
  const signIn = Array.from(document.querySelectorAll('a')).find(a => /^sign\s*in$/i.test(a.textContent.trim()));
  if (signIn) signIn.click();
}, user, pass);

await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
await delay(3000);

// ── Click Digital Photography ──
for (let i = 0; i < 10; i++) {
  await page.evaluate(s => window.scrollTo(0, s * 400), i);
  await delay(500);
}
await delay(2000);

const popupPromise = new Promise(resolve => {
  page.browser().on('targetcreated', async (target) => {
    if (target.type() === 'page') resolve(await target.page());
  });
  setTimeout(() => resolve(null), 30000);
});

const tileEl = await page.evaluateHandle(() => {
  const all = Array.from(document.querySelectorAll('a, div, span'));
  for (const el of all) {
    const text = (el.textContent || '').trim().toLowerCase();
    if ((text.includes('digital photography') || text.includes('access digital')) && text.length < 100) {
      const clickable = el.closest('a') || el;
      clickable.scrollIntoView({ block: 'center' });
      return clickable;
    }
  }
  return null;
});
if (tileEl) await tileEl.click();
console.log('Waiting for DAM popup...');

const damPage = await popupPromise;
if (!damPage) { console.error('No DAM popup'); await browser.close(); process.exit(1); }

for (let i = 0; i < 30; i++) {
  const u = damPage.url();
  if (u.includes('images.msisurfaces.com') && !u.includes('login') && !u.includes('Token')) break;
  await delay(2000);
}
await delay(5000);
console.log('DAM loaded:', damPage.url());

// ── Query room-scene assets with FULL metadata ──
console.log('\n=== Fetching 10 room-scene assets with full metadata ===\n');

const params = new URLSearchParams({
  'type': 'dam:Asset',
  'path': '/content/dam',
  '1_property': 'jcr:content/metadata/msi-asset-type',
  '1_property.value': 'msi-asset-info:asset-type/room-scene',
  'p.limit': '10',
  'p.hits': 'selective',
  'p.properties': 'jcr:path jcr:content/metadata/msi-asset-type jcr:content/metadata/dc:title jcr:content/metadata/dc:description jcr:content/metadata/msi-sku jcr:content/metadata/msi-product-name jcr:content/metadata/msi-product-sku jcr:content/metadata/msi-related-products jcr:content/metadata/msi-collection jcr:content/metadata/msi-color jcr:content/metadata/dam:scene7Name jcr:content/metadata/cq:tags',
});

const result = await damPage.evaluate(async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) return { error: resp.status };
  return await resp.json();
}, `${QUERY_URL}?${params}`);

if (result.error) {
  console.error('Query failed:', result.error);
} else {
  console.log(`Total room-scene assets: ${result.total}`);
  for (const hit of (result.hits || [])) {
    console.log('\n---');
    console.log(JSON.stringify(hit, null, 2));
  }
}

// Also try with p.hits=full for first 3
console.log('\n\n=== 3 room-scene assets with ALL properties (p.hits=full) ===\n');

const params2 = new URLSearchParams({
  'type': 'dam:Asset',
  'path': '/content/dam',
  '1_property': 'jcr:content/metadata/msi-asset-type',
  '1_property.value': 'msi-asset-info:asset-type/room-scene',
  'p.limit': '3',
  'p.hits': 'full',
  'p.nodedepth': '3',
});

const result2 = await damPage.evaluate(async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) return { error: resp.status };
  return await resp.json();
}, `${QUERY_URL}?${params2}`);

if (!result2.error) {
  for (const hit of (result2.hits || [])) {
    console.log('\n--- FULL ---');
    // Print all keys that contain interesting metadata
    const str = JSON.stringify(hit, null, 2);
    console.log(str.substring(0, 3000));
  }
}

// Try fetching the metadata node directly for the first room scene
if (result.hits && result.hits.length > 0) {
  const firstPath = result.hits[0]['jcr:path'];
  console.log(`\n\n=== Direct metadata fetch for: ${firstPath} ===\n`);

  const metaUrl = `${DAM_HOST}${firstPath}/jcr:content/metadata.json`;
  const meta = await damPage.evaluate(async (url) => {
    const resp = await fetch(url);
    if (!resp.ok) return { error: resp.status };
    return await resp.json();
  }, metaUrl);

  console.log(JSON.stringify(meta, null, 2));
}

await browser.close();
