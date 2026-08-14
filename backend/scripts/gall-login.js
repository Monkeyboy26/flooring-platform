#!/usr/bin/env node
/**
 * ONE-TIME login helper for the Galleher Duffy daily scraper.
 *
 * galleherduffy.com blocks headless login with reCAPTCHA, so a human logs in ONCE
 * into the persistent Chrome profile the scraper reuses. Magento's persistent session
 * ("Remember me") then keeps that profile authenticated across the daily runs; re-run
 * this only if a scrape reports the session lapsed.
 *
 * Run it where you can SEE a browser window (e.g. your Mac), using the SAME repo so it
 * shares Puppeteer's Chromium + the profile dir the scraper reads:
 *
 *     cd backend && node scripts/gall-login.js
 *
 * A Chromium window opens on the login page. Sign in, CHECK "Remember me", solve the
 * captcha, land on your account. Then press Enter in this terminal to save + exit.
 * The profile is written to backend/data/gall-profile (mount this into the API
 * container so the scheduled scraper uses the same authenticated profile).
 */
import puppeteer from 'puppeteer';
import { PROFILE_DIR, BASE_URL } from '../scrapers/galleher-duffy-auth.js';

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PROFILE_DIR,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  defaultViewport: null,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
});
const page = (await browser.pages())[0] || (await browser.newPage());
await page.goto(`${BASE_URL}/customer/account/login/`, { waitUntil: 'domcontentloaded' });

console.log(`\nProfile dir: ${PROFILE_DIR}`);
console.log('→ Sign in in the browser window, CHECK "Remember me", solve the captcha.');
console.log('→ Once you are on your account/dashboard, press Enter here to save and exit.\n');
process.stdin.resume();
await new Promise((r) => process.stdin.once('data', r));

// quick verify: dealer pricing visible on a search
await page.goto(`${BASE_URL}/catalogsearch/result/?q=Monarch+Plank&product_list_limit=12`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
const html = await page.content();
console.log(/\$[0-9]+\.[0-9]{2}\s*\/\s*(Square Foot|Piece)/.test(html)
  ? '✓ Dealer pricing visible — session saved. The daily scraper can now use this profile.'
  : '✗ Pricing NOT visible — login may not have completed. Try again (ensure "Remember me").');
await browser.close();
process.exit(0);
