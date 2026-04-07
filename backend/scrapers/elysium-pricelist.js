import fs from 'fs';
import path from 'path';
import { appendLog, addJobError } from './base.js';
import { elysiumLogin, elysiumFetch, BASE_URL } from './elysium-auth.js';

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

const CANDIDATE_PATHS = [
  '/pricelist.php',
  '/my-pricelist',
  '/pricelist',
  '/account/pricelist',
  '/my-account',
  '/account',
];

/**
 * Elysium Tile price list PDF downloader.
 *
 * Logs in, locates the "My Pricelist" section, downloads the PDF.
 * Simplest of the three Elysium scrapers — good for testing auth.
 */
export async function run(pool, job, source) {
  const downloadDir = path.join(UPLOADS_BASE, 'elysium');
  await fs.promises.mkdir(downloadDir, { recursive: true });

  // Login
  const cookies = await elysiumLogin(pool, job.id);

  // Try candidate URLs to find the price list page
  let pricelistHtml = null;
  let foundPath = null;

  for (const candidatePath of CANDIDATE_PATHS) {
    try {
      await appendLog(pool, job.id, `Trying ${candidatePath}...`);
      const resp = await elysiumFetch(candidatePath, cookies);

      if (!resp.ok) continue;

      const html = await resp.text();
      const lower = html.toLowerCase();

      if (lower.includes('price') && (lower.includes('.pdf') || lower.includes('download') || lower.includes('pricelist'))) {
        pricelistHtml = html;
        foundPath = candidatePath;
        await appendLog(pool, job.id, `Found price list page at ${candidatePath}`);
        break;
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Fallback: search homepage for price-related links
  if (!pricelistHtml) {
    await appendLog(pool, job.id, 'Candidate paths exhausted — searching homepage for price links...');
    try {
      const homeResp = await elysiumFetch('/', cookies);
      const homeHtml = await homeResp.text();

      const linkRegex = /href=["']([^"']*(?:price|pricelist)[^"']*)["']/gi;
      let match;
      while ((match = linkRegex.exec(homeHtml)) !== null) {
        const href = match[1];
        await appendLog(pool, job.id, `Found price-related link: ${href}`);

        try {
          const resp = await elysiumFetch(href, cookies);
          if (resp.ok) {
            pricelistHtml = await resp.text();
            foundPath = href;
            break;
          }
        } catch {
          // Continue
        }
      }
    } catch (err) {
      await addJobError(pool, job.id, `Homepage search failed: ${err.message}`);
    }
  }

  if (!pricelistHtml) {
    await addJobError(pool, job.id, 'Could not locate price list page on elysiumtile.com');
    throw new Error('Price list page not found. Check candidate URLs or run catalog scraper with discovery logging.');
  }

  // Find PDF download links in the page
  const pdfRegex = /href=["']([^"']+\.pdf[^"']*)["']/gi;
  const pdfLinks = [];
  let match;
  while ((match = pdfRegex.exec(pricelistHtml)) !== null) {
    pdfLinks.push(match[1]);
  }

  if (pdfLinks.length === 0) {
    // Try broader download link pattern
    const downloadRegex = /href=["']([^"']*(?:download|price)[^"']*)["']/gi;
    while ((match = downloadRegex.exec(pricelistHtml)) !== null) {
      if (!pdfLinks.includes(match[1])) {
        pdfLinks.push(match[1]);
      }
    }
  }

  await appendLog(pool, job.id, `Found ${pdfLinks.length} potential PDF links on ${foundPath}`);

  if (pdfLinks.length === 0) {
    await addJobError(pool, job.id, 'No PDF download links found on price list page');
    throw new Error('No PDF links found on the price list page');
  }

  // Download each PDF
  let downloaded = 0;
  for (const pdfUrl of pdfLinks) {
    try {
      const fullUrl = pdfUrl.startsWith('http') ? pdfUrl : `${BASE_URL}${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}`;
      const date = new Date().toISOString().slice(0, 10);
      const filename = `elysium-pricelist-${date}${downloaded > 0 ? `-${downloaded}` : ''}.pdf`;
      const destPath = path.join(downloadDir, filename);

      await appendLog(pool, job.id, `Downloading ${fullUrl}...`);

      const resp = await elysiumFetch(fullUrl, cookies, { signal: AbortSignal.timeout(120000) });

      if (!resp.ok) {
        await appendLog(pool, job.id, `HTTP ${resp.status} for ${fullUrl} — skipping`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      await fs.promises.writeFile(destPath, buffer);

      // Verify file size
      const stats = await fs.promises.stat(destPath);
      if (stats.size < 1024) {
        await fs.promises.unlink(destPath).catch(() => {});
        await appendLog(pool, job.id, `File too small (${stats.size} bytes) — skipping`);
        continue;
      }

      await appendLog(pool, job.id, `Saved ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);
      downloaded++;
    } catch (err) {
      await addJobError(pool, job.id, `PDF download failed: ${err.message}`);
    }
  }

  await appendLog(pool, job.id,
    `Price list download complete. Downloaded ${downloaded} PDF(s).`,
    { products_found: downloaded }
  );
}
