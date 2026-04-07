import fs from 'fs';
import path from 'path';
import { delay, appendLog, addJobError } from './base.js';

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

/**
 * Wait for Salesforce SPA transitions to settle.
 * Salesforce Experience Cloud uses LWC which doesn't trigger traditional
 * navigation events — we wait for spinners + network idle + extra buffer.
 */
export async function waitForSPA(page, timeout = 30000) {
  try {
    await page.waitForSelector('.slds-spinner', { timeout: 5000 });
    await page.waitForSelector('.slds-spinner', { hidden: true, timeout });
  } catch { /* spinner may not appear */ }
  await page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(() => {});
  await delay(2000);
}

/**
 * Log into the TradePro Exchange portal (Salesforce Experience Cloud SPA).
 *
 * @param {Page} page - Puppeteer page instance
 * @param {Pool} pool - DB pool for logging
 * @param {object} job - Scrape job record
 * @returns {void} - Page will be on the portal dashboard after return
 */
export async function portalLogin(page, pool, job) {
  const username = process.env.TRADEPRO_USERNAME;
  const password = process.env.TRADEPRO_PASSWORD;

  if (!username || !password) {
    await addJobError(pool, job.id, 'TRADEPRO_USERNAME and TRADEPRO_PASSWORD environment variables are required');
    throw new Error('Missing TradePro credentials — set TRADEPRO_USERNAME and TRADEPRO_PASSWORD in .env');
  }

  await appendLog(pool, job.id, 'Navigating to TradePro Exchange login...');
  await page.goto('https://www.tradeproexchange.com/s/login/', {
    waitUntil: 'networkidle2',
    timeout: 90000
  });

  // Dismiss cookie/consent banners if present
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const consent = btns.find(b => {
      const text = b.textContent.trim().toLowerCase();
      return text === 'continue' || text === 'accept' || text === 'accept all' || text === 'got it';
    });
    if (consent) consent.click();
  });
  await delay(1000);

  await appendLog(pool, job.id, 'Waiting for login form...');

  // Wait for login form — try standard selectors + Salesforce LWC selectors
  const emailSelector = await findSelector(page, [
    'lightning-input input[type="text"]',
    'lightning-input input[name*="user"]',
    'input[type="email"]',
    'input[name*="email"]',
    'input[name*="user"]',
    'input[name*="login"]',
    'input[name*="username"]',
    'input[type="text"]'
  ], 30000);

  if (!emailSelector) {
    await screenshot(page, 'login-no-email-field');
    await addJobError(pool, job.id, 'Could not find email/username input field on login form');
    throw new Error('Login failed: no email/username field found');
  }

  await appendLog(pool, job.id, `Found username field: ${emailSelector}`);
  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, username, { delay: 80 });

  // Fill password
  const passwordSelector = await findSelector(page, [
    'lightning-input input[type="password"]',
    'input[type="password"]',
    'input[name*="password"]',
    'input[name*="pass"]'
  ]);

  if (!passwordSelector) {
    await screenshot(page, 'login-no-password-field');
    await addJobError(pool, job.id, 'Could not find password input field on login form');
    throw new Error('Login failed: no password field found');
  }

  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, password, { delay: 80 });

  await appendLog(pool, job.id, 'Credentials filled, submitting...');

  // Submit — try standard selectors first
  let submitted = false;
  const preLoginUrl = page.url();

  const submitSelector = await findSelector(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'lightning-button button'
  ]);

  if (submitSelector) {
    await page.click(submitSelector);
    submitted = true;
  }

  // Fallback: find Sign In / Log In button by text
  if (!submitted) {
    const signInClicked = await page.evaluate(() => {
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
      submitted = true;
    }
  }

  // Last resort: Enter key in password field
  if (!submitted) {
    await page.focus(passwordSelector);
    await page.keyboard.press('Enter');
  }

  // Salesforce SPA: don't use waitForNavigation — wait for SPA transition instead
  // 1. Wait for password field to disappear
  await page.waitForSelector('input[type="password"]', { hidden: true, timeout: 30000 }).catch(() => {});

  // 2. Wait for URL to change away from /login
  const urlChanged = await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && !window.location.href.includes('/login'),
    { timeout: 30000 },
    preLoginUrl
  ).catch(() => false);

  // 3. Wait for Salesforce spinners to disappear
  await waitForSPA(page, 30000);

  // 4. Extra buffer for LWC hydration
  await delay(5000);

  // Verify login
  const currentUrl = page.url();
  await appendLog(pool, job.id, `Post-login URL: ${currentUrl}`);

  const stillHasPassword = await page.evaluate(() => {
    return document.querySelectorAll('input[type="password"]').length > 0;
  }).catch(() => false);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
  const lowerText = pageText.toLowerCase();

  const loginFailed = (
    stillHasPassword ||
    currentUrl.includes('/login') ||
    lowerText.includes('invalid') ||
    lowerText.includes('incorrect') ||
    lowerText.includes('try again') ||
    lowerText.includes('authentication failure')
  );

  if (loginFailed) {
    await screenshot(page, 'login-failed');
    await addJobError(pool, job.id, `Login failed. URL: ${currentUrl}`);
    throw new Error('Login failed: invalid credentials or portal error');
  }

  await screenshot(page, 'login-success');
  await appendLog(pool, job.id, `Login successful. URL: ${currentUrl}`);
}

/**
 * Take a screenshot to the uploads directory.
 */
export async function screenshot(page, label) {
  try {
    const timestamp = Date.now();
    const filePath = path.join(UPLOADS_BASE, 'tradepro', `tradepro-${label}-${timestamp}.png`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Find the first matching selector from a list of candidates.
 * Optionally waits for the first selector to appear.
 */
export async function findSelector(context, selectors, waitTimeout) {
  if (waitTimeout) {
    // Wait for any of the selectors to appear, with a timeout fallback
    const racePromises = selectors.map(sel =>
      context.waitForSelector(sel, { timeout: waitTimeout }).then(() => sel).catch(() => null)
    );
    const timeoutFallback = delay(waitTimeout).then(() => null);
    const first = await Promise.race([
      ...racePromises.map(p => p.then(v => v ? v : new Promise(() => {}))),
      timeoutFallback,
    ]);
    if (first) return first;
    // If race didn't resolve, fall through to sequential check
    await delay(1000);
  }
  for (const sel of selectors) {
    const el = await context.$(sel).catch(() => null);
    if (el) return sel;
  }
  return null;
}
