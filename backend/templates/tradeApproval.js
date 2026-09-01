// Trade approval ("Welcome to the Trade Program") email — rebuilt on the shared
// Brass Charcoal shell (_shell.js) to match quoteSent.js / estimateSent.js.
// Leads with a welcome hero, shows the spend-based tier ladder in a warm card
// with the starting Silver tier highlighted, and a CTA into the trade portal.
import { emailShell, heroSection, ctaButton, warmCard, section, sectionLabel, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Fallback tier ladder, used only if the DB tiers can't be loaded (the live
// values come from margin_tiers via emailService.loadTradeTiers). Shape matches
// the DB rows: { name, discount_percent, spend_threshold, tier_level }.
const DEFAULT_TIERS = [
  { name: 'Silver', discount_percent: 12.5, spend_threshold: 0, tier_level: 0 },
  { name: 'Gold', discount_percent: 18.75, spend_threshold: 10000, tier_level: 1 },
  { name: 'Platinum', discount_percent: 21.875, spend_threshold: 20000, tier_level: 2 },
];

// numeric(6,3) like 12.500 → "12.5%"; trailing zeros dropped by parseFloat.
const fmtPct = (v) => `${parseFloat(v)}%`;
const fmtMoney0 = (v) => '$' + Math.round(parseFloat(v) || 0).toLocaleString('en-US');

function tierLadder(tiers) {
  const sorted = [...tiers].sort((a, b) => (a.tier_level || 0) - (b.tier_level || 0));
  const rows = sorted.map((t, i) => {
    const last = i === sorted.length - 1;
    const current = i === 0; // approved members start at the lowest tier
    const border = last ? '' : `border-bottom:1px solid ${T.border};`;
    const nameColor = current ? T.ink : T.soft;
    const nameWeight = current ? '500' : '400';
    const threshold = current ? 'Starting tier' : `at ${fmtMoney0(t.spend_threshold)} / yr`;
    return `<tr>
      <td valign="middle" style="padding:12px 0;${border}">
        <span style="font-family:${SERIF};font-size:19px;line-height:1;letter-spacing:-0.01em;color:${nameColor};font-weight:${nameWeight};">${esc(t.name)}</span>
        ${current ? `<span style="margin-left:10px;font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.accent};">You&rsquo;re here</span>` : ''}
      </td>
      <td valign="middle" align="right" style="padding:12px 0;${border}white-space:nowrap;">
        <span style="font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${nameColor};">${fmtPct(t.discount_percent)}</span>
        <span style="display:block;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.muted};">${threshold}</span>
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

export function generateTradeApprovalHTML(customer, tiers = []) {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (customer.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const company = esc(customer.company_name || 'your business');
  const loginUrl = `${siteUrl}/trade`;

  const tierList = (tiers && tiers.length) ? tiers : DEFAULT_TIERS;
  const startingTier = [...tierList].sort((a, b) => (a.tier_level || 0) - (b.tier_level || 0))[0];

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
        You&rsquo;re starting at <span style="color:${T.ink};font-weight:500;">${esc(startingTier.name)}</span>. Your tier is based purely on what you spend with us over a rolling 12-month period &mdash; you move up automatically as you order.
      </p>
      <div style="height:14px;"></div>
      ${tierLadder(tierList)}
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
