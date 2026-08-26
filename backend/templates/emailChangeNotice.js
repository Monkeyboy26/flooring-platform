import { emailShell, heroSection, section, T, SANS, esc } from './_shell.js';

// Security notice sent to the OLD address so the real owner sees any change to their
// login email — whether they made it or not. `stage` is 'requested' or 'completed'.
export function generateEmailChangeNoticeHTML(firstName, newEmail, stage = 'requested') {
  const name = firstName ? esc(firstName) : 'there';
  const requested = stage === 'requested';

  const line = requested
    ? `${name} &mdash; someone requested to change the sign-in email on your Roma Flooring Designs account to <strong>${esc(newEmail)}</strong>. The change only takes effect after that new address is confirmed.`
    : `${name} &mdash; the sign-in email on your Roma Flooring Designs account was changed to <strong>${esc(newEmail)}</strong>. You&rsquo;ll use the new address to sign in from now on.`;

  const content = [
    heroSection({
      eyebrow: 'Account security',
      headline: requested ? 'Email change <em style="font-style:italic;">requested</em>.' : 'Email <em style="font-style:italic;">changed</em>.',
      body: line
    }),
    section(
      `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};"><strong>Didn&rsquo;t do this?</strong> Reply to this email or call our showroom at (714) 999-0009 right away &mdash; every message reaches our Anaheim team, not a bot &mdash; and we&rsquo;ll lock the account and undo the change.</p>`,
      '4px 40px 32px'
    )
  ].join('');

  return emailShell({
    title: requested ? 'Email change requested — Roma Flooring Designs' : 'Your email was changed — Roma Flooring Designs',
    preheader: requested ? 'A change to your account email was requested.' : 'The sign-in email on your account was changed.',
    content
  });
}
