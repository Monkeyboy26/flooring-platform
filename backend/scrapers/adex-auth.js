import fs from 'fs';
import path from 'path';
import { launchBrowser, delay, appendLog, addJobError } from './base.js';

export const BASE_URL = 'https://portal.adexusawest.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

/**
 * Authenticated fetch helper for ADEX USA dealer portal.
 * Prepends BASE_URL and includes session cookies + User-Agent.
 */
export async function adexFetch(url, cookies, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const resp = await fetch(fullUrl, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': cookies,
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });
  return resp;
}

/**
 * Log into ADEX USA dealer portal via Puppeteer.
 *
 * The portal uses WordPress/WooCommerce with Cloudflare Turnstile.
 * Puppeteer with a real Chromium instance can sometimes pass Turnstile
 * automatically. If it blocks, use the cookie fallback (adexLoginFromCookies).
 *
 * Flow:
 *   1. Launch Puppeteer browser
 *   2. Navigate to /my-account/
 *   3. Fill username + password (WooCommerce login form)
 *   4. Wait for Turnstile to resolve (up to 15s)
 *   5. Submit form
 *   6. Extract cookies from browser session
 *   7. Verify by fetching /shop/ and checking for product content
 *
 * Requires ADEX_USERNAME and ADEX_PASSWORD environment variables.
 */
export async function adexLogin(pool, jobId) {
  const username = process.env.ADEX_USERNAME;
  const password = process.env.ADEX_PASSWORD;

  if (!username || !password) {
    await addJobError(pool, jobId, 'ADEX_USERNAME and ADEX_PASSWORD environment variables are required');
    throw new Error('Missing ADEX credentials — set ADEX_USERNAME and ADEX_PASSWORD in .env');
  }

  await appendLog(pool, jobId, 'Launching browser for ADEX portal login...');
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to WooCommerce login page
    await appendLog(pool, jobId, 'Navigating to /my-account/ login page...');
    await page.goto(`${BASE_URL}/my-account/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await delay(2000);

    // Fill WooCommerce login form
    const usernameSelector = await findSelector(page, [
      'input[name="username"]',
      '#username',
      'input[name="log"]',
      'input[type="email"]',
    ]);

    if (!usernameSelector) {
      await screenshot(page, 'adex-login-no-username');
      throw new Error('Login failed: could not find username input field');
    }

    await page.click(usernameSelector, { clickCount: 3 });
    await page.type(usernameSelector, username, { delay: 50 });

    const passwordSelector = await findSelector(page, [
      'input[name="password"]',
      '#password',
      'input[name="pwd"]',
      'input[type="password"]',
    ]);

    if (!passwordSelector) {
      await screenshot(page, 'adex-login-no-password');
      throw new Error('Login failed: could not find password input field');
    }

    await page.click(passwordSelector, { clickCount: 3 });
    await page.type(passwordSelector, password, { delay: 50 });

    await appendLog(pool, jobId, 'Credentials filled, waiting for Turnstile...');

    // Wait for Cloudflare Turnstile to resolve
    await delay(5000);

    // Check if Turnstile iframe is present and wait longer if needed
    const hasTurnstile = await page.evaluate(() => {
      return !!document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
    }).catch(() => false);

    if (hasTurnstile) {
      await appendLog(pool, jobId, 'Turnstile challenge detected — waiting up to 15s for resolution...');
      await delay(10000);
    }

    // Submit form
    await appendLog(pool, jobId, 'Submitting login form...');
    let submitted = false;

    const submitSelector = await findSelector(page, [
      'button[type="submit"]',
      'button[name="login"]',
      'input[type="submit"]',
      '.woocommerce-form-login__submit',
    ]);

    if (submitSelector) {
      await Promise.all([
        page.click(submitSelector),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      ]);
      submitted = true;
    }

    // Fallback: find login button by text
    if (!submitted) {
      const btnClicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const btn = elements.find(el => {
          const text = (el.textContent || el.value || '').trim().toLowerCase();
          return text === 'log in' || text === 'login' || text === 'sign in';
        });
        if (btn) { btn.click(); return true; }
        const form = document.querySelector('form.woocommerce-form-login, form.login');
        if (form) { form.submit(); return true; }
        return false;
      });

      if (btnClicked) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        submitted = true;
      }
    }

    // Last resort: press Enter
    if (!submitted) {
      await page.focus(passwordSelector);
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    await delay(3000);

    // Verify login success
    const currentUrl = page.url();
    await appendLog(pool, jobId, `Post-login URL: ${currentUrl}`);

    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    const lowerText = pageText.toLowerCase();

    // Always take a debug screenshot
    await screenshot(page, 'adex-login-result');

    await appendLog(pool, jobId, `Page text preview: ${pageText.slice(0, 300)}`);

    // WooCommerce-specific failure indicators (narrow checks to avoid false positives)
    const hasLoginForm = lowerText.includes('username or email') || lowerText.includes('remember me');
    const hasFailureMsg = lowerText.includes('invalid username') || lowerText.includes('incorrect password') ||
                          lowerText.includes('unknown email') || lowerText.includes('wrong password');
    const hasSuccessIndicators = lowerText.includes('dashboard') || lowerText.includes('orders') ||
                                 lowerText.includes('logout') || lowerText.includes('log out') ||
                                 lowerText.includes('my account') || lowerText.includes('hello ');

    const loginFailed = (hasLoginForm || hasFailureMsg) && !hasSuccessIndicators;

    if (loginFailed) {
      await appendLog(pool, jobId, `Login appears to have failed. hasLoginForm=${hasLoginForm}, hasFailureMsg=${hasFailureMsg}`);
      throw new Error('Login failed: invalid credentials or Turnstile block');
    }

    // Extract cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (!cookieString) {
      throw new Error('Login failed: no cookies received');
    }

    // Verify session by fetching /shop/
    const verifyResp = await adexFetch('/shop/', cookieString);
    const verifyHtml = await verifyResp.text();
    const isLoggedIn = verifyHtml.includes('product') || verifyHtml.includes('woocommerce') ||
                       verifyHtml.includes('Logout') || verifyHtml.includes('logout');

    if (!isLoggedIn) {
      await appendLog(pool, jobId, 'Warning: login verification uncertain — shop page may not be accessible');
    } else {
      await appendLog(pool, jobId, 'Login verified — shop page accessible');
    }

    await appendLog(pool, jobId, `Login successful — ${cookies.length} cookies extracted`);
    return cookieString;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Import cookies from an external source (browser export, manual login).
 * Use this if Cloudflare Turnstile blocks automated login.
 *
 * Set ADEX_COOKIES env var to a JSON file path or raw cookie string.
 */
export async function adexLoginFromCookies(pool, jobId) {
  const cookieSource = process.env.ADEX_COOKIES;

  if (!cookieSource) {
    throw new Error('ADEX_COOKIES environment variable not set. Provide a cookie file path or raw cookie string.');
  }

  let cookieString;

  // Check if it's a file path
  if (cookieSource.endsWith('.json') || cookieSource.startsWith('/')) {
    try {
      const raw = fs.readFileSync(cookieSource, 'utf-8');
      const cookies = JSON.parse(raw);
      if (Array.isArray(cookies)) {
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      } else {
        cookieString = raw.trim();
      }
    } catch (err) {
      throw new Error(`Failed to read cookie file ${cookieSource}: ${err.message}`);
    }
  } else {
    // Raw cookie string
    cookieString = cookieSource;
  }

  await appendLog(pool, jobId, 'Using imported cookies for ADEX session');

  // Verify cookies by fetching /shop/
  const resp = await adexFetch('/shop/', cookieString);
  const html = await resp.text();
  if (!html.includes('product') && !html.includes('woocommerce')) {
    await appendLog(pool, jobId, 'Warning: imported cookies may be expired — shop page not accessible');
  } else {
    await appendLog(pool, jobId, 'Imported cookies verified — session active');
  }

  return cookieString;
}

/**
 * Take a screenshot for debugging.
 */
async function screenshot(page, label) {
  try {
    const timestamp = Date.now();
    const filePath = path.join(UPLOADS_BASE, `${label}-${timestamp}.png`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Find the first matching selector from a list of candidates.
 */
async function findSelector(context, selectors) {
  for (const sel of selectors) {
    const el = await context.$(sel).catch(() => null);
    if (el) return sel;
  }
  return null;
}
