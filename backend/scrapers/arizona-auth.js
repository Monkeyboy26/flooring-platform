import { appendLog, addJobError } from './base.js';

export const BASE_URL = 'https://www.arizonatile.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch helper that prepends BASE_URL and includes session cookies + User-Agent.
 */
export async function arizonaFetch(url, cookies, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const resp = await fetch(fullUrl, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': cookies,
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(30000)
  });
  return resp;
}

/**
 * Log into arizonatile.com via WooCommerce POST to /my-account/.
 *
 * Flow:
 *   1. GET /my-account/ to extract woocommerce-login-nonce
 *   2. Capture initial cookies (Cloudflare __cf_bm, WooCommerce session, PHPSESSID)
 *   3. POST /my-account/ with form data + nonce
 *   4. redirect: 'manual' to capture Set-Cookie from 302
 *   5. Merge all cookies
 *   6. Verify by fetching /my-account/ and checking for dashboard content
 *
 * Returns the combined cookie string for use in subsequent requests.
 */
export async function arizonaLogin(pool, jobId) {
  const email = process.env.ARIZONA_USERNAME;
  const password = process.env.ARIZONA_PASSWORD;

  if (!email || !password) {
    await addJobError(pool, jobId, 'ARIZONA_USERNAME and ARIZONA_PASSWORD environment variables are required');
    throw new Error('Missing Arizona Tile credentials — set ARIZONA_USERNAME and ARIZONA_PASSWORD in .env');
  }

  await appendLog(pool, jobId, 'Logging into arizonatile.com...');

  // GET /my-account/ to extract CSRF nonce + initial cookies
  const loginPageResp = await fetch(`${BASE_URL}/my-account/`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });
  const loginHtml = await loginPageResp.text();
  const initialCookies = extractCookies(loginPageResp);

  // Extract woocommerce-login-nonce
  const nonceMatch = loginHtml.match(/name="woocommerce-login-nonce"\s+value="([^"]+)"/);
  if (!nonceMatch) {
    throw new Error('Could not extract woocommerce-login-nonce from /my-account/');
  }
  const nonce = nonceMatch[1];

  // POST login with form data
  const formData = new URLSearchParams();
  formData.append('username', email);
  formData.append('password', password);
  formData.append('woocommerce-login-nonce', nonce);
  formData.append('_wp_http_referer', '/my-account/');
  formData.append('rememberme', 'forever');
  formData.append('login', 'Log in');

  const resp = await fetch(`${BASE_URL}/my-account/`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': initialCookies
    },
    body: formData.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  // Capture Set-Cookie from 302 response
  const loginCookies = extractCookies(resp);
  const allCookies = mergeCookies(initialCookies, loginCookies);

  // Verify session by fetching /my-account/ and checking for dashboard content
  const verifyResp = await arizonaFetch('/my-account/', allCookies);
  const verifyHtml = await verifyResp.text();

  const isLoggedIn = !verifyHtml.includes('woocommerce-login-nonce') &&
                     (verifyHtml.includes('dashboard') || verifyHtml.includes('my-account') ||
                      verifyHtml.includes('Hello') || verifyHtml.includes('Log out') ||
                      verifyHtml.includes('logout'));

  if (!isLoggedIn) {
    await addJobError(pool, jobId, 'Login verification failed — session may not be authenticated');
    throw new Error('Login failed: could not verify authenticated session');
  }

  await appendLog(pool, jobId, 'Login successful — session verified');
  return allCookies;
}

/**
 * Extract Set-Cookie values from a fetch Response and return as a single cookie string.
 */
function extractCookies(resp) {
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    return setCookies.map(c => c.split(';')[0].trim()).join('; ');
  }
  const raw = resp.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(',').map(c => c.split(';')[0].trim()).join('; ');
}

/**
 * Merge two cookie strings, with later values overriding earlier ones.
 */
function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const str of [existing, incoming]) {
    if (!str) continue;
    for (const part of str.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        map.set(trimmed.slice(0, eqIdx).trim(), trimmed);
      }
    }
  }
  return Array.from(map.values()).join('; ');
}
