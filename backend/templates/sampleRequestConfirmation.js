// Customer-facing "we got your sample request" email, rebuilt on the shared
// "Brass Charcoal" shell (_shell.js), matching estimateSent.js / quoteSent.js.
// Confirms the request, lists the samples with swatches, and sets shipping vs
// pickup expectations.
import { emailShell, heroSection, section, detailList, warmCard, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';
import { composeItemName } from '../lib/documents.js';

function sampleRow(item, isLast) {
  const rowBorder = isLast ? '' : `border-bottom:1px solid ${T.border};`;
  const _ci = composeItemName(item);
  const name = esc(_ci.title || 'Product');
  const sub = _ci.descriptors.map(esc).join(' &middot; ');
  const thumb = item.primary_image
    ? `<img src="${esc(emailImage(item.primary_image, 72, 72))}" alt="${name}" width="72" style="display:block;width:72px;height:72px;object-fit:cover;" />`
    : `<div style="width:72px;height:72px;background:${T.warm};border:1px solid ${T.border};"></div>`;

  return `<tr>
    <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">${thumb}</td>
    <td valign="middle" style="padding:16px 0;${rowBorder}">
      <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${name}</p>
      ${sub ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.soft};">${sub}</p>` : ''}
    </td>
    <td valign="middle" align="right" style="padding:16px 0 16px 12px;${rowBorder}white-space:nowrap;">
      <p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.accent};">Free sample</p>
    </td>
  </tr>`;
}

export function generateSampleRequestConfirmationHTML(data) {
  const {
    customer_name, request_number, delivery_method, items = [], sidemark,
    shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip
  } = data;
  const isPickup = delivery_method === 'pickup';
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const count = items.length;

  const shipParts = [shipping_address_line1, shipping_address_line2].filter(Boolean);
  const cityLine = [shipping_city, shipping_state].filter(Boolean).join(', ');
  if (shipping_zip && cityLine) shipParts.push(cityLine + ' ' + shipping_zip);
  else if (cityLine) shipParts.push(cityLine);
  else if (shipping_zip) shipParts.push(shipping_zip);

  const metaBlock = section(detailList([
    { label: 'Request', value: esc(request_number) },
    sidemark ? { label: 'Sidemark', value: esc(sidemark) } : null,
    count ? { label: 'Samples', value: `${count} ${count === 1 ? 'swatch' : 'swatches'} &middot; free` } : null,
    { label: isPickup ? 'Pickup' : 'Shipping to', value: isPickup
      ? 'Anaheim showroom'
      : (shipParts.length ? shipParts.map(esc).join('<br>') : 'Address on file') },
  ].filter(Boolean)), '4px 40px 8px');

  const itemsBlock = count ? section(`
    <p style="margin:0 0 4px;padding:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};border-bottom:2px solid ${T.ink};">Samples requested</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${items.map((it, i) => sampleRow(it, i === count - 1)).join('')}
    </table>
  `, '8px 40px 20px') : '';

  const noteBlock = section(warmCard(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${isPickup
      ? `Free in-store pickup at our Anaheim showroom &mdash; we&rsquo;ll email you the moment your swatches are ready to grab.`
      : `Your swatches ship for a flat <span style="color:${T.ink};font-weight:500;">$12</span>. The samples themselves are free &mdash; you&rsquo;re only covering delivery.`}</p>
  `, '18px 22px'), '8px 40px 8px');

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Once your samples arrive, hold them against your lighting and existing finishes &mdash; then reply here or call
      <span style="color:${T.ink};font-weight:500;">(714) 999-0009</span> and we&rsquo;ll help you take the next step.
    </p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Sample request &middot; ${esc(request_number || '')}`,
      headline: `Your samples are <em style="color:${T.accent};">reserved</em>.`,
      body: `Hi ${esc(firstName)} &mdash; thanks for your request. We&rsquo;ve got your ${count ? (count === 1 ? 'swatch' : `${count} swatches`) : 'samples'} lined up and we&rsquo;re preparing ${isPickup ? 'them for pickup' : 'them to ship'}.`,
      chip: isPickup ? '&#9679; Free showroom pickup' : '&#9679; Ships flat $12'
    })}
    ${metaBlock}
    ${itemsBlock}
    ${noteBlock}
    ${signature}
  `;

  return emailShell({
    title: `Your Roma sample request — ${request_number || ''}`,
    preheader: `Hi ${firstName} — we've received your sample request${count ? ` (${count} ${count === 1 ? 'swatch' : 'swatches'})` : ''}. ${isPickup ? 'Free showroom pickup.' : 'Ships flat $12.'}`,
    content
  });
}
