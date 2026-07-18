import fs from 'fs';
import { appendLog, addJobError } from './base.js';

export const BASE_URL = 'https://www.bosphorusimports.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
 * Log into bosphorusimports.com dealer portal via plain fetch.
 *
 * The login form is an AJAX form (class "ajax-form") that POSTs
 * email + password + a CSRF token to /login-ajax and returns JSON
 * {status: true, redirect: ...} — no navigation ever happens, and the
 * reCAPTCHA script on the page is not wired into this form. So a
 * browser is unnecessary; two fetch calls complete the login.
 *
 * Flow:
 *   1. GET /login — collect session cookies + CSRF field name/value
 *      (field name is dynamic: capsule_capsule_csrf_token_<hash>)
 *   2. POST /login-ajax with form-encoded credentials + CSRF token
 *   3. Check JSON response status; merge any new cookies
 *   4. Verify dealer pricing is visible on /products
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

  await appendLog(pool, jobId, 'Logging into Bosphorus dealer portal...');

  // Step 1: fetch login page for session cookies + CSRF token
  const cookieJar = new Map();
  const loginPageResp = await fetch(`${BASE_URL}/login`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  collectCookies(loginPageResp, cookieJar);
  const loginHtml = await loginPageResp.text();

  const csrfMatch = loginHtml.match(/name="(capsule_[^"]*csrf[^"]*)"[^>]*value="([^"]*)"/);
  if (!csrfMatch) {
    throw new Error('Login failed: CSRF token not found on login page');
  }
  const [, csrfName, csrfValue] = csrfMatch;

  // Step 2: POST credentials to the AJAX login endpoint
  const body = new URLSearchParams({ [csrfName]: csrfValue, email, password });
  const loginResp = await fetch(`${BASE_URL}/login-ajax`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': jarToCookieString(cookieJar),
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE_URL}/login`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  });
  collectCookies(loginResp, cookieJar);

  let result = null;
  try { result = await loginResp.json(); } catch { /* non-JSON = failure below */ }

  if (!loginResp.ok || !result || result.status !== true) {
    const reason = result?.message || `HTTP ${loginResp.status}`;
    await addJobError(pool, jobId, `Bosphorus login rejected: ${reason}`);
    throw new Error(`Login failed: ${reason}`);
  }

  const cookieString = jarToCookieString(cookieJar);
  if (!cookieString) {
    throw new Error('Login failed: no cookies received');
  }

  // Step 3: verify dealer pricing is actually visible
  const verifyResp = await bosphorusFetch('/products?page=1', cookieString);
  const verifyHtml = await verifyResp.text();
  if (verifyHtml.includes('Log in for pricing')) {
    await appendLog(pool, jobId, 'Warning: login accepted but prices still hidden — pricing may not be captured');
  } else {
    await appendLog(pool, jobId, 'Login verified — pricing visible');
  }

  await appendLog(pool, jobId, `Login successful — ${cookieJar.size} cookies`);
  return cookieString;
}

/**
 * Merge Set-Cookie headers from a fetch Response into a name→value map.
 */
function collectCookies(resp, jar) {
  const setCookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function jarToCookieString(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
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

