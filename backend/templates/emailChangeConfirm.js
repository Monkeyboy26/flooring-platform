import { emailShell, heroSection, section, ctaButton, T, SANS, esc } from './_shell.js';

// Sent to the NEW address a customer wants to move their account to. The change is
// NOT applied until this link is clicked, so this doubles as inbox-ownership proof.
export function generateEmailChangeConfirmHTML(firstName, confirmUrl, newEmail) {
  const name = firstName ? esc(firstName) : 'there';

  const content = [
    heroSection({
      eyebrow: 'Confirm your email',
      headline: 'One quick <em style="font-style:italic;">tap</em>.',
      body: `${name} &mdash; a request was made to use <strong>${esc(newEmail)}</strong> as the sign-in email for your Roma Flooring Designs account. Confirm below and it becomes your new login.`
    }),
    ctaButton({
      href: confirmUrl,
      label: 'Confirm this email &rarr;',
      note: `This link expires in 1 hour. If you didn&rsquo;t request this, you can ignore this email &mdash; nothing changes until you confirm.<br>Button not working? Paste this into your browser:<br><span style="color:${T.ink};word-break:break-all;">${esc(confirmUrl)}</span>`
    }),
    section(
      `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">Until you confirm, you&rsquo;ll keep signing in with your current email. Your order history, store credit, and everything else move with you automatically once confirmed.</p>`,
      '4px 40px 32px'
    )
  ].join('');

  return emailShell({
    title: 'Confirm your new email — Roma Flooring Designs',
    preheader: 'Confirm this address to finish changing your Roma account email.',
    content
  });
}
