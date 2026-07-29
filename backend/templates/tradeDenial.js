// Trade application denial email — rebuilt on the shared Brass Charcoal shell
// (_shell.js) to match tradeApproval.js. Deliberately restrained: no loud CTA
// or celebratory accent, an optional reason in a warm card, and an open door to
// reapply with more documentation.
import { emailShell, heroSection, warmCard, section, sectionLabel, T, SANS, esc } from './_shell.js';

export function generateTradeDenialHTML(customer) {
  const firstName = (customer.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const company = esc(customer.company_name || 'your business');

  const hero = heroSection({
    eyebrow: 'Trade Program &middot; Application update',
    headline: `A note on your <em>application</em>.`,
    body: `Hi ${esc(firstName)} &mdash; thank you for your interest in the Roma trade program. ` +
      `After review, we&rsquo;re not able to approve the application for <span style="color:${T.ink};font-weight:500;">${company}</span> at this time.`
  });

  const reasonBlock = customer.denial_reason
    ? section(`
        ${sectionLabel('Reason')}
        ${warmCard(`<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${esc(customer.denial_reason)}</p>`, '18px 22px')}
      `, '0 40px 24px')
    : '';

  const closing = section(`
    <p style="margin:0 0 16px;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      If you believe this was in error, or you can provide additional documentation (resale certificate, EIN, or contractor license), just reply to this email &mdash; it reaches our showroom team directly and we&rsquo;ll take another look.
    </p>
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      We appreciate your understanding and hope to work with ${company} in the future.
    </p>
  `, '0 40px 36px');

  const content = `
    ${hero}
    ${reasonBlock}
    ${closing}
  `;

  return emailShell({
    title: 'An update on your Roma Flooring trade application',
    preheader: `Hi ${firstName} — an update on the trade application for ${customer.company_name || 'your business'}.`,
    content
  });
}
