import { LOGO_URL } from './_config.js';

export function generateInvoiceSentHTML(invoice) {
  const {
    invoice_number, customer_name, customer_email,
    issue_date, due_date, payment_terms,
    subtotal, tax_amount, shipping, discount_amount, total, balance,
    items = []
  } = invoice;

  const itemRows = items.map(item => {
    const desc = esc(item.description || 'Item');
    const qty = parseFloat(item.qty || 1);
    const price = '$' + parseFloat(item.subtotal || 0).toFixed(2);
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;">${desc}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;text-align:center;">${qty}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">${price}</td>
    </tr>`;
  }).join('');

  const termsLabel = (payment_terms || 'due_on_receipt').replace(/_/g, ' ');
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf9;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e7e5e4;">

  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" width="140" height="140" style="display:block;margin:0 auto;width:140px;height:140px;" />
  </td></tr>

  <tr><td style="padding:40px 40px 20px;">
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">Invoice ${esc(invoice_number)}</h1>
    <p style="margin:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.6;">
      Hi ${esc(customer_name)},<br><br>
      Please find your invoice below. Payment is ${termsLabel}.
    </p>
  </td></tr>

  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;" width="50%">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Issue Date</p>
          <p style="margin:4px 0 0;font-size:14px;font-weight:500;color:#292524;">${fmtDate(issue_date)}</p>
        </td>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;" width="50%">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Due Date</p>
          <p style="margin:4px 0 0;font-size:14px;font-weight:500;color:#292524;">${fmtDate(due_date)}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;">Item</td>
        <td style="padding:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:center;">Qty</td>
        <td style="padding:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:right;">Amount</td>
      </tr>
      ${itemRows}
    </table>
  </td></tr>

  <tr><td style="padding:0 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:6px 0;font-size:14px;color:#57534e;">Subtotal</td><td style="padding:6px 0;font-size:14px;color:#292524;text-align:right;">$${parseFloat(subtotal || 0).toFixed(2)}</td></tr>
      ${parseFloat(tax_amount || 0) > 0 ? `<tr><td style="padding:6px 0;font-size:14px;color:#57534e;">Tax</td><td style="padding:6px 0;font-size:14px;color:#292524;text-align:right;">$${parseFloat(tax_amount).toFixed(2)}</td></tr>` : ''}
      ${parseFloat(shipping || 0) > 0 ? `<tr><td style="padding:6px 0;font-size:14px;color:#57534e;">Shipping</td><td style="padding:6px 0;font-size:14px;color:#292524;text-align:right;">$${parseFloat(shipping).toFixed(2)}</td></tr>` : ''}
      ${parseFloat(discount_amount || 0) > 0 ? `<tr><td style="padding:6px 0;font-size:14px;color:#57534e;">Discount</td><td style="padding:6px 0;font-size:14px;color:#292524;text-align:right;">-$${parseFloat(discount_amount).toFixed(2)}</td></tr>` : ''}
      <tr><td style="padding:12px 0 0;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;">Total</td><td style="padding:12px 0 0;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;text-align:right;">$${parseFloat(total || 0).toFixed(2)}</td></tr>
      ${parseFloat(balance || 0) < parseFloat(total || 0) ? `<tr><td style="padding:6px 0;font-size:14px;color:#57534e;">Balance Due</td><td style="padding:6px 0;font-size:14px;font-weight:600;color:#dc2626;text-align:right;">$${parseFloat(balance || total || 0).toFixed(2)}</td></tr>` : ''}
    </table>
  </td></tr>

  <tr><td style="padding:0 40px 40px;text-align:center;">
    <p style="margin:0;font-size:14px;color:#57534e;line-height:1.6;">
      To make a payment or if you have questions, please contact us at (714) 999-0009 or reply to this email.
    </p>
  </td></tr>

  <tr><td style="padding:24px 40px;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;letter-spacing:2px;color:#a8a29e;">ROMA FLOORING DESIGNS</p>
    <p style="margin:8px 0 0;font-size:11px;color:#a8a29e;">License #830966 | www.romaflooringdesigns.com</p>
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
