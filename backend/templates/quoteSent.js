export function generateQuoteSentHTML(quoteData) {
  const {
    quote_number, customer_name, customer_email,
    subtotal, shipping, total,
    rep_first_name, rep_last_name, rep_email,
    items = []
  } = quoteData;

  const itemRows = items.map(item => {
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const description = item.description ? esc(item.description) : '';
    const qty = `${item.quantity || item.num_boxes || 1}`;
    const price = `$${parseFloat(item.subtotal || item.unit_price || 0).toFixed(2)}`;

    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;">
        ${name}
        ${collection ? `<br><span style="color:#78716c;font-size:12px;">${collection}</span>` : ''}
        ${description ? `<br><span style="color:#78716c;font-size:12px;">${description}</span>` : ''}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;text-align:center;">${qty}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">${price}</td>
    </tr>`;
  }).join('');

  const repName = [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'Your Sales Representative';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Inter:wght@400;500&display=swap');</style>
</head>
<body style="margin:0;padding:0;background-color:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf9;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e7e5e4;">

  <!-- Header -->
  <tr><td style="padding:32px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;letter-spacing:4px;color:#292524;font-weight:600;">ROMA FLOORING DESIGNS</p>
  </td></tr>

  <!-- Title -->
  <tr><td style="padding:40px 40px 20px;">
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">Your Custom Quote</h1>
    <p style="margin:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.6;">
      Hi ${esc(customer_name)},<br><br>
      ${esc(repName)} has prepared a custom quote for you. Please review the details below.
    </p>
  </td></tr>

  <!-- Quote Number -->
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;">
          <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Quote Number</p>
          <p style="margin:4px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(quote_number)}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Items -->
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;">Item</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:center;">Qty</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:right;">Price</td>
      </tr>
      ${itemRows}
    </table>
  </td></tr>

  <!-- Totals -->
  <tr><td style="padding:0 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Subtotal</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">$${parseFloat(subtotal || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Shipping</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">${parseFloat(shipping || 0) > 0 ? '$' + parseFloat(shipping).toFixed(2) : 'TBD'}</td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;">Total</td>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;text-align:right;">$${parseFloat(total || 0).toFixed(2)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Rep Contact -->
  <tr><td style="padding:0 40px 32px;">
    <div style="padding:20px;background:#fafaf9;border:1px solid #e7e5e4;">
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Your Sales Representative</p>
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(repName)}</p>
      <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;">
        <a href="mailto:${esc(rep_email)}" style="color:#c9a668;">${esc(rep_email)}</a>
      </p>
    </div>
  </td></tr>

  <!-- CTA -->
  <tr><td style="padding:0 40px 40px;text-align:center;">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.6;">
      To proceed with this quote, simply reply to this email. We look forward to working with you.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 40px;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;letter-spacing:2px;color:#a8a29e;">ROMA FLOORING DESIGNS</p>
    <p style="margin:8px 0 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:#a8a29e;">Curated flooring &amp; surfaces for refined spaces</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
