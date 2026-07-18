/**
 * Discover all distinct msi-asset-type values in the MSI AEM DAM.
 * Reuses the same B2B → DAM SSO login flow as msi-dam-images.js.
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
if (!user || !pass) { console.error('No credentials in .env'); process.exit(1); }

await page.evaluate((u, p) => {
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const emailInput = document.querySelector('input[type="email"]') || document.querySelector('input[type="text"]');
  const passInput = document.querySelector('input[type="password"]');
  nativeSet.call(emailInput, u);
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  nativeSet.call(passInput, p);
  passInput.dispatchEvent(new Event('input', { bubbles: true }));
  const signIn = Array.from(document.querySelectorAll('a')).find(a => /^sign\s*in$/i.test(a.textContent.trim()));
  if (signIn) signIn.click();
}, user, pass);

await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
await delay(3000);
console.log('Post-login:', page.url());

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
console.log('Clicked Digital Photography, waiting for DAM popup...');

const damPage = await popupPromise;
if (!damPage) { console.error('DAM popup never opened'); await browser.close(); process.exit(1); }

// Wait for DAM to fully load (SSO redirect settles)
for (let i = 0; i < 30; i++) {
  const u = damPage.url();
  if (u.includes('images.msisurfaces.com') && !u.includes('login') && !u.includes('Token')) break;
  await delay(2000);
}
await delay(5000);
console.log('DAM loaded:', damPage.url());

// ── Query for all assets (small sample) to find distinct types ──
console.log('\nQuerying DAM for ALL assets (first 500) to discover asset types...\n');

const params = new URLSearchParams({
  'type': 'dam:Asset',
  'path': '/content/dam',
  'p.limit': '500',
  'p.hits': 'selective',
  'p.properties': 'jcr:path jcr:content/metadata/msi-asset-type',
});

const result = await damPage.evaluate(async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) return { error: resp.status };
  return await resp.json();
}, `${QUERY_URL}?${params}`);

if (result.error) {
  console.error('Query failed:', result.error);
} else {
  console.log(`Total assets in DAM: ${result.total}`);
  console.log(`Sample size: ${(result.hits || []).length}`);

  // Collect distinct types
  const typeCounts = {};
  for (const hit of (result.hits || [])) {
    const assetType = hit['jcr:content/metadata/msi-asset-type'] || '(none)';
    // asset type can be a string or array
    const types = Array.isArray(assetType) ? assetType : [assetType];
    for (const t of types) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }

  console.log('\nDistinct msi-asset-type values (from sample):');
  const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)}  ${type}`);
  }
}

// Now query specifically for known tag paths to get exact counts
console.log('\n── Querying exact counts for known tag patterns ──\n');

const knownTags = [
  'msi-asset-info:asset-type/primary-web-image',
  'msi-asset-info:asset-type/isometric-product-photo',
  'msi-asset-info:asset-type/lifestyle-room-scene',
  'msi-asset-info:asset-type/lifestyle',
  'msi-asset-info:asset-type/room-scene',
  'msi-asset-info:asset-type/slab-photo',
  'msi-asset-info:asset-type/slab',
  'msi-asset-info:asset-type/closeup',
  'msi-asset-info:asset-type/close-up',
  'msi-asset-info:asset-type/vignette',
  'msi-asset-info:asset-type/full-slab',
  'msi-asset-info:asset-type/full-slab-photo',
  'msi-asset-info:asset-type/installed-photo',
  'msi-asset-info:asset-type/installed',
  'msi-asset-info:asset-type/secondary-web-image',
];

for (const tag of knownTags) {
  const tagParams = new URLSearchParams({
    'type': 'dam:Asset',
    'path': '/content/dam',
    '1_property': 'jcr:content/metadata/msi-asset-type',
    '1_property.value': tag,
    'p.limit': '0',  // just get total count
  });

  const tagResult = await damPage.evaluate(async (url) => {
    const resp = await fetch(url);
    if (!resp.ok) return { error: resp.status, total: 0 };
    const data = await resp.json();
    return { total: data.total || 0 };
  }, `${QUERY_URL}?${tagParams}`);

  if (tagResult.total > 0) {
    console.log(`  ${tagResult.total.toString().padStart(5)}  ${tag}`);
  }
}

// Also try querying by the raw metadata value instead of tag
console.log('\n── Querying by raw metadata values ──\n');

const rawTypes = [
  'lifestyle-room-scene', 'lifestyle', 'room-scene', 'room scene',
  'slab-photo', 'slab', 'full-slab', 'full slab',
  'closeup', 'close-up', 'vignette',
  'installed-photo', 'installed',
  'secondary-web-image', 'secondary',
  'primary-web-image', 'isometric-product-photo',
];

for (const val of rawTypes) {
  const rawParams = new URLSearchParams({
    'type': 'dam:Asset',
    'path': '/content/dam',
    '1_property': 'jcr:content/metadata/msi-asset-type',
    '1_property.value': val,
    'p.limit': '0',
  });

  const rawResult = await damPage.evaluate(async (url) => {
    const resp = await fetch(url);
    if (!resp.ok) return { total: 0 };
    const data = await resp.json();
    return { total: data.total || 0 };
  }, `${QUERY_URL}?${rawParams}`);

  if (rawResult.total > 0) {
    console.log(`  ${rawResult.total.toString().padStart(5)}  "${val}"`);
  }
}

// Get a sample of asset metadata to see all fields
console.log('\n── Sample asset metadata (first 3 assets with full metadata) ──\n');
const sampleParams = new URLSearchParams({
  'type': 'dam:Asset',
  'path': '/content/dam',
  'p.limit': '3',
  'p.hits': 'full',
});

const sampleResult = await damPage.evaluate(async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) return { error: resp.status };
  return await resp.json();
}, `${QUERY_URL}?${sampleParams}`);

if (!sampleResult.error) {
  for (const hit of (sampleResult.hits || [])) {
    console.log(JSON.stringify(hit, null, 2).substring(0, 2000));
    console.log('---');
  }
}

await browser.close();
