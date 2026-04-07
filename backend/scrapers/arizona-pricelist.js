import fs from 'fs';
import path from 'path';
import { appendLog, addJobError } from './base.js';
import { arizonaLogin, arizonaFetch, BASE_URL } from './arizona-auth.js';

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';

const CANDIDATE_PATHS = [
  '/my-account/price-list/',
  '/my-account/downloads/',
  '/price-list/',
  '/my-account/',
];

/**
 * Arizona Tile price list PDF downloader.
 *
 * Logs in via WooCommerce, locates price list links on the trade dashboard,
 * and downloads PDF(s) to the uploads directory.
 */
export async function run(pool, job, source) {
  const downloadDir = path.join(UPLOADS_BASE, 'arizona');
  await fs.promises.mkdir(downloadDir, { recursive: true });

  // Login
  const cookies = await arizonaLogin(pool, job.id);

  // Try candidate URLs to find the price list page
  let pricelistHtml = null;
  let foundPath = null;

  for (const candidatePath of CANDIDATE_PATHS) {
    try {
      await appendLog(pool, job.id, `Trying ${candidatePath}...`);
      const resp = await arizonaFetch(candidatePath, cookies);

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

  if (!pricelistHtml) {
    await appendLog(pool, job.id, 'Candidate paths exhausted — searching dashboard for all links...');

    // Fetch /my-account/ and log all links for discovery
    try {
      const dashResp = await arizonaFetch('/my-account/', cookies);
      const dashHtml = await dashResp.text();

      const allLinks = [];
      const linkRegex = /href=["']([^"']+)["']/gi;
      let match;
      while ((match = linkRegex.exec(dashHtml)) !== null) {
        const href = match[1].toLowerCase();
        if (href.includes('price') || href.includes('download') || href.includes('.pdf')) {
          allLinks.push(match[1]);
        }
      }

      await appendLog(pool, job.id, `Discovery: found ${allLinks.length} price/download links: ${allLinks.join(', ')}`);

      for (const link of allLinks) {
        try {
          const resp = await arizonaFetch(link, cookies);
          if (resp.ok) {
            pricelistHtml = await resp.text();
            foundPath = link;
            break;
          }
        } catch {
          // Continue
        }
      }
    } catch (err) {
      await addJobError(pool, job.id, `Dashboard search failed: ${err.message}`);
    }
  }

  if (!pricelistHtml) {
    await addJobError(pool, job.id, 'Could not locate price list page on arizonatile.com');
    throw new Error('Price list page not found. Check candidate URLs or site structure.');
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
      const filename = `arizona-pricelist-${date}${downloaded > 0 ? `-${downloaded}` : ''}.pdf`;
      const destPath = path.join(downloadDir, filename);

      await appendLog(pool, job.id, `Downloading ${fullUrl}...`);

      const resp = await arizonaFetch(fullUrl, cookies, { signal: AbortSignal.timeout(120000) });

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
