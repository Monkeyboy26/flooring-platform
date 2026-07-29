// Tier promotion email — rebuilt on the shared Brass Charcoal shell (_shell.js)
// to match tradeApproval.js. Celebrates a spend-based tier upgrade, showing the
// new tier and its discount, with a CTA into the trade portal.
import { emailShell, heroSection, ctaButton, warmCard, section, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Fallback discounts, used only if the DB tiers can't be loaded. Live values
// come from margin_tiers via emailService.loadTradeTiers, passed in as `tiers`.
const DEFAULT_TIER_DISCOUNTS = { Silver: '12.5%', Gold: '18.75%', Platinum: '21.875%' };

// numeric(6,3) like 18.750 → "18.75%"; trailing zeros dropped by parseFloat.
const fmtPct = (v) => `${parseFloat(v)}%`;

export function generateTierPromotionHTML(customer, tierName, tiers = []) {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (customer.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const tier = esc(tierName || '');
  const matched = (tiers || []).find(t => t.name === tierName);
  const discount = matched ? fmtPct(matched.discount_percent) : (DEFAULT_TIER_DISCOUNTS[tierName] || null);
  const loginUrl = `${siteUrl}/trade`;

  const hero = heroSection({
    eyebrow: 'Trade Program &middot; Tier upgrade',
    headline: `You&rsquo;ve reached <em style="color:${T.accent};">${tier}</em>.`,
    body: `Hi ${esc(firstName)} &mdash; your continued partnership with Roma Flooring has earned ` +
      `<span style="color:${T.ink};font-weight:500;">${esc(customer.company_name || 'your business')}</span> an upgrade to our ${tier} tier.`,
    chip: '&#9650; Upgraded'
  });

  const tierCard = section(warmCard(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">Your new tier</p>
        <p style="margin:4px 0 0;font-family:${SERIF};font-size:30px;line-height:1;letter-spacing:-0.01em;color:${T.ink};">${tier}</p>
      </td>
      ${discount ? `<td valign="middle" align="right">
        <p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">Discount</p>
        <p style="margin:4px 0 0;font-family:${SERIF};font-size:30px;line-height:1;font-weight:300;letter-spacing:-0.01em;color:${T.accent};">${discount}</p>
      </td>` : ''}
    </tr></table>
  `, '20px 22px'), '0 40px 24px');

  const closing = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Your new pricing is live across the catalog now. Your tier is based on trailing 12-month spend, so it keeps pace with your business automatically.
    </p>
  `, '0 40px 32px');

  const content = `
    ${hero}
    ${ctaButton({
      href: loginUrl,
      label: 'Log in to see your new pricing &rarr;',
      note: `Your ${tier} discount is applied automatically at checkout`
    })}
    ${tierCard}
    ${closing}
  `;

  return emailShell({
    title: `You've been upgraded to ${tierName || 'a new tier'} — Roma Flooring trade`,
    preheader: `Congratulations ${firstName} — ${customer.company_name || 'your business'} has been upgraded to ${tierName || 'a new tier'}.`,
    content
  });
}
