// Credit memo email — the returns-flow sibling of the quote/invoice emails,
// built on the shared Brass Charcoal shell (_shell.js). Sent to the customer
// when a rep processes a return: confirms the returned items, the merchandise /
// restock / tax / total-credit breakdown, and where the credit landed (refunded
// to the original tender vs. added to the Roma account as store credit).
// Cadence-neutral copy — no newsletter framing. Real Roma branding throughout.
import { emailShell, heroSection, section, detailList, ctaButton, warmCard, T, SERIF, SANS, MONO, esc } from './_shell.js';

// Dev previews pass display strings like '1,240.00' — strip commas first.
const num = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;
const money = (v) => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function generateCreditMemoIssuedHTML(data) {
  const {
    cm_number, rma_number, order_number, customer_name,
    subtotal, restock_fee, discount_adjustment, tax_refund, total,
    created_at, settlement = [], items = [],
    rep_name, rep_email,
  } = data;

  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(created_at) || 'today';

  const list = Array.isArray(settlement) ? settlement : [];
  const hasRefund = list.some(s => s.method !== 'store_credit');
  const refundLabel = list.find(s => s.method === 'card') ? 'your card'
    : list.find(s => s.method === 'check') ? 'a check'
    : 'your original payment';

  // Returned-item rows (name × qty → line credit)
  const itemRows = items.map((it) => {
    const name = esc(it.description || it.product_name || 'Returned item');
    const qty = num(it.qty) || 1;
    return {
      label: `${qty} ${qty === 1 ? 'unit' : 'units'}`,
      value: `<span style="color:${T.ink};">${name}</span><span style="float:right;color:${T.ink};">${money(it.refund_line)}</span>`,
    };
  });

  // Totals rows
  const totalRows = [
    { label: 'Merchandise', value: money(subtotal) },
    num(restock_fee) > 0 ? { label: 'Restocking fee', value: '&minus;' + money(restock_fee) } : null,
    num(discount_adjustment) > 0 ? { label: 'Discount adj.', value: '&minus;' + money(discount_adjustment) } : null,
    num(tax_refund) > 0 ? { label: 'Sales tax', value: money(tax_refund) } : null,
  ].filter(Boolean);

  const itemsBlock = items.length
    ? section(`
        <p style="margin:0 0 14px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">Returned &middot; ${items.length} item${items.length === 1 ? '' : 's'}</p>
        ${detailList(itemRows, 90)}
      `, '8px 40px 20px')
    : '';

  const totalsBlock = section(warmCard(`
    ${totalRows.map((r) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.soft};">${r.label}</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.ink};">${r.value}</td>
      </tr></table>`).join('')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid ${T.border};"><tr>
      <td style="padding-top:12px;font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">Total credit</td>
      <td align="right" style="padding-top:12px;font-family:${SERIF};font-size:32px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(total)}</td>
    </tr></table>
  `, '20px 22px'), '0 40px 12px');

  const appliedLine = hasRefund
    ? `We've refunded <span style="color:${T.ink};font-weight:500;">${money(total)}</span> to ${refundLabel}. It typically posts in 5&ndash;10 business days, depending on your bank.`
    : `We've added <span style="color:${T.ink};font-weight:500;">${money(total)}</span> to your Roma account as store credit &mdash; it's available to use right away.`;

  const appliedBlock = section(`
    <p style="margin:0 0 10px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};">Where your credit went</p>
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${appliedLine}</p>
  `, '0 40px 24px');

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions about this return? Reply to this email &mdash; it goes straight to ${esc(rep_name || 'our Anaheim showroom team')}, not a bot.
    </p>
  `, '0 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Credit memo &middot; ${esc(cm_number || '')}`,
      headline: hasRefund
        ? `Your refund is <em style="color:${T.accent};">on its way</em>.`
        : `Your credit is <em style="color:${T.accent};">ready</em>.`,
      body: `Hi ${firstName} &mdash; we've processed your return${rma_number ? ` (${esc(rma_number)})` : ''} on order ${esc(order_number || '')}, issued ${issued}. Here's the full breakdown.`,
      chip: order_number ? `Order ${esc(order_number)}` : null,
    })}
    ${itemsBlock}
    ${totalsBlock}
    ${appliedBlock}
    ${ctaButton({
      href: `${siteUrl}/account/orders`,
      label: 'View your orders &rarr;',
      note: 'Sign in to your Roma account to see this credit and your order history.',
    })}
    ${signature}
  `;

  return emailShell({
    title: `Credit memo ${cm_number || ''} — Roma Flooring Designs`,
    preheader: `Your return is processed — ${money(total)} ${hasRefund ? 'refunded' : 'added to your account'}.`,
    content,
  });
}
