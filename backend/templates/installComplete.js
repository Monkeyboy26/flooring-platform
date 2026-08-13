import { emailShell, heroSection, section, detailList, warmCard, T, SERIF, SANS, MONO, money, esc } from './_shell.js';

// Customer email: the installation job is complete. Sent when a rep marks an
// install order (labor lines present) delivered/"Job complete". Closes the loop
// with a thank-you and the final money state (paid in full, or balance remaining).
export function generateInstallCompleteHTML(orderData, balance) {
  const { order_number, customer_name, total, amount_paid } = orderData;
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');

  const bal = balance != null ? parseFloat(balance) : Math.max(0, parseFloat(total || 0) - parseFloat(amount_paid || 0));
  const hasBalance = bal > 0.01;

  const sections = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; Job complete`,
      headline: 'Your floors are <em style="font-style:italic;">in</em>.',
      body: `${firstName} &mdash; your installation is complete. Thank you for trusting Roma with your space. Take a walk on it and enjoy.`
    }),
    section(detailList([
      { label: 'Order', value: esc(order_number) },
      { label: 'Order total', value: money(total) },
      { label: 'Paid', value: `<span style="color:#3f7a4f;">${money(amount_paid || 0)}</span>` },
      ...(hasBalance ? [{ label: 'Balance due', value: `<span style="font-weight:500;color:#a87935;">${money(bal)}</span>` }] : []),
    ])),
  ];

  if (hasBalance) {
    sections.push(section(warmCard(`
      <p style="margin:0 0 6px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:${T.accent};">Final balance</p>
      <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.ink};">A balance of <strong>${money(bal)}</strong> remains on this job. Your rep will follow up with a secure payment link to settle it &mdash; or reply here and we'll take care of it.</p>
    `)));
  } else {
    sections.push(section(`
      <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};text-align:center;">
        Paid in full &mdash; nothing more to do. If a spot ever needs attention, we stand behind our work; just reach out.
      </p>`, '0 40px 8px'));
  }

  sections.push(section(`
    <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.body};">
      We'd love to see how it turned out &mdash; and if you know someone planning a project, we're always grateful for the introduction.
    </p>`, '0 40px 32px'));

  return emailShell({
    title: `Installation complete — ${order_number}`,
    preheader: hasBalance ? `Your install is complete — a balance of ${money(bal)} remains.` : 'Your install is complete. Thank you!',
    content: sections.join('')
  });
}
