// Trade program INVITE email — sent proactively to retail customers whose order
// history looks "pro" (repeat orders, volume), inviting them to apply for the
// Trade Program. Rebuilt from the Claude Design "Trade Invite Email" mockup on
// the shared Brass Charcoal shell (_shell.js) so it matches tradeApproval.js et al.
// Leads with an invitation hero, a 2x2 benefits grid, an "apply" CTA, and a
// "what approval looks like" warm card.
//
// The benefit copy is kept accurate to how Roma actually operates: tiered,
// spend-based pricing (from margin_tiers), a dedicated rep, no membership fee,
// and automatic tier upgrades. It intentionally does NOT promise net-30 terms,
// slab/dye-lot holds, or same-day approval.
import { emailShell, heroSection, ctaButton, warmCard, section, sectionLabel, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Fallback tier ladder, used only if the DB tiers can't be loaded (live values
// come from margin_tiers via emailService.loadTradeTiers). Matches the DB rows.
const DEFAULT_TIERS = [
  { name: 'Silver', discount_percent: 12.5, spend_threshold: 0, tier_level: 0 },
  { name: 'Gold', discount_percent: 18.75, spend_threshold: 10000, tier_level: 1 },
  { name: 'Platinum', discount_percent: 21.875, spend_threshold: 20000, tier_level: 2 },
];

// numeric(6,3) like 12.500 → "12.5"; trailing zeros dropped by parseFloat.
const fmtPct = (v) => `${parseFloat(v)}%`;

// The three-step "what approval looks like" ladder. `orderWord` is 'next' for
// customers with order history, 'first' for never-ordered prospects.
const approvalSteps = (orderWord) => [
  'Tell us about your business — trade, typical projects, license if you have one.',
  'We review within 1&ndash;2 business days and assign your rep.',
  `Your very ${orderWord} order is at trade pricing — applied automatically at checkout.`,
];

// One benefit card cell (half-width).
function benefitCell(big, label, body) {
  return `<td width="50%" valign="top" style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${T.border};border-collapse:collapse;">
      <tr><td style="padding:20px 20px 22px;">
        <div style="font-family:${SERIF};font-size:30px;line-height:1;font-weight:300;letter-spacing:-0.014em;color:${T.ink};">${big}</div>
        <div style="margin-top:7px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.accent};">${label}</div>
        <p style="margin:10px 0 0;font-family:${SANS};font-size:12.5px;line-height:1.6;color:${T.soft};">${body}</p>
      </td></tr>
    </table>
  </td>`;
}

function benefitsGrid(startPct, topPct, orderWord) {
  const benefits = [
    [startPct, 'off, and climbing', `Trade pricing on all 55,000+ SKUs — starts at ${startPct} off and rises to ${topPct} as your annual volume grows. Applied automatically at checkout.`],
    ['One rep', 'who knows your work', 'A dedicated rep for quotes, substitutions, and product questions — call, text, or email.'],
    ['$0', 'to join', `No membership fee, ever. Your trade discount applies from your very ${orderWord} order.`],
    ['Auto', 'tier upgrades', 'Your pricing climbs with your rolling 12-month spend — nothing to file, tracked from your trade dashboard.'],
  ];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>${benefitCell(...benefits[0])}${benefitCell(...benefits[1])}</tr>
    <tr>${benefitCell(...benefits[2])}${benefitCell(...benefits[3])}</tr>
  </table>`;
}

/**
 * @param {object} recipient
 *   name        — recipient full name (first name is used in the greeting)
 *   order_count — optional; number of orders in the last 12 months (drives the
 *                 "you've placed N orders" line; a generic line is used if absent)
 *   note        — optional personal note from the rep, shown in a warm card
 *   rep_first_name — optional; used to sign the closing line
 * @param {Array} tiers — active margin_tiers rows (low→high); falls back to DEFAULT_TIERS
 */
export function generateTradeInviteHTML(recipient = {}, tiers = []) {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (recipient.name || '').trim().split(/\s+/)[0] || 'there';
  const applyUrl = `${siteUrl}/trade`;
  const repName = (recipient.rep_first_name || '').trim();

  const tierList = (tiers && tiers.length) ? [...tiers].sort((a, b) => (a.tier_level || 0) - (b.tier_level || 0)) : DEFAULT_TIERS;
  const startPct = fmtPct(tierList[0].discount_percent);
  const topPct = fmtPct(tierList[tierList.length - 1].discount_percent);

  // Two audiences: customers with order history vs. never-ordered prospects.
  // The variant is auto-selected by order_count (0 / blank → prospect copy),
  // which changes the headline, the hero body, and every "next order" → "first
  // order" so nothing implies a purchase that never happened.
  const n = parseInt(recipient.order_count, 10);
  const hasHistory = Number.isFinite(n) && n > 0;
  const orderWord = hasHistory ? 'next' : 'first';

  const headline = hasHistory
    ? `You&rsquo;ve ordered like a pro all year. Time you were <em style="color:${T.accent};">priced</em> like one.`
    : `You work like a pro. Time you were <em style="color:${T.accent};">priced</em> like one.`;

  const heroBody = hasHistory
    ? `Hi ${esc(firstName)} &mdash; you&rsquo;ve placed <span style="color:${T.ink};font-weight:500;">${n} order${n === 1 ? '' : 's'}</span> with us in the last twelve months. ` +
      `Contractors, designers, and builders doing that kind of volume qualify for our Trade Program. ` +
      `It&rsquo;s free, approval takes 1&ndash;2 business days, and your discount applies from your very next order.`
    : `Hi ${esc(firstName)} &mdash; our Trade Program is built for contractors, designers, and builders buying for jobs and clients. ` +
      `If that&rsquo;s you, you qualify. It&rsquo;s free, approval takes 1&ndash;2 business days, and your discount applies from your very first order.`;

  const hero = heroSection({
    eyebrow: 'An invitation',
    headline,
    body: heroBody
  });

  const note = (recipient.note || '').trim();
  const noteBlock = note ? section(warmCard(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};font-style:italic;">&ldquo;${esc(note)}&rdquo;</p>
    ${repName ? `<p style="margin:8px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">&mdash; ${esc(repName)}, Roma Flooring</p>` : ''}
  `, '18px 22px'), '0 40px 8px') : '';

  const benefitsBlock = section(benefitsGrid(startPct, topPct, orderWord), '4px 40px 8px');

  const approvalBlock = section(`
    ${sectionLabel('What approval looks like')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${approvalSteps(orderWord).map((step, i) => `<tr>
        <td width="26" valign="top" style="padding:${i === 0 ? '0' : '10px'} 0 0;font-family:${MONO};font-size:12px;font-weight:500;letter-spacing:0.08em;color:${T.accent};">${i + 1}</td>
        <td valign="top" style="padding:${i === 0 ? '0' : '10px'} 0 0;font-family:${SANS};font-size:14px;line-height:1.55;color:${T.body};">${step}</td>
      </tr>`).join('')}
    </table>
  `, '0 40px 24px');

  const closing = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions first? Reply to this email or call the showroom at <span style="color:${T.ink};white-space:nowrap;">(714) 999-0009</span> and ask for the trade desk &mdash; ${repName ? `${esc(repName)} or another rep` : 'a rep'} will walk you through it.
    </p>
  `, '0 40px 36px');

  const content = `
    ${hero}
    ${noteBlock}
    ${ctaButton({
      href: applyUrl,
      label: 'Apply for trade pricing &rarr;',
      note: 'Two minutes. A license or resale number speeds approval, but isn&rsquo;t required.'
    })}
    ${benefitsBlock}
    ${approvalBlock}
    ${closing}
  `;

  return emailShell({
    title: 'You&rsquo;re invited to the Roma Flooring trade program',
    preheader: `Hi ${firstName} — tiered trade pricing up to ${topPct} off, a dedicated rep, and no membership fee. Free to join, two minutes to apply.`,
    content
  });
}
