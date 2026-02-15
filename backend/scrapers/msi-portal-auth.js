import fs from 'fs';
import path from 'path';
import { delay, appendLog, addJobError } from './base.js';

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

/**
 * Log into the MyMSI B2B dealer portal.
 *
 * The login form lives in an iframe hosted at b2b.msisurfaces.com.
 * After successful login, the page redirects to the B2B dashboard.
 *
 * @param {Page} page - Puppeteer page instance
 * @param {Pool} pool - DB pool for logging
 * @param {object} job - Scrape job record
 * @returns {void} - Page will be on the B2B dashboard after return
 */
export async function portalLogin(page, pool, job) {
  const username = process.env.MSI_PORTAL_USERNAME;
  const password = process.env.MSI_PORTAL_PASSWORD;

  if (!username || !password) {
    await addJobError(pool, job.id, 'MSI_PORTAL_USERNAME and MSI_PORTAL_PASSWORD environment variables are required');
    throw new Error('Missing MSI portal credentials — set MSI_PORTAL_USERNAME and MSI_PORTAL_PASSWORD in .env');
  }

  await appendLog(pool, job.id, 'Navigating to customer portal...');
  await page.goto('https://www.msisurfaces.com/customer-portal/', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  // Dismiss cookie consent banner if present
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const consent = btns.find(b => {
      const text = b.textContent.trim().toLowerCase();
      return text === 'continue' || text === 'accept' || text === 'accept all' || text === 'got it';
    });
    if (consent) consent.click();
  });
  await delay(1000);

  await appendLog(pool, job.id, 'Waiting for login iframe...');

  // Wait for the iframe to appear
  await page.waitForSelector('iframe', { timeout: 30000 });
  await delay(3000);

  // Find the login iframe (hosted at b2b.msisurfaces.com)
  const frames = page.frames();
  let loginFrame = null;

  for (const frame of frames) {
    const url = frame.url();
    if (url && url !== 'about:blank' && url !== page.url()) {
      const hasLoginForm = await frame.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="email"], input[type="text"], input[name*="email"], input[name*="user"], input[name*="username"]');
        return inputs.length > 0;
      }).catch(() => false);

      if (hasLoginForm) {
        loginFrame = frame;
        await appendLog(pool, job.id, `Login iframe found: ${url}`);
        break;
      }
    }
  }

  const context = loginFrame || page;
  const contextLabel = loginFrame ? 'iframe' : 'main page';
  await appendLog(pool, job.id, `Found login form in ${contextLabel}`);

  // Fill username
  const emailSelector = await findSelector(context, [
    'input[type="email"]',
    'input[name*="email"]',
    'input[name*="user"]',
    'input[name*="login"]',
    'input[type="text"]'
  ]);

  if (!emailSelector) {
    await screenshot(page, 'login-no-email-field');
    await addJobError(pool, job.id, 'Could not find email input field on login form');
    throw new Error('Login failed: no email field found');
  }

  await context.click(emailSelector, { clickCount: 3 });
  await context.type(emailSelector, username, { delay: 50 });

  // Fill password
  const passwordSelector = await findSelector(context, [
    'input[type="password"]',
    'input[name*="password"]',
    'input[name*="pass"]'
  ]);

  if (!passwordSelector) {
    await screenshot(page, 'login-no-password-field');
    await addJobError(pool, job.id, 'Could not find password input field on login form');
    throw new Error('Login failed: no password field found');
  }

  await context.click(passwordSelector, { clickCount: 3 });
  await context.type(passwordSelector, password, { delay: 50 });

  await appendLog(pool, job.id, 'Credentials filled, submitting...');

  // Submit — try standard selectors first
  let submitted = false;

  const submitSelector = await findSelector(context, [
    'button[type="submit"]',
    'input[type="submit"]'
  ]);

  if (submitSelector) {
    await Promise.all([
      context.click(submitSelector),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    ]);
    submitted = true;
  }

  // Fallback: find SIGN IN button by text
  if (!submitted) {
    const signInClicked = await context.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const signIn = elements.find(el => {
        const text = el.textContent.trim().toLowerCase();
        return text === 'sign in' || text === 'login' || text === 'log in' || text === 'submit';
      });
      if (signIn) { signIn.click(); return true; }
      const form = document.querySelector('form');
      if (form) { form.submit(); return true; }
      return false;
    });

    if (signInClicked) {
      await appendLog(pool, job.id, 'Clicked sign-in button by text match');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      submitted = true;
    }
  }

  // Last resort: Enter in password field
  if (!submitted) {
    await context.focus(passwordSelector);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }

  await delay(5000);

  // Verify login
  const currentUrl = page.url();
  await appendLog(pool, job.id, `Post-login URL: ${currentUrl}`);

  const stillHasLoginForm = await page.evaluate(() => {
    return document.querySelectorAll('input[type="password"]').length > 0;
  }).catch(() => false);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '');
  const lowerText = pageText.toLowerCase();

  const loginFailed = (
    stillHasLoginForm ||
    (lowerText.includes('invalid') || lowerText.includes('incorrect') || lowerText.includes('try again'))
  );

  if (loginFailed) {
    await screenshot(page, 'login-failed');
    await addJobError(pool, job.id, 'Login failed — invalid credentials or portal error');
    throw new Error('Login failed: invalid credentials');
  }

  await appendLog(pool, job.id, `Login successful. Current URL: ${currentUrl}`);
}

/**
 * Take a screenshot to the uploads directory.
 */
export async function screenshot(page, label) {
  try {
    const timestamp = Date.now();
    const filePath = path.join(UPLOADS_BASE, `msi-portal-${label}-${timestamp}.png`);
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
