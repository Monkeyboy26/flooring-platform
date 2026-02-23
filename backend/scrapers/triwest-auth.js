import fs from 'fs';
import path from 'path';
import { launchBrowser, delay, appendLog, addJobError } from './base.js';

export const PORTAL_BASE = 'https://tri400.triwestltd.com/danciko/d24';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

/**
 * Authenticated fetch helper for Tri-West DNav portal.
 * Prepends PORTAL_BASE and includes session cookies + User-Agent.
 * Auto-detects redirect back to login (session expiry) and throws.
 */
export async function triwestFetch(urlPath, cookies, options = {}) {
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${PORTAL_BASE}${urlPath}`;
  const resp = await fetch(fullUrl, {
    ...options,
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': cookies,
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });

  // DNav redirects to login page on session expiry
  if (resp.status === 302 || resp.status === 301) {
    const location = resp.headers.get('location') || '';
    if (location.includes('login') || location.includes('Login') || location.includes('signin')) {
      throw new Error('Session expired — redirected to login');
    }
  }

  return resp;
}

/**
 * Log into Tri-West DNav (Décor 24) dealer portal via Puppeteer.
 *
 * DNav uses jQuery-based forms with possible JS-generated hidden fields.
 * Puppeteer with a real Chromium instance handles these correctly.
 *
 * Flow:
 *   1. Launch Puppeteer browser
 *   2. Navigate to DNav portal login
 *   3. Fill username + password
 *   4. Submit form
 *   5. Wait for redirect (successful login redirects to dashboard)
 *   6. Extract all cookies from the page
 *   7. Close browser
 *   8. Return cookie string for use with fetch()
 *
 * Requires TRIWEST_USERNAME and TRIWEST_PASSWORD environment variables.
 *
 * @param {Pool} pool - DB pool for logging
 * @param {number} jobId - Scrape job ID for logging
 * @returns {string} Combined cookie string
 */
export async function triwestLogin(pool, jobId) {
  const username = process.env.TRIWEST_USERNAME;
  const password = process.env.TRIWEST_PASSWORD;

  if (!username || !password) {
    await addJobError(pool, jobId, 'TRIWEST_USERNAME and TRIWEST_PASSWORD environment variables are required');
    throw new Error('Missing Tri-West credentials — set TRIWEST_USERNAME and TRIWEST_PASSWORD in .env');
  }

  await appendLog(pool, jobId, 'Launching browser for Tri-West DNav login...');
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to DNav portal
    await appendLog(pool, jobId, `Navigating to DNav portal: ${PORTAL_BASE}`);
    await page.goto(PORTAL_BASE, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await delay(2000);

    // Screenshot the login page for debugging
    await screenshot(page, 'triwest-login-page');
    await appendLog(pool, jobId, `Login page URL: ${page.url()}`);

    // Log the page structure to help understand the form
    const pageInfo = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form'));
      const inputs = Array.from(document.querySelectorAll('input'));
      return {
        title: document.title,
        forms: forms.map(f => ({
          action: f.action,
          method: f.method,
          id: f.id,
          inputs: Array.from(f.querySelectorAll('input')).map(i => ({
            type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
          }))
        })),
        allInputs: inputs.map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
        })),
        bodyTextSnippet: document.body.innerText.slice(0, 500)
      };
    });
    await appendLog(pool, jobId, `Page info: ${JSON.stringify(pageInfo, null, 2)}`);

    // Find and fill username field
    const usernameSelector = await findSelector(page, [
      'input[name="username"]',
      'input[name="userid"]',
      'input[name="user"]',
      'input[name="login"]',
      'input[name*="user"]',
      'input[name*="User"]',
      'input[type="text"]:first-of-type',
      '#username',
      '#userid',
      '#user',
    ]);

    if (!usernameSelector) {
      await screenshot(page, 'triwest-login-no-username');
      throw new Error('Login failed: could not find username input field');
    }

    await page.click(usernameSelector, { clickCount: 3 });
    await page.type(usernameSelector, username, { delay: 50 });

    // Find and fill password field
    const passwordSelector = await findSelector(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[name="passwd"]',
      'input[name*="pass"]',
      '#password',
    ]);

    if (!passwordSelector) {
      await screenshot(page, 'triwest-login-no-password');
      throw new Error('Login failed: could not find password input field');
    }

    await page.click(passwordSelector, { clickCount: 3 });
    await page.type(passwordSelector, password, { delay: 50 });

    await appendLog(pool, jobId, 'Credentials filled, submitting...');
    await delay(1000);

    // Submit form
    let submitted = false;

    const submitSelector = await findSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'input[type="button"][value*="Login"]',
      'input[type="button"][value*="Sign"]',
      'button.btn-primary',
      '#loginButton',
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
          const text = (el.textContent || el.value || '').trim().toLowerCase();
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

    // Verify login success
    const currentUrl = page.url();
    await appendLog(pool, jobId, `Post-login URL: ${currentUrl}`);
    await screenshot(page, 'triwest-post-login');

    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    const lowerText = pageText.toLowerCase();

    const loginFailed = (
      lowerText.includes('invalid') || lowerText.includes('incorrect') ||
      lowerText.includes('try again') || lowerText.includes('wrong password') ||
      lowerText.includes('authentication failed')
    ) && (
      currentUrl.includes('login') || currentUrl.includes('Login') || currentUrl.includes('signin')
    );

    if (loginFailed) {
      await screenshot(page, 'triwest-login-failed');
      throw new Error('Login failed: invalid credentials or blocked');
    }

    // Extract cookies from the browser session
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (!cookieString) {
      throw new Error('Login failed: no cookies received');
    }

    await appendLog(pool, jobId, `Login successful — ${cookies.length} cookies extracted`);
    return cookieString;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Alternative: import cookies from an external source (browser export, manual login).
 * Use this if the portal blocks automated login.
 *
 * Set TRIWEST_COOKIES env var to a JSON file path or raw cookie string.
 */
export async function triwestLoginFromCookies(pool, jobId) {
  const cookieSource = process.env.TRIWEST_COOKIES;

  if (!cookieSource) {
    throw new Error('TRIWEST_COOKIES environment variable not set. Provide a cookie file path or raw cookie string.');
  }

  let cookieString;

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
    cookieString = cookieSource;
  }

  await appendLog(pool, jobId, 'Using imported cookies for Tri-West session');
  return cookieString;
}

/**
 * Take a screenshot for debugging.
 */
export async function screenshot(page, label) {
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
