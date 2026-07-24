// Customer-facing "pay the flat sample-shipping fee" email, on the shared
// "Brass Charcoal" shell (_shell.js), matching sampleRequestConfirmation.js.
// Leads with a Stripe checkout CTA; the samples themselves are free.
import { emailShell, heroSection, section, detailList, ctaButton, warmCard, T, SANS, esc, money } from './_shell.js';

export function generateSampleShippingPaymentHTML(data) {
  const { customer_name, request_number, checkout_url, amount } = data;
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const amt = money(amount);

  const metaBlock = section(detailList([
    { label: 'Request', value: esc(request_number) },
    { label: 'Samples', value: 'Free' },
    { label: 'Shipping', value: `${amt} flat rate` },
  ]), '4px 40px 8px');

  const cta = checkout_url ? ctaButton({
    href: checkout_url,
    label: `Pay shipping &middot; ${amt} &rarr;`,
    note: 'Secure checkout &middot; this link expires in 72 hours'
  }) : '';

  const noteBlock = section(warmCard(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      The samples are on us &mdash; the only charge is a flat <span style="color:${T.ink};font-weight:500;">${amt}</span>
      to cover delivery. As soon as it&rsquo;s paid, we&rsquo;ll pack your swatches and get them moving.
    </p>
  `, '18px 22px'), '8px 40px 8px');

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Trouble with the link or questions about your samples? Reply to this email or call the showroom at
      <span style="color:${T.ink};font-weight:500;">(714) 999-0009</span>.
    </p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Sample request &middot; ${esc(request_number || '')}`,
      headline: `One step to <em style="color:${T.accent};">ship</em>.`,
      body: `Hi ${esc(firstName)} &mdash; your samples are ready to go. They&rsquo;re free; just cover the flat <span style="color:${T.ink};font-weight:500;">${amt}</span> shipping below and we&rsquo;ll send them out.`,
      chip: `&#9679; ${amt} shipping`
    })}
    ${metaBlock}
    ${cta}
    ${noteBlock}
    ${signature}
  `;

  return emailShell({
    title: `Shipping payment — sample request ${request_number || ''}`,
    preheader: `Hi ${firstName} — your samples are free; just cover the flat ${amt} shipping to send them out.`,
    content
  });
}
