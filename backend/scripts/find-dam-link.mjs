import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--window-size=1400,1000', '--window-position=100,50'],
  defaultViewport: null,
});

const page = await browser.newPage();
const delay = ms => new Promise(r => setTimeout(r, ms));

// Login
console.log('Navigating to B2B login...');
await page.goto('https://b2b.msisurfaces.com/b2bcustomer/LoginControl.aspx', { waitUntil: 'networkidle2', timeout: 60000 });
await delay(3000);

const user = process.env.MSI_PORTAL_USERNAME;
const pass = process.env.MSI_PORTAL_PASSWORD;

await page.evaluate((u, p) => {
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const emailInput = document.querySelector('input[type="email"]') || document.querySelector('input[type="text"]');
  const passInput = document.querySelector('input[type="password"]');
  nativeSet.call(emailInput, u);
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  nativeSet.call(passInput, p);
  passInput.dispatchEvent(new Event('input', { bubbles: true }));
  const signIn = Array.from(document.querySelectorAll('a')).find(a => /sign\s*in/i.test(a.textContent.trim()));
  if (signIn) signIn.click();
}, user, pass);

await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
await delay(5000);

console.log('Post-login URL:', page.url());

// Scroll and dump EVERYTHING
for (let i = 0; i < 15; i++) {
  await page.evaluate(s => window.scrollTo(0, s * 400), i);
  await delay(500);
}

// Dump all clickable elements with their full text, href, alt, title, class
const elements = await page.evaluate(() => {
  const results = [];
  const els = document.querySelectorAll('a, button, [onclick], [role="link"], [role="button"]');
  for (const el of els) {
    const text = el.textContent.trim().substring(0, 80);
    const href = el.href || el.getAttribute('onclick') || '';
    const title = el.title || '';
    const alt = el.querySelector('img')?.alt || '';
    const imgSrc = el.querySelector('img')?.src || '';
    const cls = el.className.substring(0, 60);
    results.push({ text, href, title, alt, imgSrc: imgSrc.substring(0, 80), cls });
  }
  return results;
});

console.log(`\nFound ${elements.length} clickable elements:\n`);
for (const el of elements) {
  const parts = [];
  if (el.text) parts.push(`text="${el.text}"`);
  if (el.title) parts.push(`title="${el.title}"`);
  if (el.alt) parts.push(`alt="${el.alt}"`);
  if (el.href) parts.push(`href="${el.href}"`);
  if (el.imgSrc) parts.push(`img="${el.imgSrc}"`);
  if (el.cls) parts.push(`class="${el.cls}"`);
  console.log(`  ${parts.join(' | ')}`);
}

// Also look for anything with "photo" or "dam" or "image" in any attribute
console.log('\n=== Elements matching "photo/dam/image/digital" ===');
const photoEls = await page.evaluate(() => {
  const all = document.querySelectorAll('*');
  const matches = [];
  for (const el of all) {
    const text = (el.textContent || '').toLowerCase();
    const html = el.outerHTML.substring(0, 300).toLowerCase();
    if ((text.includes('photo') || text.includes('digital') || html.includes('dam') ||
         html.includes('photo') || html.includes('digital')) &&
        el.children.length < 5 && text.length < 200) {
      matches.push({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 80),
        href: el.href || '',
        html: el.outerHTML.substring(0, 200),
      });
    }
  }
  return matches.slice(0, 30);
});

for (const el of photoEls) {
  console.log(`  <${el.tag}> text="${el.text}" href="${el.href}"`);
  console.log(`    html: ${el.html}`);
}

await browser.close();
