// Construction estimate email — rebuilt on the shared Brass Charcoal shell
// (_shell.js), matching quoteSent.js. Groups line items into work sections
// (e.g. Demolition, Tile installation), each with a scope-of-work note and its
// own subtotal, and leads with a "View & Accept"
// CTA to the customer estimate page (/estimate/:public_token).
//
// opts.tracking adds an open-tracking pixel — only set when actually emailing,
// never for the rep-facing preview (the preview iframe would log a fake open).
import { emailShell, heroSection, ctaButton, warmCard, section, sectionLabel, detailList, money, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';
import { LINEAR_LABOR_CATS } from '../lib/estimateBundle.js';
import { composeItemName } from '../lib/documents.js';

const num = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;

const LABOR_CATEGORY_LABELS = {
  installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
  transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
  moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
};

function materialRow(item, isLast) {
  const rowBorder = isLast ? '' : `border-bottom:1px solid ${T.border};`;
  const composed = composeItemName(item);
  const name = esc(composed.nameLine || item.product_name || 'Product');
  const topLine = composed.vendor ? esc(composed.vendor) : '';
  const skuText = composed.sku ? esc(composed.sku) : '';
  const subLine = '';
  const isUnit = item.sell_by === 'unit';
  const qty = item.num_boxes || item.quantity || 1;
  const sqft = num(item.sqft_needed);
  const qtyLine = isUnit
    ? `${qty} ea`
    : `${qty} ${qty === 1 ? 'box' : 'boxes'}${sqft ? ' &middot; ' + sqft.toFixed(1) + ' sf' : ''}`;
  const thumb = item.primary_image
    ? `<img src="${esc(emailImage(item.primary_image, 72, 72))}" alt="${name}" width="72" style="display:block;width:72px;height:auto;" />`
    : `<div style="width:72px;height:72px;background:${T.warm};border:1px solid ${T.border};"></div>`;

  return `<tr>
    <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">${thumb}</td>
    <td valign="middle" style="padding:16px 0;${rowBorder}">
      ${topLine ? `<p style="margin:0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${topLine}</p>` : ''}
      <p style="margin:${topLine ? '4px' : '0'} 0 0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${name}</p>
      ${skuText ? `<p style="margin:3px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${skuText}</p>` : ''}
      ${subLine ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.soft};">${subLine}</p>` : ''}
      <p style="margin:6px 0 0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">${qtyLine}</p>
    </td>
    <td valign="middle" align="right" style="padding:16px 0 16px 12px;${rowBorder}white-space:nowrap;">
      <p style="margin:0;font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(item.subtotal)}</p>
    </td>
  </tr>`;
}

function laborRow(item, isLast) {
  const rowBorder = isLast ? '' : `border-bottom:1px solid ${T.border};`;
  const cat = item.labor_category === 'other' && item.product_name
    ? esc(item.product_name)
    : (LABOR_CATEGORY_LABELS[item.labor_category] || esc(item.labor_category || 'Service'));
  const u = LINEAR_LABOR_CATS[item.labor_category] ? 'lf' : 'sf';
  const desc = item.description
    ? item.description.split('\n').map((line, i) => i === 0 ? esc(line) : '&bull; ' + esc(line)).join('<br>')
    : '';
  const rateLine = item.rate_type === 'per_sqft'
    ? `${money(item.rate_sqft)}/${u} &middot; ${num(item.labor_sqft).toFixed(0)} ${u}`
    : (num(item.quantity) > 1 ? `${money(item.unit_price)} &times; ${num(item.quantity).toFixed(0)}` : 'Flat rate');

  return `<tr>
    <td width="72" valign="middle" style="padding:16px 16px 16px 0;${rowBorder}">
      <div style="width:72px;height:72px;background:${T.warm};border:1px solid ${T.border};text-align:center;">
        <span style="font-family:${MONO};font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.ink};line-height:72px;">Labor</span>
      </div>
    </td>
    <td valign="middle" style="padding:16px 0;${rowBorder}">
      <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.2;letter-spacing:-0.012em;color:${T.ink};">${cat}</p>
      ${desc ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:1.4;color:${T.soft};">${desc}</p>` : ''}
      <p style="margin:6px 0 0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">${rateLine}</p>
    </td>
    <td valign="middle" align="right" style="padding:16px 0 16px 12px;${rowBorder}white-space:nowrap;">
      <p style="margin:0;font-family:${SERIF};font-size:22px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(item.subtotal)}</p>
    </td>
  </tr>`;
}

// A titled group — "Materials" or "Labor & services" — with an optional scope
// paragraph (labor only) above its rows.
function groupBlock(title, rowsHtml, scopeHtml) {
  return section(`
    <p style="margin:0 0 8px;padding:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};border-bottom:2px solid ${T.ink};">${title}</p>
    ${scopeHtml || ''}
    ${rowsHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>` : ''}
  `, '8px 40px 20px');
}

export function generateEstimateSentHTML(data, opts = {}) {
  const {
    id, estimate_number, customer_name, project_name,
    materials_subtotal, labor_subtotal, tax_amount, total, deposit_amount,
    created_at, expires_at, public_token, scope_of_work,
    rep_first_name, rep_last_name, rep_email,
    materialItems = [], laborItems = [], milestones = []
  } = data;
  const deposit = num(deposit_amount);

  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  const repName = [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'our showroom team';
  const repInitials = [rep_first_name, rep_last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || 'R';
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(created_at) || 'today';
  const validUntil = longDate(expires_at);

  // Two fixed groups: Materials, then Labor & services (with the scope of work).
  const hasScope = scope_of_work && scope_of_work.trim();
  const materialsHtml = materialItems.length
    ? groupBlock('Materials', materialItems.map((it, i) => materialRow(it, i === materialItems.length - 1)).join(''))
    : '';
  const scopeHtml = hasScope
    ? `<p style="margin:0 0 14px;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.body};white-space:pre-wrap;">${esc(scope_of_work)}</p>` : '';
  const laborHtml = (laborItems.length || hasScope)
    ? groupBlock('Labor &amp; services', laborItems.map((it, i) => laborRow(it, i === laborItems.length - 1)).join(''), scopeHtml)
    : '';
  const itemsBlock = materialsHtml + laborHtml;

  // Totals — warm card with the big serif grand total.
  const totalsRows = [
    ['Materials', money(materials_subtotal), T.ink],
    ['Labor &amp; services', money(labor_subtotal), T.ink],
    num(tax_amount) > 0 ? ['Tax &middot; materials only', money(tax_amount), T.soft] : null,
  ].filter(Boolean);
  const totalsBlock = section(warmCard(`
    ${totalsRows.map(([k, v, col]) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.soft};">${k}</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:13px;color:${col};">${v}</td>
      </tr></table>`).join('')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid ${T.border};"><tr>
      <td style="padding-top:12px;font-family:${SANS};font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.ink};">Estimate total</td>
      <td align="right" style="padding-top:12px;font-family:${SERIF};font-size:32px;font-weight:300;letter-spacing:-0.01em;color:${T.ink};">${money(total)}</td>
    </tr></table>
    ${deposit > 0 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr>
      <td style="font-family:${SANS};font-size:12px;font-weight:500;color:${T.accent};">Deposit to get started</td>
      <td align="right" style="font-family:${SANS};font-size:14px;font-weight:600;color:${T.accent};">${money(deposit)}</td>
    </tr></table>` : ''}
    ${(milestones && milestones.length) ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid ${T.border};">
      <tr><td colspan="2" style="padding-top:12px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.accent};">Payment schedule</td></tr>
      ${milestones.map(m => `<tr>
        <td style="padding:5px 0;font-family:${SANS};font-size:12px;color:${T.soft};">${esc(m.label)}${m.percent ? ` &middot; ${parseFloat(m.percent)}%` : ''}${m.due_label ? ` <span style="color:${T.muted};">(${esc(m.due_label)})</span>` : ''}</td>
        <td align="right" style="padding:5px 0;font-family:${SANS};font-size:12px;color:${T.ink};">${money(m.amount)}</td>
      </tr>`).join('')}
    </table>` : ''}
  `, '20px 22px'), '0 40px 8px');

  const estimateUrl = public_token ? `${siteUrl}/estimate/${public_token}` : null;

  // Signature — reply note + the actual rep.
  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions or changes? Reply to this email &mdash; it goes straight to ${esc(repName)} at our Anaheim showroom, not a bot.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
      <td width="40" valign="middle">
        <div style="width:40px;height:40px;border-radius:50%;background:${T.warm};border:1px solid ${T.border};text-align:center;font-family:${SERIF};font-size:16px;line-height:40px;color:${T.ink};">${esc(repInitials)}</div>
      </td>
      <td valign="middle" style="padding-left:14px;">
        <p style="margin:0;font-family:${SERIF};font-size:16px;line-height:1.1;letter-spacing:-0.008em;color:${T.ink};">${esc(repName)}</p>
        <p style="margin:4px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.muted};">Your sales rep &middot; Roma Flooring${rep_email ? ` &middot; <a href="mailto:${esc(rep_email)}" style="color:${T.accent};text-decoration:none;">${esc(rep_email)}</a>` : ''}</p>
      </td>
    </tr></table>
  `, '0 40px 36px');

  const metaBlock = section(detailList([
    { label: 'Estimate', value: esc(estimate_number) },
    { label: 'Prepared', value: issued },
    project_name ? { label: 'Project', value: esc(project_name) } : null,
    validUntil ? { label: 'Valid until', value: validUntil } : null,
  ].filter(Boolean)), '4px 40px 8px');

  const trackingPixel = (opts.tracking && id)
    ? section(`<img src="${siteUrl}/api/estimates/${id}/open.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`, '0')
    : '';

  // Reminder variant: same itemized body, but the hero + chip lead with the
  // expiry instead of the "ready" announcement. Sent by the expiry cron.
  const hero = opts.reminder
    ? heroSection({
        eyebrow: `Estimate expiring soon &middot; ${esc(estimate_number || '')}`,
        headline: `A quick <em style="color:${T.accent};">reminder</em>.`,
        body: `Hi ${esc(firstName)} &mdash; ${esc(repName)}&rsquo;s construction estimate${project_name ? ` for <span style="color:${T.ink};font-weight:500;">${esc(project_name)}</span>` : ''} is still open,` +
          (validUntil ? ` but it expires on <span style="color:${T.ink};font-weight:500;">${validUntil}</span>. Accept it online below, or just reply and we&rsquo;ll refresh the pricing for you.` : ` and it&rsquo;s about to expire. Accept it online below, or reply and we&rsquo;ll refresh the pricing for you.`),
        chip: validUntil ? `&#9201; Expires ${validUntil}` : null
      })
    : heroSection({
        eyebrow: `Construction estimate &middot; ${esc(estimate_number || '')}`,
        headline: `Your estimate, <em style="color:${T.accent};">ready</em>.`,
        body: `Hi ${esc(firstName)} &mdash; ${esc(repName)} put together a construction estimate${project_name ? ` for <span style="color:${T.ink};font-weight:500;">${esc(project_name)}</span>` : ''}, covering both materials and labor.` +
          (validUntil ? ` It&rsquo;s valid through <span style="color:${T.ink};font-weight:500;">${validUntil}</span>.` : ''),
        chip: validUntil ? `&#9201; Valid until ${validUntil}` : null
      });

  const content = `
    ${hero}
    ${metaBlock}
    ${estimateUrl ? ctaButton({
      href: estimateUrl,
      label: 'View &amp; accept your estimate &rarr;',
      note: deposit > 0
        ? `Accept online and secure your project with a ${money(deposit)} deposit &middot; or reply to this email`
        : 'Review the full itemized breakdown online and accept or decline &middot; or reply to this email'
    }) : ''}
    ${itemsBlock}
    ${totalsBlock}
    ${signature}
    ${trackingPixel}
  `;

  return emailShell({
    title: opts.reminder
      ? `Your Roma estimate expires soon — ${estimate_number || ''}`
      : `Your Roma estimate — ${estimate_number || ''}`,
    preheader: opts.reminder
      ? `Hi ${firstName} — your ${money(total)} estimate${project_name ? ' for ' + project_name : ''} is still open` +
        (validUntil ? ` but expires ${validUntil}. Accept online before it lapses.` : ' but about to expire. Accept online before it lapses.')
      : `Hi ${firstName} — your construction estimate${project_name ? ' for ' + project_name : ''}, ${money(total)} total.` +
        (validUntil ? ` Valid until ${validUntil}.` : ''),
    content
  });
}
