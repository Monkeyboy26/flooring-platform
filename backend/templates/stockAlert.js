// Back-in-stock alert email, rebuilt on the shared "Brass Charcoal" shell
// (_shell.js) so it matches the rest of the transactional emails
// (sampleRequestConfirmation.js / estimateSent.js / quoteSent.js).
// Confirms the watched item is available again and links straight to the PDP.
import { emailShell, heroSection, section, ctaButton, warmCard, T, SERIF, SANS, MONO, esc, emailImage } from './_shell.js';

export function generateStockAlertHTML(data) {
  const { product_name, variant_name, sku_code, primary_image, product_url } = data;
  const displayName = esc(variant_name ? `${product_name} — ${variant_name}` : product_name);

  const thumb = primary_image
    ? `<img src="${esc(emailImage(primary_image, 240, 180))}" alt="${displayName}" width="240" style="display:block;width:240px;max-width:100%;height:auto;margin:0 auto;border:1px solid ${T.border};" />`
    : `<div style="width:240px;max-width:100%;height:180px;margin:0 auto;background:${T.warm};border:1px solid ${T.border};"></div>`;

  const productCard = section(warmCard(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:0 0 18px;text-align:center;">${thumb}</td></tr>
      <tr><td style="text-align:center;">
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 12px;"><tr>
          <td style="padding:6px 13px;background:${T.ink};font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:${T.paper};">&#9679; In stock</td>
        </tr></table>
        <p style="margin:0;font-family:${SERIF};font-size:24px;line-height:1.15;letter-spacing:-0.012em;color:${T.ink};">${displayName}</p>
        ${sku_code ? `<p style="margin:6px 0 0;font-family:${MONO};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${T.soft};">SKU ${esc(sku_code)}</p>` : ''}
      </td></tr>
    </table>
  `, '24px 24px'), '4px 40px 20px');

  const noteBlock = section(`
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.body};">
      Inventory moves quickly &mdash; once it&rsquo;s gone it may be a while before it&rsquo;s back. Questions on coverage or lead time?
      Reply here or call <span style="color:${T.ink};font-weight:500;">(714)&nbsp;999-0009</span> and we&rsquo;ll help you order.
    </p>
  `, '8px 40px 36px');

  const content = `
    ${heroSection({
      eyebrow: 'Back in stock',
      headline: `It&rsquo;s <em style="color:${T.accent};">available</em> again.`,
      body: `Good news &mdash; an item you asked us to watch is back in stock and ready to order.`,
    })}
    ${productCard}
    ${ctaButton({ href: product_url, label: 'Shop this item' })}
    ${noteBlock}
  `;

  return emailShell({
    title: `Back in stock — ${product_name || 'your item'}`,
    preheader: `${variant_name ? `${product_name} — ${variant_name}` : product_name} is back in stock and ready to order.`,
    content
  });
}
