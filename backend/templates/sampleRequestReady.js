// Customer-facing "your samples are ready" email, on the shared "Brass Charcoal"
// shell (_shell.js), matching sampleRequestConfirmation.js / sampleRequestShipped.js.
// Fires once when every sample on the request has been marked ready. Copy adapts
// to the fulfilment method: showroom pickup vs. an incoming shipment.
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
  </tr>`;
}

export function generateSampleRequestReadyHTML(data) {
  const { customer_name, request_number, delivery_method, items = [] } = data;
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const count = items.length;
  const isPickup = delivery_method === 'pickup';
  const swatchWord = count === 1 ? 'swatch' : 'swatches';

  const metaBlock = section(detailList([
    { label: 'Request', value: esc(request_number) },
    count ? { label: 'Ready', value: `${count} ${swatchWord}` } : null,
    { label: isPickup ? 'Pickup' : 'Delivery', value: isPickup ? 'Anaheim showroom' : 'Ships to you' },
  ].filter(Boolean)), '4px 40px 8px');

  // Pickup → where/when to collect. Shipping → reassurance that tracking follows.
  const infoCard = isPickup ? section(warmCard(`
    <p style="margin:0 0 6px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">Pick up at</p>
    <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.3;color:${T.ink};">Roma Flooring Designs</p>
    <p style="margin:4px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${T.body};">1440 S. State College Blvd #6M, Anaheim, CA 92806<br>Mon&ndash;Fri 9am&ndash;5pm &middot; Sat 10am&ndash;5pm</p>
  `, '18px 22px'), '8px 40px 8px') : section(warmCard(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Every swatch is in and we&rsquo;re packing them now. We&rsquo;ll email your tracking number the moment they ship.
    </p>
  `, '18px 22px'), '8px 40px 8px');

  const itemsBlock = count ? section(`
    <p style="margin:0 0 4px;padding:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};border-bottom:2px solid ${T.ink};">Your samples</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${items.map((it, i) => sampleRow(it, i === count - 1)).join('')}
    </table>
  `, '8px 40px 20px') : '';

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      ${isPickup
        ? 'See a swatch you love? Reply here or call'
        : 'Once they arrive, view them in your own light next to your cabinetry and trim &mdash; then reply here or call'}
      <span style="color:${T.ink};font-weight:500;">(714) 999-0009</span> and we&rsquo;ll help you take the next step.
    </p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Sample request &middot; ${esc(request_number || '')}`,
      headline: isPickup
        ? `Your samples are <em style="color:${T.accent};">ready to collect</em>.`
        : `Your samples are <em style="color:${T.accent};">ready</em>.`,
      body: isPickup
        ? `Hi ${esc(firstName)} &mdash; ${count === 1 ? 'your swatch is' : `all ${count} of your ${swatchWord} are`} in and waiting for you at our Anaheim showroom. Come by whenever suits you.`
        : `Hi ${esc(firstName)} &mdash; ${count === 1 ? 'your swatch is' : `all ${count} of your ${swatchWord} are`} in and being prepared to ship. You&rsquo;ll have tracking shortly.`,
      chip: '&#9679; Ready'
    })}
    ${metaBlock}
    ${infoCard}
    ${itemsBlock}
    ${signature}
  `;

  return emailShell({
    title: `Your Roma samples are ready — ${request_number || ''}`,
    preheader: isPickup
      ? `Hi ${firstName} — your samples are ready to pick up at our Anaheim showroom.`
      : `Hi ${firstName} — your samples are ready and being prepared to ship.`,
    content
  });
}
