/**
 * Roca Marketing Assets Portal — Login Debug + Image Scraper
 */
import pg from 'pg';
import { delay, upsertMediaAsset } from '../scrapers/base.js';
import puppeteer from 'puppeteer';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE = 'https://marketing-assets.rocatileusa.com';

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  try {
    // Navigate to login page
    console.log('Navigating to portal...');
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

    // Fill login form
    console.log('Filling login form...');
    await page.type('#wppb_user_login', 'RomaFlooring');
    await page.type('#wppb_user_pass', 'Iluvlions910!');

    // Submit and wait
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      page.click('#wppb-submit'),
    ]);

    // Wait a moment for any dynamic content
    await delay(2000);

    console.log('After login URL:', page.url());

    // Check for error messages
    const result = await page.evaluate(() => {
      // Look for error messages
      const errors = document.querySelectorAll('.wppb-error, .login-error, .alert, .error, [class*="error"], [class*="alert"]');
      const errorTexts = [...errors].map(e => e.textContent.trim()).filter(t => t.length > 0 && t.length < 500);

      // Check if we're logged in by looking for dashboard content, menu items, logout link
      const logoutLink = document.querySelector('a[href*="logout"], a[href*="log-out"]');
      const bodyText = document.body.innerText;
      const links = [...document.querySelectorAll('a')].map(a => ({
        href: a.href, text: a.textContent.trim().substring(0, 80)
      })).filter(l => l.text && l.href && !l.href.includes('javascript'));

      return {
        errors: errorTexts,
        hasLogout: !!logoutLink,
        url: window.location.href,
        linkCount: links.length,
        links: links.slice(0, 40),
        bodyPreview: bodyText.substring(0, 2000),
      };
    });

    if (result.errors.length) {
      console.log('\nLogin errors:');
      for (const e of result.errors) console.log('  ' + e);
    }

    console.log('Has logout link:', result.hasLogout);
    console.log('Total links:', result.linkCount);

    if (result.hasLogout || result.linkCount > 15) {
      // We're logged in!
      console.log('\n=== LOGGED IN - Exploring portal ===');
      console.log('\nLinks:');
      for (const l of result.links) {
        console.log(`  ${l.text} → ${l.href}`);
      }
      console.log('\nPage content:');
      console.log(result.bodyPreview);

      // Try to find collection/download pages
      const collectionLinks = result.links.filter(l =>
        l.href.includes('/collection') || l.href.includes('/product') ||
        l.href.includes('/download') || l.href.includes('/gallery') ||
        l.href.includes('/image') || l.href.includes('/asset') ||
        l.href.includes('/catalog') || l.href.includes('/resource')
      );
      if (collectionLinks.length) {
        console.log('\nRelevant links:');
        for (const l of collectionLinks) console.log(`  ${l.text} → ${l.href}`);

        // Visit first few to understand structure
        for (const l of collectionLinks.slice(0, 3)) {
          console.log(`\n--- Visiting: ${l.text} ---`);
          await page.goto(l.href, { waitUntil: 'networkidle2', timeout: 20000 });
          await delay(1000);

          const subContent = await page.evaluate(() => {
            const imgs = [...document.querySelectorAll('img')].map(i => i.src).filter(s => s.includes('upload'));
            const links = [...document.querySelectorAll('a')].map(a => ({
              href: a.href, text: a.textContent.trim().substring(0, 60)
            })).filter(l => l.href.includes('upload') || l.href.includes('.zip') || l.href.includes('.jpg'));
            const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.trim());
            return { imgs: imgs.slice(0, 20), links: links.slice(0, 20), headings };
          });

          console.log('Headings:', subContent.headings);
          console.log('Images:', subContent.imgs.length);
          subContent.imgs.slice(0, 5).forEach(i => console.log('  ' + i));
          console.log('Download links:', subContent.links.length);
          subContent.links.slice(0, 5).forEach(l => console.log(`  ${l.text} → ${l.href}`));
        }
      }
    } else {
      console.log('\nStill on login page. Body:');
      console.log(result.bodyPreview.substring(0, 1000));
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
