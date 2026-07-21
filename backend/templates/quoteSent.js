// Quote email — "Quote Email.html" design from the Roma Claude Design project,
// rebuilt on the shared Brass Charcoal shell (_shell.js).
// Design fictions adapted to real data: the "saved cart" framing becomes the
// rep-prepared quote, the mocked trade-discount/free-shipping totals become
// the quote's real subtotal/promo/shipping, the fictional PM signature is the
// actual sales rep, and the no-login resume link is the real account CTA.
//
// opts.tracking adds an open-tracking pixel — only set when actually emailing,
// never for the rep-facing preview (the preview iframe would log a fake open).
import { emailShell, heroSection, ctaButton, warmCard, section, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';

// Dev previews pass display strings like '3,450.00' — strip commas first.
const num = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
const money = (v) => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Storefront PDP link — mirrors the SPA's /shop/sku/:skuId/:slug route
// (slug is cosmetic; the router keys on the SKU id).
function pdpUrl(item) {
  if (!item.sku_id) return null;
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const slug = String(item.product_name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${siteUrl}/shop/sku/${item.sku_id}/${slug}`;
}

function itemRow(item, isLast) {
  const rowBorder = isLast ? '' : `border-bottom:1px solid ${T.border};`;
  const name = esc(item.product_name || item.collection || 'Product');
  const link = pdpUrl(item);
  const topLine = [item.collection && item.collection !== item.product_name ? item.collection : null, item.vendor_name]
    .filter(Boolean).map(esc).join(' &middot; ');
  const subLine = [...new Set([item.color, item.variant_name].filter(Boolean))]
    .filter(v => v !== item.product_name).map(esc).join(' &middot; ');
  const isUnit = item.sell_by === 'unit';
  const qty = item.num_boxes || item.quantity || 1;
  const sqft = num(item.sqft_needed);
  const qtyLine = item.is_sample
    ? 'Sample'
    : isUnit
      ? `${qty} ea`
      : `${qty} ${qty === 1 ? 'box' : 'boxes'}${sqft ? ' &middot; ' + sqft.toFixed(1) + ' sf' : ''}`;
  const isFree = item.is_sample && num(item.subtotal) === 0;
  const thumbInner = item.primary_image
    ? `<img src="${esc(emailImage(item.primary_image, 72, 72))}" alt="${name}" width="72" style="display:block;width:72px;height:auto;" />`
    : `<div style="width:72px;height:72px;background:${T.warm};border:1px solid ${T.border};"></div>`;
  const thumb = link ? `<a href="${esc(link)}" target="_blank" style="text-decoration:none;">${thumbInner}</a>` : thumbInner;
  const nameHtml = link
    ? `<a href="${esc(link)}" target="_blank" style="color:${T.ink};text-decoration:none;">${name}</a>`
    : name;

  return `<tr>
    <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">${thumb}</td>
    <td valign="middle" style="padding:16px 0;${rowBorder}">
      ${topLine ? `<p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${topLine}</p>` : ''}
      <p style="margin:${topLine ? '4px' : '0'} 0 0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${nameHtml}</p>
      ${subLine ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.soft};">${subLine}</p>` : ''}
      <p style="margin:6px 0 0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">${qtyLine}</p>
    </td>
    <td valign="middle" align="right" style="padding:16px 0 16px 12px;${rowBorder}white-space:nowrap;">
      <p style="margin:0;font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${isFree ? 'Free' : money(item.subtotal)}</p>
    </td>
  </tr>`;
}

export function generateQuoteSentHTML(quoteData, opts = {}) {
  const {
    id, quote_number, customer_name,
    subtotal, shipping, discount_amount, promo_code, total,
    created_at, expires_at,
    rep_first_name, rep_last_name, rep_email,
    items = []
  } = quoteData;

  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const repName = [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'our showroom team';
  const repInitials = [rep_first_name, rep_last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || 'R';
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(created_at) || 'today';
  const validUntil = longDate(expires_at);

  const trackingPixel = (opts.tracking && id)
    ? section(`<img src="${siteUrl}/api/quotes/${id}/open.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`, '0')
    : '';

  // Items block — header strip, then rows
  const itemsBlock = section(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${T.border};">
      <tr>
        <td style="padding-bottom:12px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">In your quote</td>
        <td align="right" style="padding-bottom:12px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">${items.length} item${items.length === 1 ? '' : 's'}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${items.map((it, i) => itemRow(it, i === items.length - 1)).join('')}
    </table>
  `, '8px 40px 24px');

  // Totals — warm card with the big serif total
  const totalsRows = [
    ['Materials', money(subtotal), T.ink],
    num(discount_amount) > 0 ? [`Discount${promo_code ? ' &middot; ' + esc(promo_code) : ''}`, '&minus;' + money(discount_amount), T.accent] : null,
    num(shipping) > 0 ? ['Shipping', money(shipping), T.ink] : null,
  ].filter(Boolean);
  const totalsBlock = section(warmCard(`
    ${totalsRows.map(([k, v, col]) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.soft};">${k}</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:13px;color:${col};">${v}</td>
      </tr></table>`).join('')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid ${T.border};"><tr>
      <td style="padding-top:12px;font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">Quote total</td>
      <td align="right" style="padding-top:12px;font-family:${SERIF};font-size:32px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(total)}</td>
    </tr></table>
  `, '20px 22px'), '0 40px 8px');

  // "While you decide" — two secondary cards
  const whileYouDecide = section(`
    <p style="margin:0 0 18px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};text-align:center;">While you decide</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="49%" valign="top" style="border:1px solid ${T.border};">
        <a href="${siteUrl}/design-services" target="_blank" style="display:block;padding:20px 22px;text-decoration:none;">
          <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.2;letter-spacing:-0.01em;color:${T.ink};">Talk to a designer</p>
          <p style="margin:6px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">Free consultation</p>
        </a>
      </td>
      <td width="2%"></td>
      <td width="49%" valign="top" style="border:1px solid ${T.border};">
        <a href="tel:+17149990009" style="display:block;padding:20px 22px;text-decoration:none;">
          <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.2;letter-spacing:-0.01em;color:${T.ink};">Schedule an in-home measure</p>
          <p style="margin:6px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">Orange County &middot; (714) 999-0009</p>
        </a>
      </td>
    </tr></table>
  `, '28px 40px 24px');

  // Signature — reply note + the actual rep
  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Hit reply with any questions — these go straight to ${esc(repName)} at our Anaheim showroom, not a bot.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
      <td width="40" valign="middle">
        <div style="width:40px;height:40px;border-radius:50%;background:${T.warm};border:1px solid ${T.border};text-align:center;font-family:${SERIF};font-size:16px;line-height:40px;color:${T.ink};">${esc(repInitials)}</div>
      </td>
      <td valign="middle" style="padding-left:14px;">
        <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.1;letter-spacing:-0.008em;color:${T.ink};">${esc(repName)}</p>
        <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Your sales rep &middot; Roma Flooring</p>
      </td>
    </tr></table>
  `, '0 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Your quote &middot; ${esc(quote_number || '')}`,
      headline: `Your quote, <em style="color:${T.accent};">ready</em>.`,
      body: `Hi ${esc(firstName)} &mdash; here&rsquo;s the quote ${esc(repName)} prepared for you on ${issued}.` +
        (validUntil ? ` Pricing is locked in through <span style="color:${T.ink};font-weight:500;">${validUntil}</span>.` : ' Pricing is locked in for 10 days.'),
      chip: validUntil ? `&#9201; Valid until ${validUntil}` : null
    })}
    ${itemsBlock}
    ${totalsBlock}
    ${ctaButton({
      href: `${siteUrl}/account/quotes`,
      label: 'Accept &amp; pay online &rarr;',
      note: `Sign in to your Roma account to review and check out securely &middot; or reply to this email`
    })}
    ${whileYouDecide}
    ${signature}
    ${trackingPixel}
  `;

  return emailShell({
    title: `Your Roma quote — ${quote_number || ''}`,
    preheader: `Hi ${firstName} — ${items.length} item${items.length === 1 ? '' : 's'}, ${money(total)} total.` +
      (validUntil ? ` Pricing locked until ${validUntil}.` : ''),
    content
  });
}
