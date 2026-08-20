import { emailShell, heroSection, ctaButton, section, warmCard, sectionLabel, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

// Staff invite / onboarding email. Distinct from the customer welcome (no shop /
// reorder copy) and from the reset email (this is a first-time invitation). The
// staffer sets a password, then signs in to the operations console.
const ROLE_LABELS = {
  admin: 'an administrator',
  manager: 'a manager',
  sales_rep: 'a sales rep',
  warehouse: 'warehouse staff',
};
const ROLE_BLURB = {
  admin: 'Full access — staff accounts, pricing, refunds, and everything across the console.',
  manager: 'Approvals, catalog and pricing, credit memos, and the full order pipeline.',
  sales_rep: 'Quotes, orders, your own customers, showroom visits, and commissions.',
  warehouse: 'Receiving, damage flags, material releases, and yard pickups.',
};

export function generateStaffInviteHTML(firstName, resetUrl, { role = 'sales_rep', inviterName = '', expiresLabel = '7 days' } = {}) {
  const name = firstName ? esc(firstName) : 'there';
  const roleLabel = ROLE_LABELS[role] || 'a team member';
  const blurb = ROLE_BLURB[role] || '';
  const adminUrl = `${SITE_URL}/admin`;
  const adminHost = adminUrl.replace(/^https?:\/\//, '');
  const addedBy = inviterName ? esc(inviterName) + ' added you' : 'You&rsquo;ve been added';

  const content = [
    heroSection({
      eyebrow: 'Staff invitation',
      headline: 'Welcome to the <em style="font-style:italic;">team</em>.',
      body: `${name} &mdash; ${addedBy} to the Roma Flooring Designs operations console as <strong style="font-weight:600;color:${T.ink};">${roleLabel}</strong>. Set a password to sign in and get started.`,
      chip: '&#9200; Set up within ' + esc(expiresLabel)
    }),
    ctaButton({
      href: resetUrl,
      label: 'Set your password &rarr;',
      note: `You&rsquo;ll sign in at <a href="${esc(adminUrl)}" target="_blank" style="color:${T.ink};text-decoration:none;border-bottom:1px solid ${T.border};">${esc(adminHost)}</a><br>Button not working? Paste this into your browser:<br><span style="color:${T.ink};word-break:break-all;">${esc(resetUrl)}</span>`
    }),
    section(warmCard(`
      ${sectionLabel('Your access')}
      <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${blurb}</p>
      <p style="margin:11px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${T.soft};">Two-factor verification is required the first time you sign in from a new device. If you weren&rsquo;t expecting this invite, you can ignore it${inviterName ? ' or reply to let ' + esc(inviterName) + ' know' : ''}.</p>
    `), '4px 40px 32px')
  ].join('');

  return emailShell({
    title: 'You’re invited to the Roma operations console',
    preheader: `Set your password to sign in to the Roma staff console — the link expires in ${expiresLabel}.`,
    content
  });
}
