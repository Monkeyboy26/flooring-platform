/**
 * Build vendor-codes.pdf — the Roma Flooring "Vendor Directory — 3-Digit Codes".
 *
 * Rows are ordered by the numerical 3-digit vendor public_code (127, 132, 145…),
 * not alphabetically by vendor name. Vendors without a public_code sort last.
 *
 * Usage:  node backend/scripts/build-vendor-codes-pdf.js
 * Output: ./vendor-codes.pdf (repo root), or $OUT_PDF if set.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const { rows: vendors } = await pool.query(`
    SELECT name, public_code
    FROM vendors
    WHERE is_active = true AND is_one_off = false
    ORDER BY (public_code IS NULL), public_code::int NULLS LAST, name
  `);

  const genDate = new Date().toISOString().slice(0, 10);
  const rows = vendors.map((v, i) => `<tr class="${i % 2 ? 'alt' : ''}">
    <td class="vendor">${esc(v.name)}</td>
    <td class="code">${esc(v.public_code || '—')}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; color: #2b2620; margin: 0; }
    .page { padding: 44px 56px; }
    h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 700;
         font-size: 30px; letter-spacing: .5px; margin: 0; color: #221e18; }
    .subtitle { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600;
                font-size: 21px; color: #a08a5b; margin: 2px 0 4px; }
    .meta { font-size: 11px; color: #8a8175; margin-bottom: 12px; }
    .rule { height: 3px; background: #b79a63; margin-bottom: 20px; border-radius: 2px; }
    table { width: 100%; border-collapse: collapse; }
    thead th { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
               color: #9a9080; text-align: left; padding: 8px 14px; font-weight: 600; }
    thead th.code { text-align: right; }
    tbody td { padding: 9px 14px; font-size: 13px; }
    tr.alt { background: #faf6ee; }
    td.vendor { color: #33302a; }
    td.code { text-align: right; font-weight: 700; color: #9a7d3f;
              letter-spacing: 2px; font-variant-numeric: tabular-nums; }
  </style></head><body>
  <div class="page">
    <h1>ROMA FLOORING DESIGNS</h1>
    <div class="subtitle">Vendor Directory &mdash; 3-Digit Codes</div>
    <div class="meta">${vendors.length} vendors &middot; Sorted by code &middot; Generated ${genDate}</div>
    <div class="rule"></div>
    <table>
      <thead><tr><th class="vendor">Vendor</th><th class="code">Code</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div></body></html>`;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'networkidle0' });
  const out = process.env.OUT_PDF || path.resolve(__dirname, '../../vendor-codes.pdf');
  await pg.pdf({ path: out, format: 'Letter', printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  await browser.close();
  await pool.end();
  console.log(`Wrote ${out} — ${vendors.length} vendors, sorted by numerical code.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
