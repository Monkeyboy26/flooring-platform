// Sample request sent to a vendor. Two artifacts, both on the current Roma
// design language:
//   - generateSampleRequestVendorHTML(data) → the PDF (editorial "Roma
//     letterhead", matching generateQuoteHtml/generatePOHtml in lib/documents.js:
//     serif wordmark, mono uppercase labels, grid line items, brass accents).
//   - generateSampleRequestVendorEmailHTML(data) → the covering email, built on
//     the shared "Brass Charcoal" shell (_shell.js), matching estimateSent.js et al.
import { emailShell, heroSection, section, sectionLabel, detailList, warmCard, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { composeItemName } from '../lib/documents.js';

const COMPANY = {
  name: 'Roma Flooring Designs',
  addr: '1440 S. State College Blvd #6M, Anaheim, CA 92806',
  phone: '(714) 999-0009',
  email: 'Sales@romaflooringdesigns.com',
  license: 'License #830966'
};

function shipToLinesArr(ship_to) {
  const lines = [];
  if (!ship_to) return lines;
  if (ship_to.name) lines.push(esc(ship_to.name));
  if (ship_to.line1) lines.push(esc(ship_to.line1));
  if (ship_to.line2) lines.push(esc(ship_to.line2));
  const cityParts = [ship_to.city, ship_to.state].filter(Boolean).join(', ');
  if (cityParts && ship_to.zip) lines.push(`${esc(cityParts)} ${esc(ship_to.zip)}`);
  else if (cityParts) lines.push(esc(cityParts));
  else if (ship_to.zip) lines.push(esc(ship_to.zip));
  return lines;
}

/**
 * PDF document — editorial Roma letterhead. Attached to the vendor email.
 *
 * @param {Object} data
 * @param {string} data.vendor_name
 * @param {string} data.request_number
 * @param {string} data.customer_name
 * @param {string} [data.rep_name]
 * @param {string} [data.notes] - request-level notes
 * @param {Object} data.ship_to - { name, line1, line2?, city, state, zip }
 * @param {Array}  data.items - [{ product_name, collection?, variant_name?, sku_code?, notes? }]
 */
export function generateSampleRequestVendorHTML(data) {
  const { vendor_name, request_number, customer_name, rep_name, notes, ship_to, items = [] } = data;
  const issued = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];
  const rowsHtml = items.map((item, idx) => {
    const _ci = composeItemName(item);
    const name = esc(_ci.title || 'Product');
    const sub = _ci.descriptors.map(esc).join(' &middot; ');
    const skuCode = item.sku_code ? esc(item.sku_code) : '';
    const itemNotes = item.notes ? esc(item.notes) : '—';
    const isLast = idx === items.length - 1;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = item.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(item.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;border-bottom:${isLast ? 'none' : '1px solid #1c191711'};">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${sub ? ` <span style="color:var(--muted);font-weight:400;">&middot; ${sub}</span>` : ''}</div>
        ${skuCode ? `<div style="font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.04em;color:#1c191799;margin-top:3px;">${skuCode}</div>` : ''}
      </div>
      <div class="num">1<div class="numsub">sample</div></div>
      <div style="font:400 10px/1.5 var(--sans);color:#1c1917cc;">${itemNotes}</div>
    </div>`;
  }).join('');

  const shipLines = shipToLinesArr(ship_to);
  const shipHtml = shipLines.length
    ? `<div style="font:500 11px/1.2 var(--sans);">${shipLines[0]}</div>` +
      (shipLines.length > 1 ? `<div class="small" style="margin-top:4px;">${shipLines.slice(1).join('<br />')}</div>` : '')
    : '<div class="small">Not specified</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&family=Pinyon+Script&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 54px 168px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;min-height:9.5in;">

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;padding-bottom:0.34em;">
<span style="font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:0.34em;text-indent:0.34em;color:var(--ink);white-space:nowrap;">ROMA <em style="font-style:normal;font-size:1em;letter-spacing:normal;text-indent:0;color:var(--ink);">FLOORING</em></span>
<span style="font-family:'Pinyon Script','Cormorant Garamond',cursive;font-size:35px;line-height:1;color:var(--accent);margin-top:-11px;white-space:nowrap;">Designs</span>
</div>
<div class="small" style="margin-top:14px;">${COMPANY.name}, Inc.<br />${COMPANY.addr}<br />${COMPANY.phone} &middot; ${COMPANY.email}<br />${COMPANY.license}</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Sample Request</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${esc(request_number)}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
${rep_name ? `<span style="color:var(--muted);">Prepared by</span><span style="text-align:right;">${esc(rep_name)}</span>` : ''}
</div>
<div style="margin-top:16px;display:flex;justify-content:flex-end;">
<span style="padding:7px 14px;border:1.5px solid var(--accent);color:var(--accent);font:500 11px/1 ui-monospace,monospace;letter-spacing:0.3em;text-transform:uppercase;transform:rotate(-2deg);white-space:nowrap;">Samples</span>
</div>
</div>
</div>

<div class="keep" style="padding:14px 0;border-bottom:1px solid #1c191711;font:400 10px/1.6 var(--sans);color:#1c1917cc;">
${esc(vendor_name)} — please send <strong style="color:var(--ink);font-weight:500;">one sample of each item below</strong>${customer_name ? ` for our customer, <strong style="color:var(--ink);font-weight:500;">${esc(customer_name)}</strong>` : ''}. Ship to the address below at your earliest convenience.
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Vendor</div>
<div style="font:500 11px/1.2 var(--sans);">${esc(vendor_name)}</div>
</div>
<div>
<div class="mono" style="margin-bottom:8px;">Ship to</div>
${shipHtml}
</div>
<div>
<div class="mono" style="margin-bottom:8px;">Requested by</div>
<div style="font:500 11px/1.2 var(--sans);">${COMPANY.name}</div>
<div class="small" style="margin-top:4px;">${rep_name ? `<span style="color:var(--muted);">Sales rep</span><br />${esc(rep_name)}<br />` : ''}${customer_name ? `<span style="color:var(--muted);">For customer</span><br />${esc(customer_name)}` : ''}</div>
</div>
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Product</span><span style="text-align:right;">Qty</span><span>Notes</span>
</div>
${rowsHtml || '<div class="small" style="padding:16px 0;">No items on this request.</div>'}
</div>

${notes ? `<div class="keep" style="margin-top:16px;padding-top:14px;border-top:1px solid #1c191722;">
<div class="mono" style="margin-bottom:8px;">Notes</div>
<div class="small" style="white-space:pre-wrap;">${esc(notes)}</div>
</div>` : ''}

<div style="flex:1 1 auto;min-height:20px;"></div>

<div style="margin-top:auto;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>${COMPANY.name}, Inc. &middot; ${COMPANY.addr} &middot; ${COMPANY.license}</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Sample Request ${esc(request_number)}</span>
</div>

</div>
</body>
</html>`;
}

/**
 * Covering email — Brass Charcoal shell. The full itemized request rides along
 * as the attached PDF; the email is the short, on-brand note that frames it.
 *
 * @param {Object} data
 * @param {string} data.vendor_name
 * @param {string} data.request_number
 * @param {string} [data.customer_name]
 * @param {string} [data.rep_name]
 * @param {number} [data.item_count]
 * @param {Object} [data.ship_to] - { name, line1, line2?, city, state, zip }
 */
export function generateSampleRequestVendorEmailHTML(data) {
  const { vendor_name, request_number, rep_name, item_count, ship_to } = data;
  const vendorFirst = (vendor_name || '').trim().split(/\s+/)[0] || 'there';
  const shipLines = shipToLinesArr(ship_to);

  const metaBlock = section(detailList([
    { label: 'Request', value: esc(request_number) },
    item_count ? { label: 'Samples', value: `${item_count} ${item_count === 1 ? 'item' : 'items'} &middot; one each` } : null,
    rep_name ? { label: 'Requested by', value: esc(rep_name) } : null,
    shipLines.length ? { label: 'Ship to', value: shipLines.join('<br>') } : null,
  ].filter(Boolean)), '4px 40px 8px');

  const noteBlock = section(warmCard(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      The full itemized request — products, vendor SKUs, and quantities — is attached as a PDF.
      Please send one sample of each to the address above at your earliest convenience.
    </p>
  `, '18px 22px'), '8px 40px 8px');

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions? Reply to this email or call the showroom at
      <span style="color:${T.ink};font-weight:500;">${COMPANY.phone}</span>. Thank you!
    </p>
    <p style="margin:16px 0 0;font-family:${SERIF};font-size:16px;line-height:1.2;color:${T.ink};">${esc(rep_name) || 'The Roma team'}</p>
    <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Roma Flooring &middot; Anaheim showroom</p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Sample request &middot; ${esc(request_number || '')}`,
      headline: `A sample <em style="color:${T.accent};">request</em>.`,
      body: `Hi ${esc(vendorFirst)} &mdash; we're requesting product samples for one of our customers. Details below and in the attached PDF.`
    })}
    ${metaBlock}
    ${noteBlock}
    ${signature}
  `;

  return emailShell({
    title: `Sample request — ${request_number || ''}`,
    preheader: `We're requesting${item_count ? ' ' + item_count : ''} product sample${item_count === 1 ? '' : 's'} — full details attached (${request_number || ''}).`,
    content
  });
}
