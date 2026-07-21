import { emailShell, heroSection, section, sectionLabel, ctaButton, warmCard, money, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Rep-initiated "pay your balance" email. Matches the Brass Charcoal house
// style (see orderConfirmation.js). Renders the full order line items, a
// totals breakdown ending in the outstanding balance, an optional message
// from the rep, and a Stripe checkout CTA. A PDF invoice is attached by the
// caller (sendPaymentRequest) — the copy references it.
export function generatePaymentRequestHTML({ order, items = [], balance, checkout_url, message, expires_at }) {
  const {
    order_number, created_at, customer_name,
    subtotal, shipping, tax_amount, discount_amount, total, amount_paid
  } = order;

  const orderDate = created_at
    ? new Date(created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  const balanceDue = parseFloat(balance || 0);
  const paid = parseFloat(amount_paid || 0);

  // Render the real expiry from the payment_requests row so the copy stays
  // accurate regardless of the 24h/72h window the sending endpoint used.
  const expiryNote = expires_at
    ? `This secure payment link expires ${new Date(expires_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`
    : 'This secure payment link is time-limited — please complete payment soon.';

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

  const itemsSection = items.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding-bottom:12px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">In your order</td>
        <td align="right" style="padding-bottom:12px;border-bottom:1px solid ${T.border};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">${items.length} item${items.length === 1 ? '' : 's'}</td>
      </tr>
      ${itemRows}
    </table>` : '';

  // Minor totals rows (subtotal / shipping / tax / discount) — only shown when non-zero.
  const minorRow = (label, value, opts = {}) => `<tr>
      <td style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.body};">${label}</td>
      <td align="right" style="padding:6px 0;font-family:${SANS};font-size:14px;color:${opts.color || T.ink};">${value}</td>
    </tr>`;

  const minorRows = [minorRow('Subtotal', money(subtotal))];
  if (parseFloat(shipping || 0) > 0) minorRows.push(minorRow('Shipping', money(shipping)));
  if (parseFloat(tax_amount || 0) > 0) minorRows.push(minorRow('Tax', money(tax_amount)));
  if (parseFloat(discount_amount || 0) > 0) minorRows.push(minorRow('Discount', '&minus;' + money(discount_amount), { color: '#2f7a3f' }));

  const totalsSection = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${minorRows.join('')}
      <tr>
        <td style="padding:10px 0 6px;border-top:1px solid ${T.border};font-family:${SANS};font-size:14px;color:${T.body};">Total</td>
        <td align="right" style="padding:10px 0 6px;border-top:1px solid ${T.border};font-family:${SANS};font-size:14px;color:${T.ink};">${money(total)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.body};">Amount paid</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:14px;color:${T.ink};">${paid > 0 ? '&minus;' + money(paid) : money(0)}</td>
      </tr>
      <tr>
        <td style="padding:14px 0 0;border-top:2px solid ${T.ink};font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.accent};">Balance due</td>
        <td align="right" style="padding:14px 0 0;border-top:2px solid ${T.ink};font-family:${SERIF};font-size:28px;font-weight:400;letter-spacing:-0.01em;color:${T.ink};">${money(balanceDue)}</td>
      </tr>
    </table>`;

  const messageSection = message ? `
    ${sectionLabel('A note from your rep')}
    ${warmCard(`<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${esc(message).replace(/\n/g, '<br>')}</p>`)}` : '';

  const content = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; Balance due`,
      headline: 'A balance is <em style="font-style:italic;">due</em>.',
      body: `${firstName} &mdash; there's an outstanding balance of ${money(balanceDue)} on your order. Everything on file is below, and you can settle it securely in a couple of clicks.`,
      chip: `Balance due &middot; ${money(balanceDue)}`
    }),
    itemsSection ? section(itemsSection, '8px 40px 24px') : '',
    section(totalsSection, '0 40px 28px'),
    message ? section(messageSection) : '',
    ctaButton({
      href: checkout_url,
      label: `Pay now &middot; ${money(balanceDue)} &rarr;`,
      note: `${expiryNote} A PDF copy of your invoice is attached to this email. Questions? Reply here or call (714) 999-0009 &mdash; it reaches our showroom team in Anaheim.`
    })
  ].join('');

  return emailShell({
    title: `Payment Required — Order ${order_number}`,
    preheader: `A balance of ${money(balanceDue)} is due on order ${order_number}. Pay securely in a couple of clicks.`,
    content
  });
}
