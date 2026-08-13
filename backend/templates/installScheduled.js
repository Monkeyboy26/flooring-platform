import { emailShell, heroSection, section, detailList, warmCard, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Customer email: the installation date is booked. Sent from the rep's "Schedule
// install" action on an order converted from an estimate (labor lines present).
export function generateInstallScheduledHTML(orderData) {
  const { order_number, customer_name, install_scheduled_at, install_window, install_notes } = orderData;
  if (!install_scheduled_at) return null;

  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  // Stored at noon local so the calendar day is tz-stable; time of day is
  // conveyed by the free-text window.
  const dateStr = new Date(install_scheduled_at).toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const addr = [orderData.shipping_address_line1, orderData.shipping_address_line2,
    [orderData.shipping_city, orderData.shipping_state, orderData.shipping_zip].filter(Boolean).join(', ')]
    .filter(Boolean).map(esc).join('<br>');

  const rows = [{ label: 'Install date', value: `<span style="font-weight:500;">${esc(dateStr)}</span>` }];
  if (install_window) rows.push({ label: 'Arrival window', value: esc(install_window) });
  if (addr) rows.push({ label: 'Job site', value: addr });
  rows.push({ label: 'Order', value: esc(order_number) });

  const sections = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; Install scheduled`,
      headline: 'Your installation is <em style="font-style:italic;">booked</em>.',
      body: `${firstName} &mdash; your install is on the calendar. Here are the details; our team will confirm as the date approaches.`
    }),
    section(detailList(rows)),
  ];

  if (install_notes) {
    sections.push(section(warmCard(`
      <p style="margin:0 0 6px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:${T.accent};">A note from your rep</p>
      <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.ink};">${esc(install_notes)}</p>
    `)));
  }

  sections.push(section(`
    <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.body};">
      Please make sure the install area is clear and accessible the morning of. If anything on your end changes, just reply to this email and we'll adjust.
    </p>`, '0 40px 32px'));

  return emailShell({
    title: `Installation scheduled — ${order_number}`,
    preheader: `Your install is booked for ${dateStr}.`,
    content: sections.join('')
  });
}
