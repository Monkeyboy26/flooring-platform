/**
 * Authentication for the Galleher Duffy daily scraper.
 *
 * galleherduffy.com is Magento with reCAPTCHA on the login page, so a headless
 * credential login is blocked. Instead we keep a PERSISTENT logged-in Chrome
 * profile (userDataDir): a human logs in ONCE (solving the captcha, "Remember me")
 * via scripts/gall-login.js, and every daily run reuses that profile. Magento's
 * persistent session is refreshed on each visit, so the profile stays authenticated
 * for a long time. When it eventually lapses, the scrape logs an error + alert and a
 * human re-runs the one-time login.
 *
 * This module opens the profile headlessly, verifies dealer pricing is visible, and
 * returns the session cookies as a string for fast fetch-based scraping. A
 * GALLEHER_COOKIES env var (raw "k=v; k=v" string) overrides the profile for
 * testing / emergency fallback.
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendLog, addJobError } from './base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_URL = 'https://www.galleherduffy.com';
export const PROFILE_DIR = process.env.GALLEHER_PROFILE_DIR || path.join(__dirname, '..', 'data', 'gall-profile');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// A dealer-priced plank tile shows "$N.NN /Square Foot"; the guest view hides prices.
const PRICE_RE = /\$[0-9]+\.[0-9]{2}\s*\/\s*(Square Foot|Piece)/;
const VERIFY_URL = `${BASE_URL}/catalogsearch/result/?q=Monarch+Plank&product_list_limit=12`;

export function launchProfileBrowser() {
  return puppeteer.launch({
    headless: 'new',
    userDataDir: PROFILE_DIR,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

/**
 * Open the persistent profile and return an authenticated { browser, page }. Dealer
 * price + Company Stock are injected client-side, so the scraper navigates and parses
 * the rendered DOM (not a raw fetch). Verifies pricing is visible; throws if the
 * session has lapsed (→ job fails + alert → human re-runs scripts/gall-login.js).
 */
function parseCookieString(str) {
  return str.split(';').map((p) => p.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.galleherduffy.com', path: '/' };
  }).filter((c) => c.name);
}

export async function openGalleher(pool, jobId) {
  // Auth precedence: GALLEHER_COOKIES (a dealer session cookie string captured from
  // the browser — works in the container's system Chromium, matches BOSPHORUS_COOKIES)
  // else the persistent profile (needs an in-environment one-time login).
  const cookieStr = process.env.GALLEHER_COOKIES;
  await appendLog(pool, jobId, cookieStr ? 'Auth via GALLEHER_COOKIES' : `Auth via persistent profile (${PROFILE_DIR})`);
  const browser = cookieStr
    ? await puppeteer.launch({ headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
    : await launchProfileBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    if (cookieStr) await page.setCookie(...parseCookieString(cookieStr));
    await page.goto(VERIFY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('li.product-item').length > 0, { timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 8000)); // let per-tile dealer price/stock inject
    const html = await page.content();
    if (!PRICE_RE.test(html)) {
      throw new Error('Galleher profile is not logged in (dealer pricing not visible). Re-run scripts/gall-login.js to refresh the session.');
    }
    await appendLog(pool, jobId, 'Profile authenticated — dealer pricing visible');
    return { browser, page };
  } catch (e) {
    await addJobError(pool, jobId, `Galleher auth failed: ${e.message}`);
    await browser.close().catch(() => {});
    throw e;
  }
}

/**
 * Return the dealer session cookie string. Uses GALLEHER_COOKIES if set, else opens
 * the persistent Chrome profile, verifies pricing is visible, and extracts cookies.
 * Throws (→ job fails + alert) if the profile is not logged in.
 */
export async function galleherCookies(pool, jobId) {
  if (process.env.GALLEHER_COOKIES) {
    await appendLog(pool, jobId, 'Using GALLEHER_COOKIES override');
    return process.env.GALLEHER_COOKIES.trim();
  }

  await appendLog(pool, jobId, `Opening persistent Galleher profile (${PROFILE_DIR})...`);
  let browser;
  try {
    browser = await launchProfileBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(VERIFY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Magento renders prices after the layered-nav/JS; give it a moment.
    await new Promise((r) => setTimeout(r, 8000));
    const html = await page.content();
    if (!PRICE_RE.test(html)) {
      throw new Error('Galleher profile is not logged in (dealer pricing not visible). Re-run scripts/gall-login.js to refresh the session.');
    }
    const cookies = await page.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await appendLog(pool, jobId, `Profile authenticated — ${cookies.length} cookies, pricing visible`);
    return cookieStr;
  } catch (e) {
    await addJobError(pool, jobId, `Galleher auth failed: ${e.message}`);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
