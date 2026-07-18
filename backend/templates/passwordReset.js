import { emailShell, heroSection, section, ctaButton, T, SERIF, SANS, MONO, esc } from './_shell.js';

export function generatePasswordResetHTML(resetUrl) {
  const content = [
    heroSection({
      eyebrow: 'Password reset',
      headline: 'Let’s get you <em style="font-style:italic;">back in</em>.',
      body: 'Someone asked to reset the password on your Roma account. If that was you, set a new one below. The link is good for one hour, then it quietly expires.',
      chip: '&#9200; Expires in 1 hour'
    }),
    ctaButton({
      href: resetUrl,
      label: 'Set a new password &rarr;',
      note: `Button not working? Paste this into your browser:<br><span style="color:${T.ink};word-break:break-all;">${esc(resetUrl)}</span>`
    }),
    section(`
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.warm};"><tr>
        <td width="28" valign="top" style="padding:18px 0 18px 22px;">
          <span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:${T.ink};color:${T.paper};font-family:${SERIF};font-size:14px;line-height:28px;text-align:center;">!</span>
        </td>
        <td valign="top" style="padding:18px 22px 18px 14px;">
          <p style="margin:0;font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.02em;color:${T.ink};">Didn&rsquo;t ask for this?</p>
          <p style="margin:5px 0 0;font-family:${SANS};font-size:13px;line-height:1.55;color:${T.soft};">Ignore this email and your password stays exactly as it is &mdash; nothing changes until the link above is used. If something seems off, reply and our showroom team will take a look.</p>
        </td>
      </tr></table>`,
      '4px 40px 32px')
  ].join('');

  return emailShell({
    title: 'Reset Your Password — Roma Flooring Designs',
    preheader: 'Set a new password for your Roma account — the link expires in one hour.',
    content
  });
}
