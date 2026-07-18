import { emailShell, heroSection, section, sectionLabel, ctaButton, detailList, money, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

export function generateOrderConfirmationHTML(orderData) {
  const {
    order_number, created_at, customer_name,
    shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
    delivery_method, subtotal, shipping, sample_shipping, total, items = []
  } = orderData;

  const orderDate = new Date(created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const isPickup = delivery_method === 'pickup';
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');

  const itemRows = items.map((item, i) => {
    const isSample = item.is_sample;
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const qty = isSample
      ? `${item.num_boxes} sample${item.num_boxes > 1 ? 's' : ''}`
      : item.sell_by === 'unit' ? `${item.num_boxes}` : `${item.num_boxes} box${item.num_boxes > 1 ? 'es' : ''}`;
    const price = isSample ? 'Free' : money(item.subtotal);
    const sampleBadge = isSample
      ? ` <span style="display:inline-block;padding:2px 7px;background:${T.warm};border:1px solid ${T.border};font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.ink};vertical-align:2px;">Sample</span>`
      : '';

    return `<tr>
      <td style="padding:14px 14px 14px 0;${i < items.length - 1 ? `border-bottom:1px solid ${T.border};` : ''}">
        ${collection ? `<p style="margin:0 0 3px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${collection}</p>` : ''}
        <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.2;letter-spacing:-0.01em;color:${T.ink};">${name}${sampleBadge}</p>
        <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">${qty}</p>
      </td>
      <td align="right" valign="middle" style="padding:14px 0;${i < items.length - 1 ? `border-bottom:1px solid ${T.border};` : ''}font-family:${SERIF};font-size:20px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};white-space:nowrap;">${price}</td>
    </tr>`;
  }).join('');

  const itemsSection = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding-bottom:12px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">In your order</td>
        <td align="right" style="padding-bottom:12px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">${items.length} item${items.length === 1 ? '' : 's'}</td>
      </tr>
      ${itemRows}
    </table>`;

  const addressValue = isPickup
    ? `Roma Flooring Designs<br>1440 S. State College Blvd #6M, Anaheim, CA 92806<br><span style="color:${T.soft};">Mon&ndash;Fri 8am&ndash;5pm &middot; Sat 9am&ndash;2pm &middot; bring a photo ID</span>`
    : `${esc(shipping_address_line1)}${shipping_address_line2 ? `<br>${esc(shipping_address_line2)}` : ''}<br>${esc(shipping_city)}, ${esc(shipping_state)} ${esc(shipping_zip)}`;

  const orderDetails = detailList([
    { label: 'Order number', value: esc(order_number) },
    { label: 'Placed', value: orderDate },
    { label: isPickup ? 'Pickup at' : 'Ships to', value: addressValue }
  ]);

  const shippingTotal = parseFloat(shipping || 0) + parseFloat(sample_shipping || 0);
  const totalsSection = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.body};">Subtotal</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.ink};">${money(subtotal)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.body};">Shipping</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.ink};">${shippingTotal > 0 ? money(shippingTotal) : 'Free'}</td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;border-top:2px solid ${T.ink};font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.ink};">Total</td>
        <td align="right" style="padding:12px 0 0;border-top:2px solid ${T.ink};font-family:${SERIF};font-size:24px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(total)}</td>
      </tr>
    </table>`;

  const nextSteps = isPickup
    ? [
        { d: 'Now', t: 'Order confirmed', s: 'Our team is pulling your materials.' },
        { d: 'Next', t: 'Ready-for-pickup email', s: 'We’ll let you know the moment it’s staged.' },
        { d: 'Then', t: 'Pick up in Anaheim', s: 'Bring a photo ID · we’ll load your vehicle.' }
      ]
    : [
        { d: 'Now', t: 'Order confirmed', s: 'Our team is pulling your materials.' },
        { d: 'Next', t: 'Shipping notification', s: 'You’ll get tracking the moment it leaves the warehouse.' },
        { d: 'Then', t: 'Inspect on arrival', s: 'Check the boxes and report any damage within 48 hours.' }
      ];

  const nextSection = `
    ${sectionLabel('What happens next')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${nextSteps.map((s, i) => `<tr>
        <td width="90" valign="top" style="padding:12px 14px 12px 0;${i < nextSteps.length - 1 ? `border-bottom:1px solid ${T.hairline};` : ''}font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.accent};">${s.d}</td>
        <td valign="top" style="padding:12px 0;${i < nextSteps.length - 1 ? `border-bottom:1px solid ${T.hairline};` : ''}">
          <p style="margin:0;font-family:${SERIF};font-size:15px;line-height:1.2;letter-spacing:-0.008em;color:${T.ink};">${s.t}</p>
          <p style="margin:3px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.muted};">${s.s}</p>
        </td>
      </tr>`).join('')}
    </table>`;

  const content = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; Confirmed`,
      headline: 'We’ve <em style="font-style:italic;">got it</em>.',
      body: `${firstName} &mdash; thank you. Your order is in and our team is getting it ready. Everything we have on file is below; reply to this email if anything looks off.`,
      chip: `&#10003; Total &middot; ${money(total)}`
    }),
    section(itemsSection, '8px 40px 24px'),
    section(orderDetails),
    section(totalsSection, '0 40px 28px'),
    section(nextSection, '0 40px 28px'),
    ctaButton({
      href: `${SITE_URL}/account`,
      label: 'View your order &rarr;',
      note: 'Questions? Reply to this email or call (714) 999-0009 &mdash; it reaches our showroom team in Anaheim.'
    })
  ].join('');

  return emailShell({
    title: `Order Confirmed — ${order_number}`,
    preheader: `Order ${order_number} is confirmed — ${money(total)}. Here's what happens next.`,
    content
  });
}
