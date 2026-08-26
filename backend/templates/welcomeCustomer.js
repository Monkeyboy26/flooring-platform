import { emailShell, heroSection, section, ctaButton, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

// Welcome email for a genuine FIRST-TIME customer who already has a login (self
// sign-up or Google). Unlike welcomeSetPassword, there is NO set-password step —
// their account is ready, so the CTA points them at the collection.
export function generateWelcomeCustomerHTML(firstName) {
  const name = firstName ? esc(firstName) : 'there';

  const starters = [
    {
      icon: '&#9723;',
      t: 'Browse the collection',
      s: 'Tile, stone, hardwood, vinyl and more — save favorites and order samples right from a product page.',
      cta: 'Shop &rarr;',
      href: `${SITE_URL}/shop`
    },
    {
      icon: '&#9782;',
      t: 'Order samples first',
      s: 'See and feel the material in your own space before you commit. Samples ship flat-rate, right to your door.',
      cta: 'Samples &rarr;',
      href: `${SITE_URL}/shop`
    },
    {
      icon: '&#8962;',
      t: 'Visit the showroom',
      s: '1440 S. State College Blvd #6M, Anaheim — Mon–Fri 9am–5pm, Sat 10am–5pm.',
      cta: 'Directions &rarr;',
      href: 'https://maps.google.com/?q=1440+S+State+College+Blvd+%236M,+Anaheim,+CA+92806'
    }
  ];

  const starterRows = starters.map((c, i) => `<tr>
    <td width="40" valign="middle" style="padding:18px 16px 18px 0;${i < starters.length - 1 ? `border-bottom:1px solid ${T.border};` : ''}">
      <span style="display:inline-block;width:40px;height:40px;background:${T.warm};font-family:${SERIF};font-size:22px;font-weight:300;line-height:40px;text-align:center;color:${T.ink};">${c.icon}</span>
    </td>
    <td valign="middle" style="padding:18px 16px 18px 0;${i < starters.length - 1 ? `border-bottom:1px solid ${T.border};` : ''}">
      <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${c.t}</p>
      <p style="margin:3px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.soft};">${c.s}</p>
    </td>
    <td align="right" valign="middle" style="padding:18px 0;${i < starters.length - 1 ? `border-bottom:1px solid ${T.border};` : ''}white-space:nowrap;">
      <a href="${esc(c.href)}" target="_blank" style="font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.accent};text-decoration:none;">${c.cta}</a>
    </td>
  </tr>`).join('');

  const content = [
    heroSection({
      eyebrow: 'Welcome to Roma',
      headline: 'Glad you&rsquo;re <em style="font-style:italic;">in</em>.',
      body: `${name} &mdash; your Roma Flooring Designs account is ready. Browse the collection, order samples, track your orders, and reorder in a couple of clicks whenever you&rsquo;re ready.`
    }),
    ctaButton({
      href: `${SITE_URL}/shop`,
      label: 'Start exploring &rarr;',
      note: `Everything you save and order lives in your account &mdash; sign in any time at <span style="color:${T.ink};">${esc(SITE_URL)}/account</span>.`
    }),
    section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${starterRows}</table>`, '4px 40px 8px'),
    section(
      `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">We don&rsquo;t send daily emails. You&rsquo;ll hear from us when an order ships and when samples are on the way. Reply anytime &mdash; every email goes to our showroom team in Anaheim, not a bot.</p>`,
      '16px 40px 32px'
    )
  ].join('');

  return emailShell({
    title: 'Welcome to Roma Flooring Designs',
    preheader: 'Your Roma account is ready — here&rsquo;s how to get started.',
    content
  });
}
