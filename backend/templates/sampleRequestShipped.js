// Customer-facing "your samples have shipped" email, rebuilt on the shared
// "Brass Charcoal" shell (_shell.js), matching sampleRequestConfirmation.js.
// Announces the shipment, surfaces the tracking number, and lists what's inside.
import { emailShell, heroSection, section, detailList, warmCard, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';

function sampleRow(item, isLast) {
  const rowBorder = isLast ? '' : `border-bottom:1px solid ${T.border};`;
  const name = esc(item.product_name || 'Product');
  const sub = [...new Set([item.collection, item.variant_name].filter(Boolean))]
    .filter(v => v !== item.product_name).map(esc).join(' &middot; ');
  const thumb = item.primary_image
    ? `<img src="${esc(emailImage(item.primary_image, 72, 72))}" alt="${name}" width="72" style="display:block;width:72px;height:72px;object-fit:cover;" />`
    : `<div style="width:72px;height:72px;background:${T.warm};border:1px solid ${T.border};"></div>`;

  return `<tr>
    <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">${thumb}</td>
    <td valign="middle" style="padding:16px 0;${rowBorder}">
      <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${name}</p>
      ${sub ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.soft};">${sub}</p>` : ''}
    </td>
  </tr>`;
}

export function generateSampleRequestShippedHTML(data) {
  const { customer_name, request_number, tracking_number, items = [] } = data;
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const count = items.length;

  const metaBlock = section(detailList([
    { label: 'Request', value: esc(request_number) },
    count ? { label: 'In the box', value: `${count} ${count === 1 ? 'swatch' : 'swatches'}` } : null,
  ].filter(Boolean)), '4px 40px 8px');

  const trackingCard = tracking_number ? section(warmCard(`
    <p style="margin:0 0 6px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">Tracking number</p>
    <p style="margin:0;font-family:${MONO};font-size:18px;letter-spacing:0.08em;color:${T.ink};">${esc(tracking_number)}</p>
  `, '18px 22px'), '8px 40px 8px') : '';

  const itemsBlock = count ? section(`
    <p style="margin:0 0 4px;padding:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};border-bottom:2px solid ${T.ink};">Your samples</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${items.map((it, i) => sampleRow(it, i === count - 1)).join('')}
    </table>
  `, '8px 40px 20px') : '';

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      When they land, view them in your own light next to your cabinetry and trim &mdash; then reply here or call
      <span style="color:${T.ink};font-weight:500;">(714) 999-0009</span> and we&rsquo;ll help you move forward.
    </p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Sample request &middot; ${esc(request_number || '')}`,
      headline: `Your samples are <em style="color:${T.accent};">on the way</em>.`,
      body: `Hi ${esc(firstName)} &mdash; good news, your ${count ? (count === 1 ? 'swatch has' : `${count} swatches have`) : 'samples have'} shipped and should reach you shortly.`,
      chip: '&#9679; Shipped'
    })}
    ${metaBlock}
    ${trackingCard}
    ${itemsBlock}
    ${signature}
  `;

  return emailShell({
    title: `Your Roma samples shipped — ${request_number || ''}`,
    preheader: `Hi ${firstName} — your samples are on the way${tracking_number ? `. Tracking ${tracking_number}` : ''}.`,
    content
  });
}
