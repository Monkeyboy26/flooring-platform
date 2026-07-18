import { emailShell, heroSection, section, ctaButton, detailList, warmCard, T, SERIF, SANS, MONO, esc } from './_shell.js';

function getTrackingUrl(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c === 'ups') return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(trackingNumber);
  if (c === 'fedex' || c === 'fedex freight') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(trackingNumber);
  if (c === 'usps') return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(trackingNumber);
  // LTL carriers (XPO, R+L, SAIA, Old Dominion, Other) — no universal tracking URL
  return null;
}

const statusContent = {
  shipped: {
    eyebrow: 'Shipped',
    headline: 'On the truck, <em style="font-style:italic;">headed your way</em>.',
    message: 'your order has left the warehouse and is on its way. Give the boxes a quick once-over when they land — if anything arrived less than perfect, tell us within 48 hours and we’ll make it right.'
  },
  ready_for_pickup: {
    eyebrow: 'Ready for pickup',
    headline: 'Ready when <em style="font-style:italic;">you are</em>.',
    message: 'your order is staged and waiting at our Anaheim showroom. Bring a valid photo ID and we’ll load your vehicle.'
  },
  delivered: {
    eyebrow: 'Delivered',
    headline: 'It’s <em style="font-style:italic;">home</em>.',
    message: 'your order has been delivered. Please inspect everything and make sure it arrived in good condition — if you have any concerns, contact us within 48 hours.'
  },
  cancelled: {
    eyebrow: 'Cancelled',
    headline: 'Order <em style="font-style:italic;">cancelled</em>.',
    message: 'your order has been cancelled. If payment was collected, your refund will be processed within 5–7 business days. If you believe this was done in error, please contact us right away.'
  }
};

export function generateOrderStatusUpdateHTML(orderData, status) {
  const { order_number, customer_name, tracking_number, shipping_carrier, shipped_at } = orderData;
  const content = statusContent[status];

  if (!content) return null;

  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  const trackingUrl = getTrackingUrl(shipping_carrier, tracking_number);

  const sections = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; ${content.eyebrow}`,
      headline: content.headline,
      body: `${firstName} &mdash; ${content.message}`
    })
  ];

  if (status === 'shipped' && tracking_number) {
    const shippedDate = shipped_at
      ? new Date(shipped_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    sections.push(section(warmCard(`
      <p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:${T.accent};">Tracking number</p>
      <p style="margin:6px 0 0;font-family:${SERIF};font-size:26px;font-weight:300;letter-spacing:0.01em;color:${T.ink};word-break:break-all;">${esc(tracking_number)}</p>
      ${shipping_carrier ? `<p style="margin:10px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.body};">Carrier: <span style="color:${T.ink};font-weight:500;">${esc(shipping_carrier)}</span>${shippedDate ? ` &middot; shipped ${shippedDate}` : ''}</p>` : (shippedDate ? `<p style="margin:10px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.body};">Shipped ${shippedDate}</p>` : '')}
    `, '20px 22px'), '0 40px 24px'));

    if (trackingUrl) {
      sections.push(ctaButton({ href: trackingUrl, label: 'Track your shipment &rarr;' }));
    }
  }

  if (status === 'ready_for_pickup') {
    sections.push(section(warmCard(`
      <p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:${T.accent};">Pickup location</p>
      <p style="margin:6px 0 0;font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">Roma Flooring Designs</p>
      <p style="margin:8px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.body};">1440 S. State College Blvd #6M, Anaheim, CA 92806<br>Mon&ndash;Fri 8am&ndash;5pm &middot; Sat 9am&ndash;2pm<br>Bring a valid photo ID</p>
    `, '20px 22px'), '0 40px 24px'));
  }

  sections.push(section(
    detailList([{ label: 'Order number', value: esc(order_number) }]),
    '0 40px 20px'
  ));

  sections.push(section(
    `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.soft};text-align:center;">Questions? Reply to this email or call (714) 999-0009 &mdash; it reaches our showroom team in Anaheim.</p>`,
    '0 40px 32px'
  ));

  return emailShell({
    title: `Order ${order_number} — ${content.eyebrow}`,
    preheader: `Order ${order_number}: ${content.eyebrow.toLowerCase()}.`,
    content: sections.join('')
  });
}
