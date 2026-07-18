import { emailShell, heroSection, section, ctaButton, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

export function generateWelcomeSetPasswordHTML(firstName, resetUrl) {
  const name = firstName ? esc(firstName) : 'there';

  const starters = [
    {
      icon: '&#9723;',
      t: 'Browse the collection',
      s: 'Tile, stone, hardwood, and more — from your account you can save favorites and reorder in a couple of clicks.',
      cta: 'Shop &rarr;',
      href: `${SITE_URL}/shop`
    },
    {
      icon: '&#8962;',
      t: 'Visit the showroom',
      s: '1440 S. State College Blvd #6M, Anaheim — Mon–Fri 8am–5pm, Sat 9am–2pm.',
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
      headline: 'Glad you’re <em style="font-style:italic;">in</em>.',
      body: `${name} &mdash; your Roma account is set up. Set a password below to see your order history, track shipments, and reorder with ease.`
    }),
    ctaButton({
      href: resetUrl,
      label: 'Set your password &rarr;',
      note: `This link expires in 7 days &mdash; you can also use &ldquo;Forgot Password&rdquo; on our site any time.<br>Button not working? Paste this into your browser:<br><span style="color:${T.ink};word-break:break-all;">${esc(resetUrl)}</span>`
    }),
    section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${starterRows}</table>`, '4px 40px 8px'),
    section(
      `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">We don&rsquo;t send daily emails. You&rsquo;ll hear from us when an order ships and when samples are on the way. Reply anytime &mdash; every email goes to our showroom team in Anaheim, not a bot.</p>`,
      '16px 40px 32px'
    )
  ].join('');

  return emailShell({
    title: 'Welcome to Roma Flooring Designs',
    preheader: 'Your Roma account is set up — set your password to get started.',
    content
  });
}
