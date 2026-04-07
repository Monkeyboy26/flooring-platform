import fs from 'fs';
import path from 'path';
import { launchBrowser, delay, appendLog, addJobError } from './base.js';
import { portalLogin, screenshot, waitForSPA } from './tradepro-auth.js';

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const MAX_ERRORS = 30;

const PRICE_BOOKS = [
  { brand: 'Daltile',        filename: 'daltile-pricebook.pdf',  scraperKey: 'daltile-pricing',  keywords: ['daltile', 'dal'] },
  { brand: 'American Olean', filename: 'ao-pricebook.pdf',       scraperKey: 'ao-pricing',       keywords: ['american olean', 'ao '] },
  { brand: 'Marazzi',        filename: 'marazzi-pricebook.pdf',  scraperKey: 'marazzi-pricing',  keywords: ['marazzi'] },
];

const CANDIDATE_PATHS = [
  '/s/price-books', '/s/pricebooks', '/s/price-lists',
  '/s/pricelists', '/s/downloads', '/s/resources',
  '/s/documents', '/s/price-book', '/s/pricelist'
];

/**
 * TradePro Exchange portal scraper.
 * Logs into the Salesforce-based portal, navigates to the price books section,
 * downloads fresh PDFs, and optionally triggers the Phase 1 parsers.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const discoveryMode = config.discovery_mode === true;
  const runParsers = config.run_parsers !== false;
  const downloadDir = path.join(UPLOADS_BASE, 'tradepro');
  let browser = null;
  let errorCount = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { /* DB error during error logging — ignore */ }
    }
  }

  try {
    await fs.promises.mkdir(downloadDir, { recursive: true });

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Login with retry (up to 2 retries)
    let loginSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await appendLog(pool, job.id, `Login attempt ${attempt}/3...`);
        await portalLogin(page, pool, job);
        loginSuccess = true;
        break;
      } catch (err) {
        await logError(`Login attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          const backoff = attempt * 5000;
          await appendLog(pool, job.id, `Retrying login in ${backoff / 1000}s...`);
          await delay(backoff);
        }
      }
    }

    if (!loginSuccess) {
      throw new Error('All login attempts failed');
    }

    // Discovery mode: log all nav links on the dashboard
    if (discoveryMode) {
      await appendLog(pool, job.id, '=== DISCOVERY MODE ===');
      await screenshot(page, 'dashboard');
      const navLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a, button')).map(el => ({
          tag: el.tagName,
          text: el.textContent.trim().slice(0, 100),
          href: el.href || el.getAttribute('href') || ''
        })).filter(l => l.text || l.href);
      });
      for (const link of navLinks) {
        await appendLog(pool, job.id, `  [${link.tag}] "${link.text}" → ${link.href}`);
      }
      await appendLog(pool, job.id, `Found ${navLinks.length} navigation elements`);
    }

    // Navigate to price books section
    const pricebookPage = await navigateToPriceBooks(page, pool, job, config, discoveryMode);

    if (!pricebookPage) {
      throw new Error('Could not locate price books section. Run with discovery_mode: true to inspect portal structure.');
    }

    // Download PDFs for each brand
    const downloaded = [];
    for (const book of PRICE_BOOKS) {
      try {
        await appendLog(pool, job.id, `Looking for ${book.brand} price book...`);
        const filePath = await downloadBrandPDF(page, pool, job, book, downloadDir);
        if (filePath) {
          downloaded.push({ ...book, filePath });
          await appendLog(pool, job.id, `Downloaded ${book.brand} → ${filePath}`);
        } else {
          await appendLog(pool, job.id, `No download link found for ${book.brand}`);
        }
      } catch (err) {
        await logError(`${book.brand} download failed: ${err.message}`);
        await appendLog(pool, job.id, `Failed to download ${book.brand}: ${err.message}`);
        // Continue with other brands (graceful degradation)
      }
    }

    await appendLog(pool, job.id, `Downloaded ${downloaded.length}/${PRICE_BOOKS.length} price books`);

    // Optionally trigger Phase 1 parsers
    if (runParsers && downloaded.length > 0) {
      await triggerParsers(pool, job, source, downloaded);
    }

    // Summary
    await appendLog(pool, job.id,
      `Complete. Downloaded: ${downloaded.map(d => d.brand).join(', ') || 'none'}. Errors: ${errorCount}`,
      { products_found: downloaded.length }
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Navigate to the price books section using multiple strategies.
 * Returns true if navigation succeeded, false otherwise.
 */
async function navigateToPriceBooks(page, pool, job, config, discoveryMode) {
  const baseUrl = 'https://www.tradeproexchange.com';

  // Strategy A: Direct URL from config
  if (config.pricebook_url) {
    const url = config.pricebook_url.startsWith('http')
      ? config.pricebook_url
      : `${baseUrl}${config.pricebook_url}`;

    await appendLog(pool, job.id, `Strategy A: navigating to configured URL: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await waitForSPA(page);

      // Check for session expiry (redirect to login)
      if (page.url().includes('/login')) {
        await appendLog(pool, job.id, 'Session expired — redirected to login');
        return false;
      }

      if (discoveryMode) await screenshot(page, 'pricebook-page');
      await appendLog(pool, job.id, `Landed on: ${page.url()}`);
      return true;
    } catch (err) {
      await appendLog(pool, job.id, `Strategy A failed: ${err.message}`);
    }
  }

  // Strategy B: Auto-discovery of candidate paths
  await appendLog(pool, job.id, 'Strategy B: trying candidate paths...');
  for (const candidatePath of CANDIDATE_PATHS) {
    try {
      const url = `${baseUrl}${candidatePath}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await waitForSPA(page);

      if (page.url().includes('/login')) {
        await appendLog(pool, job.id, `  ${candidatePath} → redirected to login`);
        continue;
      }

      // Check page content for price/download/PDF keywords
      const hasRelevantContent = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (text.includes('price') || text.includes('download') || text.includes('.pdf')) &&
               (text.includes('daltile') || text.includes('olean') || text.includes('marazzi') || text.includes('price book') || text.includes('price list'));
      });

      if (hasRelevantContent) {
        await appendLog(pool, job.id, `  ${candidatePath} → found relevant content`);
        if (discoveryMode) await screenshot(page, `candidate-${candidatePath.replace(/\//g, '-')}`);
        return true;
      }

      await appendLog(pool, job.id, `  ${candidatePath} → no relevant content`);
    } catch {
      await appendLog(pool, job.id, `  ${candidatePath} → failed to load`);
    }
  }

  // Strategy C: DOM exploration — search current page links for price-related text
  await appendLog(pool, job.id, 'Strategy C: searching page links for price-related text...');

  // Go back to dashboard first
  await page.goto(baseUrl + '/s/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await waitForSPA(page);

  const priceLinks = await page.evaluate(() => {
    const keywords = ['price', 'download', 'pdf', 'book', 'list', 'catalog', 'document'];
    return Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: a.textContent.trim().slice(0, 100),
      href: a.href
    })).filter(l => {
      const combined = (l.text + ' ' + l.href).toLowerCase();
      return keywords.some(kw => combined.includes(kw));
    });
  });

  if (priceLinks.length > 0) {
    await appendLog(pool, job.id, `Found ${priceLinks.length} price-related links:`);
    for (const link of priceLinks) {
      await appendLog(pool, job.id, `  "${link.text}" → ${link.href}`);
    }

    // Try the first match
    try {
      await page.goto(priceLinks[0].href, { waitUntil: 'networkidle2', timeout: 60000 });
      await waitForSPA(page);
      if (!page.url().includes('/login')) {
        if (discoveryMode) await screenshot(page, 'strategy-c-result');
        return true;
      }
    } catch {
      await appendLog(pool, job.id, 'Strategy C: failed to navigate to first link');
    }
  } else {
    await appendLog(pool, job.id, 'Strategy C: no price-related links found on dashboard');
  }

  if (discoveryMode) await screenshot(page, 'no-pricebook-found');
  return false;
}

/**
 * Download a specific brand's PDF from the current page.
 * Returns the local file path on success, null if no link found.
 */
async function downloadBrandPDF(page, pool, job, book, downloadDir) {
  // Find download links matching brand keywords
  const links = await page.evaluate((keywords) => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: a.textContent.trim(),
      href: a.href
    })).filter(l => {
      const combined = (l.text + ' ' + l.href).toLowerCase();
      return keywords.some(kw => combined.includes(kw));
    });
  }, book.keywords);

  if (links.length === 0) return null;

  await appendLog(pool, job.id, `  Found ${links.length} links for ${book.brand}: ${links.map(l => l.text).join(', ')}`);

  // Prefer direct PDF URLs
  const pdfLink = links.find(l => l.href.toLowerCase().endsWith('.pdf')) || links[0];
  const destPath = path.join(downloadDir, book.filename);

  if (pdfLink.href.toLowerCase().endsWith('.pdf') || pdfLink.href.includes('/sfc/servlet.shepherd')) {
    // Direct PDF URL or Salesforce file servlet — download via fetch with cookies
    await appendLog(pool, job.id, `  Downloading via fetch: ${pdfLink.href}`);
    await downloadWithCookies(page, pdfLink.href, destPath);
  } else {
    // Browser-managed download via CDP
    await appendLog(pool, job.id, `  Downloading via browser: ${pdfLink.href}`);
    await downloadViaCDP(page, pdfLink.href, destPath, downloadDir);
  }

  // Verify file exists and has content
  try {
    const stats = await fs.promises.stat(destPath);
    if (stats.size < 1000) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw new Error(`Downloaded file too small (${stats.size} bytes)`);
    }
    return destPath;
  } catch (err) {
    throw new Error(`File verification failed for ${book.brand}: ${err.message}`);
  }
}

/**
 * Download a file using fetch with the page's session cookies.
 */
async function downloadWithCookies(page, url, destPath) {
  const cookies = await page.cookies();
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const resp = await fetch(url, {
    headers: {
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000)
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading ${url}`);
  }

  await fs.promises.writeFile(destPath, Buffer.from(await resp.arrayBuffer()));
}

/**
 * Download a file via CDP Page.setDownloadBehavior (for non-direct links).
 * Clicks the link and polls for download completion.
 */
async function downloadViaCDP(page, href, destPath, downloadDir) {
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir
  });

  // Click the link
  await page.evaluate((url) => {
    const link = Array.from(document.querySelectorAll('a[href]')).find(a => a.href === url);
    if (link) link.click();
  }, href);

  // Poll for download completion (wait for .crdownload to disappear)
  const maxWait = 120000;
  const pollInterval = 2000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await delay(pollInterval);
    elapsed += pollInterval;

    const files = await fs.promises.readdir(downloadDir);
    const downloading = files.some(f => f.endsWith('.crdownload'));
    const pdfs = files.filter(f => f.endsWith('.pdf') && !f.startsWith('.'));

    if (!downloading && pdfs.length > 0) {
      // Find the most recently created PDF
      let newest = null;
      let newestTime = 0;
      for (const pdf of pdfs) {
        const stat = await fs.promises.stat(path.join(downloadDir, pdf));
        if (stat.mtimeMs > newestTime) {
          newestTime = stat.mtimeMs;
          newest = pdf;
        }
      }

      if (newest) {
        const srcPath = path.join(downloadDir, newest);
        if (srcPath !== destPath) {
          await fs.promises.rename(srcPath, destPath);
        }
        await client.detach();
        return;
      }
    }
  }

  await client.detach();
  throw new Error('Download timed out after 120s');
}

/**
 * Trigger Phase 1 parsers for each downloaded PDF.
 * Creates sub-jobs by importing and calling the daltile-pricing scraper directly.
 */
async function triggerParsers(pool, job, source, downloaded) {
  await appendLog(pool, job.id, 'Triggering Phase 1 parsers for downloaded PDFs...');

  // Dynamically import the parser
  let parserModule;
  try {
    parserModule = await import('./daltile-pricing.js');
  } catch (err) {
    await addJobError(pool, job.id, `Could not import daltile-pricing parser: ${err.message}`);
    return;
  }

  for (const book of downloaded) {
    try {
      // Look up the matching vendor_source by scraper_key
      const vsResult = await pool.query(
        'SELECT id, vendor_id, config FROM vendor_sources WHERE scraper_key = $1 LIMIT 1',
        [book.scraperKey]
      );

      if (vsResult.rows.length === 0) {
        await appendLog(pool, job.id, `  No vendor_source found for scraper_key="${book.scraperKey}" — skipping parser`);
        continue;
      }

      const vs = vsResult.rows[0];

      // Update the vendor_source config with the new pdf_path
      const updatedConfig = { ...(vs.config || {}), pdf_path: book.filePath };
      await pool.query(
        'UPDATE vendor_sources SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [JSON.stringify(updatedConfig), vs.id]
      );

      // Create a sub-job
      const subJobResult = await pool.query(
        `INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
         VALUES ($1, 'running', '', '[]'::jsonb)
         RETURNING *`,
        [vs.id]
      );
      const subJob = subJobResult.rows[0];

      await appendLog(pool, job.id, `  Created sub-job #${subJob.id} for ${book.brand} (${book.scraperKey})`);
      await appendLog(pool, subJob.id, `Auto-triggered by TradePro portal download job #${job.id}`);

      // Run the parser
      try {
        await parserModule.run(pool, subJob, { ...vs, config: updatedConfig });
        await pool.query(
          "UPDATE scrape_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = $1",
          [subJob.id]
        );
        await appendLog(pool, job.id, `  ${book.brand} parser completed successfully`);
      } catch (parseErr) {
        await pool.query(
          "UPDATE scrape_jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = $1",
          [subJob.id]
        );
        await addJobError(pool, subJob.id, parseErr.message);
        await appendLog(pool, job.id, `  ${book.brand} parser failed: ${parseErr.message}`);
      }
    } catch (err) {
      await addJobError(pool, job.id, `Parser trigger for ${book.brand}: ${err.message}`);
    }
  }
}
