import { emailShell, heroSection, section, ctaButton, money, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';

const PT_DATE = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' };

function basisLabel(basis) {
  return basis === 'per_sqft' ? '/sqft' : basis === 'per_unit' ? '/ea' : '';
}

export function generateVisitRecapHTML(visitData) {
  const {
    customer_name, message, rep_name, rep_email, rep_phone,
    items = [], recap_url, visited_at, expires_at
  } = visitData;

  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  const repFirst = esc((rep_name || '').trim().split(/\s+/)[0] || 'your rep');
  const repInitials = esc((rep_name || '').trim().split(/\s+/).map(w => w[0]).join('').substring(0, 2).toUpperCase() || 'RF');
  const visitDate = visited_at ? new Date(visited_at).toLocaleDateString('en-US', PT_DATE) : null;

  const itemRows = items.map((item, i) => {
    const name = esc(item.product_name || 'Product');
    const variant = item.variant_name ? esc(item.variant_name) : '';
    const collection = item.collection ? esc(item.collection) : '';
    const note = item.rep_note ? esc(item.rep_note) : '';
    const price = item.retail_price
      ? `${money(item.retail_price)}<span style="font-size:12px;color:${T.muted};">${basisLabel(item.price_basis)}</span>`
      : '';
    const rowBorder = i < items.length - 1 ? `border-bottom:1px solid ${T.hairline};` : '';
    const thumb = item.primary_image
      ? `<img src="${esc(emailImage(item.primary_image, 72, 56))}" alt="${name}" width="72" style="display:block;width:72px;height:auto;" />`
      : `<div style="width:72px;height:56px;background:${T.warm};border:1px solid ${T.border};"></div>`;

    return `<tr>
      <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">${thumb}</td>
      <td valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">
        <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.15;letter-spacing:-0.008em;color:${T.ink};">${name}${variant ? ` &middot; ${variant}` : ''}</p>
        <p style="margin:3px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.muted};">${[collection, note ? `<span style="color:${T.accent};">${note}</span>` : ''].filter(Boolean).join(' &middot; ')}</p>
      </td>
      <td align="right" valign="middle" style="padding:16px 0;${rowBorder}font-family:${SERIF};font-size:14px;color:${T.ink};white-space:nowrap;">${price}</td>
    </tr>`;
  }).join('');

  const productsSection = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="3" style="padding-bottom:12px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">What you viewed &middot; ${items.length} material${items.length === 1 ? '' : 's'}</td></tr>
      ${itemRows}
    </table>`;

  const expiresDate = expires_at ? new Date(expires_at).toLocaleDateString('en-US', PT_DATE) : null;
  const daysLive = expires_at
    ? Math.max(1, Math.round((new Date(expires_at) - Date.now()) / 86400000))
    : 14;
  const savedBand = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.warm};border:1px solid ${T.border};">
      <tr>
        <td valign="middle" style="padding:16px 20px;">
          <p style="margin:0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.ink};">Your recap is saved online</p>
          <p style="margin:5px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${T.body};">Every material and note from your visit${expiresDate ? ` &mdash; the link stays live through ${expiresDate}` : ''}. Add to your cart or order samples any time.</p>
        </td>
        <td align="right" valign="middle" style="padding:16px 20px 16px 0;font-family:${SERIF};font-size:30px;font-weight:300;color:${T.accent};white-space:nowrap;">${daysLive} days</td>
      </tr>
    </table>`;

  const quoteUrl = recap_url ? `${recap_url}${recap_url.includes('?') ? '&' : '?'}ask=quote` : `mailto:${rep_email || 'Sales@romaflooringdesigns.com'}`;
  const secondaryCta = `
    <a href="${esc(quoteUrl)}" target="_blank" style="display:block;padding:16px 28px;border:1px solid ${T.ink};color:${T.ink};font-family:${SANS};font-size:13px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;text-align:center;">Ask ${repFirst} for a quote</a>`;

  const messageSection = message ? section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.65;color:${T.body};">&ldquo;${esc(message)}&rdquo;</p>`, '0 40px 8px') : '';

  const repSignature = `
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr>
        <td valign="middle" style="padding:16px 14px 16px 0;">
          <div style="width:44px;height:44px;border-radius:50%;background:${T.warm};border:1px solid ${T.border};font-family:${SERIF};font-size:16px;line-height:44px;text-align:center;color:${T.ink};">${repInitials}</div>
        </td>
        <td valign="middle" style="padding:16px 0;">
          <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.1;color:${T.ink};">${esc(rep_name || 'Roma Flooring Designs')}</p>
          <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Your showroom rep &middot; ${esc(rep_phone || '(714) 999-0009')}</p>
        </td>
      </tr>
    </table>`;

  const content = [
    heroSection({
      eyebrow: 'After your visit',
      headline: `Good to see you, <em style="font-style:italic;">${firstName}</em>.`,
      body: `Thanks for spending time with us at the showroom. Here's everything you looked at with ${repFirst} &mdash; every material and note, saved in one place so nothing lives on a paper swatch card.`,
      chip: visitDate ? `Visited ${visitDate} &middot; with ${repFirst}` : `Prepared by ${repFirst}`
    }),
    section(productsSection, '0 40px 8px'),
    section(savedBand, '20px 40px 0'),
    ctaButton({ href: recap_url, label: 'View your recap &rarr;' }),
    section(secondaryCta, '0 40px 8px'),
    messageSection,
    section(repSignature, '4px 40px 28px')
  ].join('');

  return emailShell({
    title: 'Your Showroom Visit — Roma Flooring Designs',
    preheader: `Everything you viewed at the showroom — ${items.length} material${items.length === 1 ? '' : 's'} with ${repFirst}'s notes, saved in one place.`,
    content
  });
}
