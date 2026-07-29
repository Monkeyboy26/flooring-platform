// Trade approval ("Welcome to the Trade Program") email — rebuilt on the shared
// Brass Charcoal shell (_shell.js) to match quoteSent.js / estimateSent.js.
// Leads with a welcome hero, shows the spend-based tier ladder in a warm card
// with the starting Silver tier highlighted, and a CTA into the trade portal.
import { emailShell, heroSection, ctaButton, warmCard, section, sectionLabel, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Spend-based tier ladder. Kept in sync with the approval copy; the member
// starts at Silver and moves up automatically on trailing 12-month spend.
const TIERS = [
  { name: 'Silver', discount: '12.5%', threshold: 'Starting tier', current: true },
  { name: 'Gold', discount: '18.75%', threshold: 'at $12,500 / yr' },
  { name: 'Platinum', discount: '21.875%', threshold: 'at $25,000 / yr' },
];

function tierLadder() {
  const rows = TIERS.map((t, i) => {
    const last = i === TIERS.length - 1;
    const border = last ? '' : `border-bottom:1px solid ${T.border};`;
    const nameColor = t.current ? T.ink : T.soft;
    const nameWeight = t.current ? '500' : '400';
    return `<tr>
      <td valign="middle" style="padding:12px 0;${border}">
        <span style="font-family:${SERIF};font-size:19px;line-height:1;letter-spacing:-0.01em;color:${nameColor};font-weight:${nameWeight};">${t.name}</span>
        ${t.current ? `<span style="margin-left:10px;font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.accent};">You&rsquo;re here</span>` : ''}
      </td>
      <td valign="middle" align="right" style="padding:12px 0;${border}white-space:nowrap;">
        <span style="font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${nameColor};">${t.discount}</span>
        <span style="display:block;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.muted};">${t.threshold}</span>
      </td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

const NEXT_STEPS = [
  'Log in to see live trade pricing across the catalog',
  'Order at your exclusive discount, applied automatically',
  'Track your tier progress from your trade dashboard',
  'Your dedicated rep will reach out shortly',
];

export function generateTradeApprovalHTML(customer) {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (customer.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const company = esc(customer.company_name || 'your business');
  const loginUrl = `${siteUrl}/trade`;

  const hero = heroSection({
    eyebrow: 'Trade Program &middot; Application approved',
    headline: `Welcome to the <em style="color:${T.accent};">trade</em>.`,
    body: `Hi ${esc(firstName)} &mdash; your trade application for <span style="color:${T.ink};font-weight:500;">${company}</span> is approved. ` +
      `You now have exclusive trade pricing, dedicated account support, and every benefit of the program &mdash; with no membership fee.`,
    chip: '&#10003; Approved'
  });

  const tierBlock = section(`
    ${sectionLabel('Your pricing')}
    ${warmCard(`
      <p style="margin:0 0 4px;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
        You&rsquo;re starting at <span style="color:${T.ink};font-weight:500;">Silver</span>. Your tier is based purely on what you spend with us over a rolling 12-month period &mdash; you move up automatically as you order.
      </p>
      <div style="height:14px;"></div>
      ${tierLadder()}
    `, '20px 22px')}
  `, '0 40px 24px');

  const nextBlock = section(`
    ${sectionLabel('What&rsquo;s next')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${NEXT_STEPS.map((step, i) => `<tr>
        <td width="26" valign="top" style="padding:${i === 0 ? '0' : '10px'} 0 0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.1em;color:${T.accent};">${String(i + 1).padStart(2, '0')}</td>
        <td valign="top" style="padding:${i === 0 ? '0' : '10px'} 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${T.body};">${step}</td>
      </tr>`).join('')}
    </table>
  `, '0 40px 28px');

  const closing = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Thank you for choosing Roma Flooring Designs. We&rsquo;re glad to have ${company} on the trade roster.
    </p>
  `, '0 40px 36px');

  const content = `
    ${hero}
    ${ctaButton({
      href: loginUrl,
      label: 'Log in to see your trade pricing &rarr;',
      note: 'Browse the full catalog with your discount applied &middot; track your tier from your dashboard'
    })}
    ${tierBlock}
    ${nextBlock}
    ${closing}
  `;

  return emailShell({
    title: 'Welcome to the Roma Flooring trade program',
    preheader: `${firstName}, your trade application for ${customer.company_name || 'your business'} is approved — log in to see your pricing.`,
    content
  });
}
