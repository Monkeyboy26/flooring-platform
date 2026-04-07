import { appendLog, addJobError } from './base.js';

export const BASE_URL = 'https://elysiumtile.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch helper that prepends BASE_URL and includes session cookies + User-Agent.
 */
export async function elysiumFetch(url, cookies, options = {}) {
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
 * Log into elysiumtile.com via POST to /login.php.
 *
 * The login form has three hidden/visible fields:
 *   - action=login (hidden)
 *   - email
 *   - password
 *
 * On success the server returns a 302 with Set-Cookie headers:
 *   - email=... (URL-encoded email)
 *   - session=... (bcrypt-hashed session token)
 *
 * Returns the combined cookie string for use in subsequent requests.
 */
export async function elysiumLogin(pool, jobId) {
  const email = process.env.ELYSIUM_USERNAME;
  const password = process.env.ELYSIUM_PASSWORD;

  if (!email || !password) {
    await addJobError(pool, jobId, 'ELYSIUM_USERNAME and ELYSIUM_PASSWORD environment variables are required');
    throw new Error('Missing Elysium credentials — set ELYSIUM_USERNAME and ELYSIUM_PASSWORD in .env');
  }

  await appendLog(pool, jobId, 'Logging into elysiumtile.com...');

  // GET the login page first to establish PHPSESSID
  const loginPageResp = await fetch(`${BASE_URL}/login.php`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });
  await loginPageResp.text(); // consume body
  const initialCookies = extractCookies(loginPageResp);

  // POST login — include action=login hidden field
  const formData = new URLSearchParams();
  formData.append('action', 'login');
  formData.append('url', '');
  formData.append('email', email);
  formData.append('password', password);

  const resp = await fetch(`${BASE_URL}/login.php`, {
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

  // Server returns 302 with email= and session= cookies
  const loginCookies = extractCookies(resp);

  // Merge initial PHPSESSID with login session cookies
  const allCookies = mergeCookies(initialCookies, loginCookies);

  if (!allCookies || !allCookies.includes('session=')) {
    throw new Error('Login failed: no session cookie returned');
  }

  // Verify session by fetching a category page and checking for authenticated content
  const verifyResp = await elysiumFetch('/category?type=Mosaic&order_by=name&page=1', allCookies);
  const verifyHtml = await verifyResp.text();

  const isLoggedIn = verifyHtml.includes('Logout') || verifyHtml.includes('logout') ||
                     verifyHtml.includes('My Account') || verifyHtml.includes('my-account') ||
                     verifyHtml.includes('pricelist') || verifyHtml.includes('Log Out');

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
  // Fallback: try raw header
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
