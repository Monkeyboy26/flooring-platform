// Vendor purchase-order email — what a vendor's order desk receives when Roma
// sends a PO. Built on the shared Brass Charcoal shell. Mirrors the design
// mockup (Vendor PO Email.html): hero with the PO number, a key-facts band,
// a first-three-lines preview (full table rides in the attached PDF), the
// approver signature, and a confidentiality note. The PO PDF is attached to
// the message; this body is the human-readable summary.
import { emailShell, heroSection, section, warmCard, T, SERIF, SANS, MONO, esc, money, emailImage } from './_shell.js';
import { composeItemName, lineQtyUnit } from '../lib/documents.js';

const PT = 'America/Los_Angeles';
const num = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;

function longDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-US', { timeZone: PT, month: 'long', day: 'numeric', year: 'numeric' });
}
function shortStamp(d) {
  if (!d) return null;
  const dt = new Date(d);
  const date = dt.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' });
  const time = dt.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase().replace(/\s*([ap])m$/, '$1');
  return `${date} &middot; ${time}`;
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'R';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// One label/value cell of the two-column key-facts band.
function factCell(label, value) {
  return `<td width="50%" valign="top" style="padding:8px 10px;">
    <div style="font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${esc(label)}</div>
    <div style="margin-top:4px;font-family:${SERIF};font-size:15px;line-height:1.2;color:${T.ink};">${value}</div>
  </td>`;
}

// Swatch face for a line: vendor image if we have one, else a warm placeholder.
function swatchCell(it) {
  const src = it.primary_image ? emailImage(it.primary_image, 52, 48) : null;
  if (src) {
    return `<img src="${esc(src)}" width="52" height="48" alt="" style="display:block;width:52px;height:48px;object-fit:cover;border:1px solid ${T.border};" />`;
  }
  return `<table role="presentation" width="52" cellpadding="0" cellspacing="0" style="width:52px;"><tr>
    <td height="48" align="center" valign="middle" style="width:52px;height:48px;background:${T.warm};border:1px solid ${T.border};font-family:${SERIF};font-size:18px;color:${T.muted};">&#9671;</td>
  </tr></table>`;
}

// A single line-preview row (swatch · sku/desc · qty/uom · cost).
function lineRow(it, isLast) {
  const ci = composeItemName(it);
  let desc = ci.nameLine;
  if ((!desc || desc === 'Product') && it.description) desc = it.description;
  desc = esc(desc || '—');
  const brand = esc(ci.vendor || it.vendor_name || '');
  const vsku = esc(it.vendor_sku || it.internal_sku || '—');
  const { text: qtyText, label: uomLabel } = lineQtyUnit(it, it.qty);
  const cost = money(num(it.cost) || num(it.subtotal));
  const sep = isLast ? '' : `border-bottom:1px solid ${T.hairline};`;
  return `<tr>
    <td width="52" valign="top" style="padding:14px 14px 14px 0;${sep}">${swatchCell(it)}</td>
    <td valign="top" style="padding:14px 0;${sep}">
      <div style="font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.04em;color:${T.ink};">${vsku}</div>
      <div style="margin-top:4px;font-family:${SERIF};font-size:14px;line-height:1.3;color:${T.ink};">${desc}</div>
      ${brand ? `<div style="margin-top:4px;font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">${brand}</div>` : ''}
    </td>
    <td width="60" valign="top" align="right" style="padding:14px 0;${sep}">
      <div style="font-family:${SERIF};font-size:14px;line-height:1;color:${T.ink};">${qtyText}</div>
      <div style="margin-top:2px;font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:${T.muted};">${esc(uomLabel)}</div>
    </td>
    <td width="84" valign="top" align="right" style="padding:14px 0 14px 14px;${sep}font-family:${SERIF};font-size:16px;line-height:1;color:${T.ink};">${cost}</td>
  </tr>`;
}

/**
 * Build the vendor PO email HTML.
 * @param {object} data
 * @param {object} data.po     - purchase_orders row (as returned by generatePOHtml)
 * @param {Array}  data.items  - purchase_order_items rows (as returned by generatePOHtml)
 * @param {string} [data.pdf_filename] - attachment filename shown in the chip
 * @param {string} [data.rep_name]  - Roma buyer/rep name (fallback for signature)
 * @param {string} [data.rep_email] - Roma buyer/rep email (fallback for signature)
 * @param {string} [data.notes]     - note to the vendor
 */
export function generateVendorPoEmailHTML(data) {
  const po = data.po || {};
  const items = Array.isArray(data.items) ? data.items : [];

  const poNumber = esc(po.po_number || 'Purchase order');
  const revision = num(po.revision) || 0;
  const isRevised = !!po.is_revised || revision > 1;
  const customerRef = po.order_number ? esc(po.order_number) : null;
  const expected = longDate(po.expected_delivery);
  const subtotal = num(po.subtotal);
  const lineCount = items.length;
  const vendorName = esc(po.vendor_name || 'there');
  const vendorFirst = esc((po.vendor_name || '').trim().split(/\s+/)[0] || 'there');

  const buyerName = po.buyer_name || po.approved_by_name || data.rep_name || '';
  const buyerEmail = po.buyer_email || po.approver_email || data.rep_email || 'Sales@romaflooringdesigns.com';
  const approverName = po.approved_by_name || po.buyer_name || data.rep_name || '';
  const approvedStamp = shortStamp(po.approved_at);

  const pdfName = esc(data.pdf_filename || `${po.po_number || 'PO'}.pdf`);
  const notes = (data.notes ?? po.notes ?? '').toString().trim();

  // ── Hero copy ──────────────────────────────────────────────────────────
  const heroBody = `Hi ${vendorFirst} &mdash; Roma is placing ${isRevised ? 'a <em style="color:' + T.accent + ';">revised</em> ' : 'a new '}purchase order with ${vendorName} today. `
    + `${lineCount} line${lineCount === 1 ? '' : 's'}${subtotal ? `, ${money(subtotal)} subtotal` : ''}`
    + `${expected ? `, expected at our Anaheim warehouse by ${esc(expected)}` : ''}. `
    + `The full PO is attached as a PDF; the key facts are below.`;

  // ── Key facts band (2-col) ────────────────────────────────────────────
  const facts = [
    ['PO #', poNumber],
    ['Revision', `Rev ${revision}`],
    customerRef ? ['Customer ref', customerRef] : null,
    ['Expected at Roma', expected ? esc(expected) : 'To be confirmed'],
    ['Lines', `${lineCount} &middot; materials`],
    ['Subtotal', `${money(subtotal)} USD`],
  ].filter(Boolean);
  const factRows = [];
  for (let i = 0; i < facts.length; i += 2) {
    factRows.push(`<tr>${factCell(facts[i][0], facts[i][1])}${facts[i + 1] ? factCell(facts[i + 1][0], facts[i + 1][1]) : '<td width="50%"></td>'}</tr>`);
  }
  const factsBand = section(warmCard(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRows.join('')}</table>`,
    '10px 12px'
  ), '8px 40px 8px');

  // ── Line preview (first 3; rest in the PDF) ──────────────────────────
  const previewItems = items.slice(0, 3);
  const remaining = lineCount - previewItems.length;
  const linePreview = lineCount ? section(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 10px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">Line preview &middot; ${lineCount}</td>
        <td align="right" style="padding:0 0 10px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">Full table in attached PDF</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${previewItems.map((it, i) => lineRow(it, i === previewItems.length - 1 && remaining <= 0)).join('')}
    </table>
    ${remaining > 0 ? `<p style="margin:14px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.muted};">+ ${remaining} more line${remaining === 1 ? '' : 's'} in the attached PO PDF.</p>` : ''}
  `, '24px 40px 12px') : '';

  // ── Note to vendor ────────────────────────────────────────────────────
  const notesBlock = notes ? section(warmCard(`
    <p style="margin:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};">Note to vendor</p>
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};white-space:pre-wrap;">${esc(notes)}</p>
  `, '18px 22px'), '8px 40px 8px') : '';

  // ── Approver / buyer signature ────────────────────────────────────────
  const signature = approverName ? section(warmCard(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="44" valign="top" style="padding:0 14px 0 0;">
        <table role="presentation" width="44" cellpadding="0" cellspacing="0"><tr>
          <td height="44" align="center" valign="middle" style="width:44px;height:44px;background:${T.accent};border-radius:50%;font-family:${SERIF};font-size:15px;color:${T.paper};">${esc(initials(approverName))}</td>
        </tr></table>
      </td>
      <td valign="top">
        <div style="font-family:${SERIF};font-size:16px;line-height:1.2;color:${T.ink};">${esc(approverName)}</div>
        <div style="margin-top:4px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Roma purchasing${approvedStamp ? ` &middot; approved ${approvedStamp}` : ''}</div>
        ${buyerName ? `<div style="margin-top:6px;font-family:${SANS};font-size:13px;line-height:1.4;color:${T.body};">Buyer &middot; ${esc(buyerName)} &middot; <a href="mailto:${esc(buyerEmail)}" style="color:${T.body};text-decoration:none;">${esc(buyerEmail)}</a> &middot; (714) 999-0009</div>` : ''}
      </td>
    </tr></table>
  `, '16px 18px'), '16px 40px 8px') : '';

  // ── Confidentiality note ──────────────────────────────────────────────
  const confidential = section(`
    <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.5;color:${T.muted};">
      Confidential &mdash; this message and the attached purchase order are intended for ${vendorName} only.
      If you received it in error, please reply so we can correct our records, and delete the message.
    </p>
  `, '16px 40px 32px');

  const content = `
    ${heroSection({
      eyebrow: `${isRevised ? 'Revised purchase order' : 'New purchase order'} &middot; Rev ${revision}`,
      headline: poNumber,
      body: heroBody,
      chip: `&#128206; ${pdfName}`,
    })}
    ${factsBand}
    ${linePreview}
    ${notesBlock}
    ${signature}
    ${confidential}
  `;

  return emailShell({
    title: `${isRevised ? 'Revised ' : ''}Purchase Order ${po.po_number || ''} — Roma Flooring Designs`,
    preheader: `${isRevised ? 'Revised PO' : 'New PO'} ${po.po_number || ''}${lineCount ? ` · ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}${subtotal ? ` · ${money(subtotal)}` : ''}${expected ? ` · expected ${expected}` : ''}. PDF attached.`,
    content,
  });
}
