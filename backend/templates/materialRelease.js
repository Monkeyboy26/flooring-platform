// Material release email — sent to the customer when a rep authorizes materials
// to leave the warehouse for pickup or delivery. Confirms which items + quantities
// were released and what to do next (bring the release number to Anaheim, or expect
// delivery). Built on the shared Brass Charcoal shell. Cadence-neutral copy.
import { emailShell, heroSection, section, detailList, ctaButton, warmCard, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { composeItemName, lineQtyUnit } from '../lib/documents.js';

const num = (v) => parseFloat(String(v ?? 0).replace(/,/g, '')) || 0;

export function generateMaterialReleaseHTML(data) {
  const {
    release_number, order_number, customer_name, recipient_name,
    release_method, created_at, notes, items = [], rep_name,
    po_number, distributor_name, distributor_address, distributor_phone,
  } = data;

  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(created_at) || 'today';
  const isDelivery = release_method === 'delivery';
  const isWillCall = release_method === 'will_call';

  const itemRows = items.map((it) => {
    const composed = composeItemName(it);
    const name = esc(composed.nameLine || it.description || it.product_name || 'Item');
    const brand = composed.vendor ? esc(composed.vendor) : '';
    const skuText = composed.sku ? esc(composed.sku) : '';
    const qty = num(it.qty) || 0;
    // Released qty is the material amount already (carpet in sqyd, LF for rug cuts);
    // label it per material without deriving from full-order coverage.
    const _qu = lineQtyUnit({ sell_by: it.sell_by, price_basis: it.price_basis }, qty);
    return {
      label: `${_qu.text} ${_qu.label}`,
      value: `${brand ? `<span style="font-size:12px;color:${T.muted};">${brand}</span><br>` : ''}<span style="color:${T.ink};">${name}</span>${skuText ? `<br><span style="font-size:12px;color:${T.muted};">${skuText}</span>` : ''}`,
    };
  });

  const itemsBlock = items.length
    ? section(`
        <p style="margin:0 0 14px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.muted};">Released &middot; ${items.length} item${items.length === 1 ? '' : 's'}</p>
        ${detailList(itemRows, 90)}
      `, '8px 40px 20px')
    : '';

  const distLoc = [distributor_address ? esc(distributor_address) : null, distributor_phone ? esc(distributor_phone) : null].filter(Boolean).join(' &middot; ');
  const nextStep = isWillCall
    ? `Your order is paid and ready to collect at <span style="color:${T.ink};font-weight:500;">${esc(distributor_name || 'the distributor')}</span>. Bring this release${po_number ? ` and reference purchase order <span style="color:${T.ink};font-weight:500;">${esc(po_number)}</span>` : ''} to pick up${recipient_name ? ` — authorized for <span style="color:${T.ink};font-weight:500;">${esc(recipient_name)}</span>` : ''}.`
    : isDelivery
    ? `These materials are staged and scheduled for <span style="color:${T.ink};font-weight:500;">delivery</span>. We'll be in touch to confirm the delivery window.`
    : `These materials are ready for <span style="color:${T.ink};font-weight:500;">pickup</span> at our Anaheim warehouse. Bring release <span style="color:${T.ink};font-weight:500;">${esc(release_number || '')}</span>${recipient_name ? ` — pickup is authorized for <span style="color:${T.ink};font-weight:500;">${esc(recipient_name)}</span>` : ''}.`;

  const nextBlock = section(warmCard(`
    <p style="margin:0 0 8px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};">${isDelivery ? 'What happens next' : 'Picking up'}</p>
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">${nextStep}</p>
    ${isWillCall
      ? (distLoc ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.soft};">${esc(distributor_name || '')}${distLoc ? ' &middot; ' + distLoc : ''}</p>` : '')
      : !isDelivery ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.soft};">Roma &middot; 1440 S. State College Blvd #6M, Anaheim, CA 92806 &middot; (714) 999-0009</p>` : ''}
    ${notes ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${T.soft};"><span style="color:${T.muted};">Note:</span> ${esc(notes)}</p>` : ''}
  `, '20px 22px'), '0 40px 20px');

  const signature = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Questions about this release? Reply to this email &mdash; it goes straight to ${esc(rep_name || 'our Anaheim showroom team')}, not a bot.
    </p>
  `, '0 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: `Material release &middot; ${esc(release_number || '')}`,
      headline: isDelivery
        ? `Your materials are <em style="color:${T.accent};">on the way</em>.`
        : `Your materials are <em style="color:${T.accent};">ready</em>.`,
      body: `Hi ${firstName} &mdash; we've released the items below from order ${esc(order_number || '')}, ${issued}.`,
      chip: order_number ? `Order ${esc(order_number)}` : null,
    })}
    ${itemsBlock}
    ${nextBlock}
    ${ctaButton({
      href: `${siteUrl}/account/orders`,
      label: 'View your order &rarr;',
      note: 'Sign in to your Roma account to see this order and its releases.',
    })}
    ${signature}
  `;

  return emailShell({
    title: `Material release ${release_number || ''} — Roma Flooring Designs`,
    preheader: isDelivery
      ? `Your materials from order ${order_number || ''} are released for delivery.`
      : `Your materials from order ${order_number || ''} are ready for pickup.`,
    content,
  });
}
