import { emailShell, heroSection, section, ctaButton, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

// Staff / admin password-reset email. Distinct from the customer welcome flow:
// staff sign in to the operations console (not the shop), and the set-password
// token is good for 7 days rather than the customer reset's one hour.
export function generateStaffPasswordResetHTML(firstName, resetUrl, { expiresLabel = '7 days', loginPath = '/admin' } = {}) {
  const name = firstName ? esc(firstName) : 'there';
  const adminUrl = `${SITE_URL}${loginPath}`;
  const adminHost = adminUrl.replace(/^https?:\/\//, '');

  const content = [
    heroSection({
      eyebrow: 'Staff password reset',
      headline: 'Let’s get you <em style="font-style:italic;">back in</em>.',
      body: `${name} &mdash; someone asked to reset the password on your Roma <strong style="font-weight:600;color:${T.ink};">staff account</strong>. If that was you, set a new one below, then sign in to the operations console.`,
      chip: '&#9200; Expires in ' + esc(expiresLabel)
    }),
    ctaButton({
      href: resetUrl,
      label: 'Set a new password &rarr;',
      note: `After you set it, sign in at <a href="${esc(adminUrl)}" target="_blank" style="color:${T.ink};text-decoration:none;border-bottom:1px solid ${T.border};">${esc(adminHost)}</a><br>Button not working? Paste this into your browser:<br><span style="color:${T.ink};word-break:break-all;">${esc(resetUrl)}</span>`
    }),
    section(`
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.warm};"><tr>
        <td width="28" valign="top" style="padding:18px 0 18px 22px;">
          <span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:${T.ink};color:${T.paper};font-family:${SERIF};font-size:14px;line-height:28px;text-align:center;">!</span>
        </td>
        <td valign="top" style="padding:18px 22px 18px 14px;">
          <p style="margin:0;font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.02em;color:${T.ink};">Didn&rsquo;t ask for this?</p>
          <p style="margin:5px 0 0;font-family:${SANS};font-size:13px;line-height:1.55;color:${T.soft};">Ignore this email and your password stays exactly as it is &mdash; nothing changes until the link above is used. If it wasn&rsquo;t you, tell a Roma admin so they can lock the account and sign out any open sessions.</p>
        </td>
      </tr></table>`,
      '4px 40px 32px')
  ].join('');

  return emailShell({
    title: 'Reset your Roma staff password',
    preheader: `Set a new password for your Roma staff account — the link expires in ${expiresLabel}.`,
    content
  });
}
