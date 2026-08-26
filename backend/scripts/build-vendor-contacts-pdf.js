/**
 * Build vendor-contacts.pdf — the Roma Flooring "Vendor Contact List".
 *
 * Cards are ordered by the numerical 3-digit vendor public_code (167, 168, 175…),
 * not alphabetically by vendor name. Vendors without a public_code sort last.
 *
 * Usage:  node backend/scripts/build-vendor-contacts-pdf.js
 * Output: ./vendor-contacts.pdf (repo root)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fieldRow(label, value) {
  if (!value) return '';
  return `<div class="row"><span class="lbl">${label}</span><span class="val">${esc(value)}</span></div>`;
}

function contactLine(c) {
  const primary = c.is_primary ? ' <span class="primary">PRIMARY</span>' : '';
  const meta = [c.role, c.email, c.phone].filter(Boolean).map(esc).join(' &middot; ');
  return `<div class="contact">
    <div class="cname">${esc(c.name)}${primary}</div>
    ${meta ? `<div class="cmeta">${meta}</div>` : ''}
  </div>`;
}

function vendorCard(v) {
  const contacts = v.contacts.length
    ? v.contacts.map(contactLine).join('')
    : `<div class="norep">No rep contacts on file</div>`;
  return `<div class="card">
    <div class="chead">
      <span class="vname">${esc(v.name)}</span>
      ${v.public_code ? `<span class="badge">${esc(v.public_code)}</span>` : ''}
    </div>
    ${fieldRow('CODE', v.public_code)}
    ${fieldRow('PHONE', v.phone)}
    ${fieldRow('EMAIL', v.email)}
    ${fieldRow('WEB', v.website)}
    ${fieldRow('ADDRESS', v.address)}
    ${fieldRow('ACCOUNT', v.account_number)}
    <div class="sep"></div>
    <div class="reps-lbl">REPS &amp; CONTACTS</div>
    ${contacts}
  </div>`;
}

async function main() {
  // Order by numerical public_code; nulls last.
  const { rows: vendors } = await pool.query(`
    SELECT id, name, public_code, email, phone, website, address, account_number
    FROM vendors
    WHERE is_active = true AND is_one_off = false
    ORDER BY (public_code IS NULL), public_code::int NULLS LAST, name
  `);

  const { rows: allContacts } = await pool.query(`
    SELECT vendor_id, name, role, email, phone, is_primary
    FROM vendor_contacts
    ORDER BY is_primary DESC, name
  `);
  const byVendor = new Map();
  for (const c of allContacts) {
    if (!byVendor.has(c.vendor_id)) byVendor.set(c.vendor_id, []);
    byVendor.get(c.vendor_id).push(c);
  }
  vendors.forEach((v) => { v.contacts = byVendor.get(v.id) || []; });

  const withReps = vendors.filter((v) => v.contacts.length).length;
  const genDate = new Date().toISOString().slice(0, 10);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; color: #2b2620; margin: 0; }
    .page { padding: 40px 44px; }
    h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 700;
         font-size: 34px; letter-spacing: .5px; margin: 0; color: #221e18; }
    .subtitle { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600;
                font-size: 22px; color: #a08a5b; margin: 2px 0 4px; }
    .meta { font-size: 11px; color: #8a8175; margin-bottom: 12px; }
    .rule { height: 3px; background: #b79a63; margin-bottom: 22px; border-radius: 2px; }
    .grid { column-count: 2; column-gap: 28px; }
    .card { break-inside: avoid; border: 1px solid #e7e0d3; border-radius: 8px;
            padding: 16px 18px; margin-bottom: 18px; background: #fffdf9; }
    .chead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .vname { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 700;
             font-size: 19px; color: #221e18; }
    .badge { background: #b79a63; color: #fff; font-size: 11px; font-weight: 600;
             padding: 2px 9px; border-radius: 5px; letter-spacing: .5px; }
    .row { display: flex; font-size: 12px; margin: 3px 0; line-height: 1.4; }
    .lbl { flex: 0 0 74px; color: #a49a89; font-size: 10px; letter-spacing: 1px;
           text-transform: uppercase; padding-top: 1px; }
    .val { flex: 1; color: #3a342b; word-break: break-word; }
    .sep { border-top: 1px dashed #d8cfbe; margin: 12px 0 10px; }
    .reps-lbl { font-size: 10px; letter-spacing: 1px; color: #a49a89; margin-bottom: 8px; }
    .contact { margin-bottom: 8px; }
    .cname { font-size: 12.5px; font-weight: 600; color: #221e18; }
    .primary { background: #ece1c6; color: #8a6d2e; font-size: 8.5px; font-weight: 600;
               padding: 1px 5px; border-radius: 3px; letter-spacing: .5px; margin-left: 5px;
               vertical-align: middle; }
    .cmeta { font-size: 11.5px; color: #7d7466; line-height: 1.4; }
    .norep { font-size: 12px; font-style: italic; color: #a49a89; }
  </style></head><body>
  <div class="page">
    <h1>ROMA FLOORING DESIGNS</h1>
    <div class="subtitle">Vendor Contact List</div>
    <div class="meta">${vendors.length} vendors &middot; ${withReps} with rep contacts &middot; Sorted by vendor code &middot; Generated ${genDate}</div>
    <div class="rule"></div>
    <div class="grid">
      ${vendors.map(vendorCard).join('')}
    </div>
  </div></body></html>`;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'networkidle0' });
  const out = process.env.OUT_PDF || path.resolve(__dirname, '../../vendor-contacts.pdf');
  await pg.pdf({ path: out, format: 'Letter', printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  await browser.close();
  await pool.end();
  console.log(`Wrote ${out} — ${vendors.length} vendors, sorted by numerical code.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
