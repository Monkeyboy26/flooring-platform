// Estimate-accepted confirmation — the receipt the customer gets right after
// they sign off on a construction estimate on the public /estimate/:token page.
// Built on the shared Brass Charcoal shell (_shell.js), matching estimateSent.js.
// This is a lightweight confirmation, NOT a fresh itemized quote: it confirms the
// approval, restates the total, and sets the "we'll be in touch" expectation.
import { emailShell, heroSection, ctaButton, warmCard, section, detailList, money, T, SERIF, SANS, MONO, esc } from './_shell.js';

export function generateEstimateAcceptedHTML(data) {
  const {
    estimate_number, customer_name, project_name, total,
    accepted_by_name, accepted_at, deposit_amount, public_token,
    rep_first_name, rep_last_name, rep_name, rep_email
  } = data;
  const deposit = parseFloat(deposit_amount || 0);
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const estimateUrl = public_token ? `${siteUrl}/estimate/${public_token}` : null;

  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const displayRep = rep_name || [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'our showroom team';
  const repInitials = (displayRep || 'R').split(/\s+/).map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'R';
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const acceptedOn = longDate(accepted_at) || longDate(new Date().toISOString());

  const metaBlock = section(detailList([
    { label: 'Estimate', value: esc(estimate_number || '') },
    project_name ? { label: 'Project', value: esc(project_name) } : null,
    accepted_by_name ? { label: 'Signed by', value: esc(accepted_by_name) } : null,
    { label: 'Accepted', value: acceptedOn },
  ].filter(Boolean)), '4px 40px 8px');

  // Warm card with the confirmed grand total — the one number the customer cares about.
  const totalBlock = section(warmCard(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">Estimate total</td>
      <td align="right" style="font-family:${SERIF};font-size:32px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(total)}</td>
    </tr></table>
  `, '18px 22px'), '0 40px 8px');

  // What happens next — set expectations so the customer isn't left waiting blind.
  // When a deposit is configured, lead with a CTA to pay it and lock in the job.
  const nextCopy = deposit > 0 && estimateUrl
    ? `Secure your project by paying your ${money(deposit)} deposit online. ${esc(displayRep)} will then reach out to schedule the work &mdash; the remaining balance is handled later.`
    : `${esc(displayRep)} will reach out to arrange payment and schedule the work. No payment is due through this email &mdash; we&rsquo;ll handle it together, the way that works best for you.`;
  const nextBlock = section(`
    <p style="margin:0 0 8px;padding:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};border-bottom:2px solid ${T.ink};">What happens next</p>
    <p style="margin:14px 0 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${nextCopy}</p>
  `, '8px 40px 20px');
  const depositCta = deposit > 0 && estimateUrl
    ? ctaButton({ href: estimateUrl, label: `Pay your ${money(deposit)} deposit &rarr;`, note: 'Secure card or Klarna &middot; the balance is collected later' })
    : '';

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions in the meantime? Reply to this email &mdash; it goes straight to ${esc(displayRep)} at our Anaheim showroom, not a bot.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
      <td width="40" valign="middle">
        <div style="width:40px;height:40px;border-radius:50%;background:${T.warm};border:1px solid ${T.border};text-align:center;font-family:${SERIF};font-size:16px;line-height:40px;color:${T.ink};">${esc(repInitials)}</div>
      </td>
      <td valign="middle" style="padding-left:14px;">
        <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.1;letter-spacing:-0.008em;color:${T.ink};">${esc(displayRep)}</p>
        <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Your sales rep &middot; Roma Flooring${rep_email ? ` &middot; <a href="mailto:${esc(rep_email)}" style="color:${T.accent};text-decoration:none;">${esc(rep_email)}</a>` : ''}</p>
      </td>
    </tr></table>
  `, '0 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Estimate accepted &middot; ${esc(estimate_number || '')}`,
      headline: `You&rsquo;re <em style="color:${T.accent};">all set</em>.`,
      body: `Hi ${esc(firstName)} &mdash; thanks for accepting your construction estimate${project_name ? ` for <span style="color:${T.ink};font-weight:500;">${esc(project_name)}</span>` : ''}. We&rsquo;ve logged your approval and ${esc(displayRep)} will take it from here.`,
      chip: `&#10003; Accepted ${acceptedOn}`
    })}
    ${metaBlock}
    ${totalBlock}
    ${nextBlock}
    ${depositCta}
    ${signature}
  `;

  return emailShell({
    title: `Estimate accepted — ${estimate_number || ''}`,
    preheader: `Thanks ${firstName} — we've got your acceptance of estimate ${estimate_number || ''}${total ? ` (${money(total)})` : ''}. Your rep will follow up with next steps.`,
    content
  });
}
