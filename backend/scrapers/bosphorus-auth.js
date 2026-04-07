import fs from 'fs';
import path from 'path';
import { launchBrowser, delay, appendLog, addJobError } from './base.js';

export const BASE_URL = 'https://www.bosphorusimports.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

/**
 * Authenticated fetch helper for Bosphorus Imports.
 * Prepends BASE_URL and includes session cookies + User-Agent.
 */
export async function bosphorusFetch(url, cookies, options = {}) {
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
 * Log into bosphorusimports.com dealer portal via Puppeteer.
 *
 * The login form uses reCAPTCHA, so we use a real browser session.
 * Puppeteer with a real Chromium instance typically passes invisible reCAPTCHA
 * or reCAPTCHA v3 without manual intervention.
 *
 * Flow:
 *   1. Launch Puppeteer browser
 *   2. Navigate to /login
 *   3. Fill email + password
 *   4. Submit form
 *   5. Wait for redirect (successful login redirects away from /login)
 *   6. Extract all cookies from the page
 *   7. Close browser
 *   8. Return cookie string for use with fetch()
 *
 * Requires BOSPHORUS_USERNAME and BOSPHORUS_PASSWORD environment variables.
 *
 * @param {Pool} pool - DB pool for logging
 * @param {number} jobId - Scrape job ID for logging
 * @returns {string} Combined cookie string
 */
export async function bosphorusLogin(pool, jobId) {
  const email = process.env.BOSPHORUS_USERNAME;
  const password = process.env.BOSPHORUS_PASSWORD;

  if (!email || !password) {
    await addJobError(pool, jobId, 'BOSPHORUS_USERNAME and BOSPHORUS_PASSWORD environment variables are required');
    throw new Error('Missing Bosphorus credentials — set BOSPHORUS_USERNAME and BOSPHORUS_PASSWORD in .env');
  }

  await appendLog(pool, jobId, 'Launching browser for Bosphorus login...');
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to login page
    await appendLog(pool, jobId, 'Navigating to login page...');
    await page.goto(`${BASE_URL}/login`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await delay(2000);

    // Find and fill email field
    const emailSelector = await findSelector(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[name*="email"]',
      'input[name*="user"]',
      '#email',
    ]);

    if (!emailSelector) {
      await screenshot(page, 'bosphorus-login-no-email');
      throw new Error('Login failed: could not find email input field');
    }

    await page.click(emailSelector, { clickCount: 3 });
    await page.type(emailSelector, email, { delay: 50 });

    // Find and fill password field
    const passwordSelector = await findSelector(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[name*="pass"]',
      '#password',
    ]);

    if (!passwordSelector) {
      await screenshot(page, 'bosphorus-login-no-password');
      throw new Error('Login failed: could not find password input field');
    }

    await page.click(passwordSelector, { clickCount: 3 });
    await page.type(passwordSelector, password, { delay: 50 });

    await appendLog(pool, jobId, 'Credentials filled, submitting...');

    // Wait a moment for reCAPTCHA invisible check to complete
    await delay(1000);

    // Submit form
    let submitted = false;

    const submitSelector = await findSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.btn-primary',
      '#login-btn',
    ]);

    if (submitSelector) {
      await Promise.all([
        page.click(submitSelector),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      ]);
      submitted = true;
    }

    // Fallback: find login/sign-in button by text
    if (!submitted) {
      const signInClicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
        const btn = elements.find(el => {
          const text = el.textContent.trim().toLowerCase();
          return text === 'sign in' || text === 'login' || text === 'log in' || text === 'submit';
        });
        if (btn) { btn.click(); return true; }
        const form = document.querySelector('form');
        if (form) { form.submit(); return true; }
        return false;
      });

      if (signInClicked) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        submitted = true;
      }
    }

    // Last resort: press Enter in password field
    if (!submitted) {
      await page.focus(passwordSelector);
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    await delay(3000);

    // Check for reCAPTCHA challenge (visible checkbox)
    const hasCaptchaChallenge = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[title*="recaptcha"]');
      return !!iframe;
    }).catch(() => false);

    if (hasCaptchaChallenge) {
      await appendLog(pool, jobId, 'reCAPTCHA challenge detected — waiting up to 60s for automatic resolution...');
      // Wait for reCAPTCHA to auto-resolve (invisible v2/v3 usually resolves on its own)
      await delay(10000);

      // Try submitting again after reCAPTCHA resolve
      if (submitSelector) {
        await page.click(submitSelector).catch(() => {});
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      }
      await delay(3000);
    }

    // Verify login success
    const currentUrl = page.url();
    await appendLog(pool, jobId, `Post-login URL: ${currentUrl}`);

    const stillOnLogin = currentUrl.includes('/login');
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    const lowerText = pageText.toLowerCase();

    const loginFailed = (
      stillOnLogin &&
      (lowerText.includes('invalid') || lowerText.includes('incorrect') ||
       lowerText.includes('try again') || lowerText.includes('wrong'))
    );

    if (loginFailed) {
      await screenshot(page, 'bosphorus-login-failed');
      throw new Error('Login failed: invalid credentials or CAPTCHA block');
    }

    // Extract cookies from the browser session
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (!cookieString) {
      throw new Error('Login failed: no cookies received');
    }

    // Verify by fetching a product page and checking for pricing
    const verifyResp = await bosphorusFetch('/products?page=1', cookieString);
    const verifyHtml = await verifyResp.text();
    const isLoggedIn = !verifyHtml.includes('Log in for pricing') ||
                       verifyHtml.includes('Logout') ||
                       verifyHtml.includes('logout') ||
                       verifyHtml.includes('My Account');

    if (!isLoggedIn) {
      await appendLog(pool, jobId, 'Warning: login verification uncertain — prices may not be visible');
    } else {
      await appendLog(pool, jobId, 'Login verified — pricing visible');
    }

    await appendLog(pool, jobId, `Login successful — ${cookies.length} cookies extracted`);
    return cookieString;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Alternative: import cookies from an external source (browser export, manual login).
 * Use this if reCAPTCHA blocks automated login.
 *
 * Set BOSPHORUS_COOKIES env var to a JSON file path or raw cookie string.
 */
export async function bosphorusLoginFromCookies(pool, jobId) {
  const cookieSource = process.env.BOSPHORUS_COOKIES;

  if (!cookieSource) {
    throw new Error('BOSPHORUS_COOKIES environment variable not set. Provide a cookie file path or raw cookie string.');
  }

  let cookieString;

  // Check if it's a file path
  if (cookieSource.endsWith('.json') || cookieSource.startsWith('/')) {
    try {
      const raw = fs.readFileSync(cookieSource, 'utf-8');
      const cookies = JSON.parse(raw);
      // Support Puppeteer-style [{name, value}] or Netscape-style cookies
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

  await appendLog(pool, jobId, 'Using imported cookies for Bosphorus session');

  // Verify cookies
  const resp = await bosphorusFetch('/products?page=1', cookieString);
  const html = await resp.text();
  if (html.includes('Log in for pricing')) {
    await appendLog(pool, jobId, 'Warning: imported cookies may be expired — prices not visible');
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
