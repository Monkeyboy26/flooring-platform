import { LOGO_URL } from './_config.js';

export function generateInvoiceReminderHTML(invoice) {
  const {
    invoice_number, customer_name,
    due_date, total, balance
  } = invoice;

  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(due_date).getTime()) / (1000 * 60 * 60 * 24)));

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
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">Payment Reminder</h1>
    <p style="margin:12px 0 0;font-size:14px;color:#57534e;line-height:1.6;">
      Hi ${esc(customer_name)},<br><br>
      This is a friendly reminder that invoice <strong>${esc(invoice_number)}</strong> is ${daysOverdue > 0 ? daysOverdue + ' days past due' : 'due today'}.
    </p>
  </td></tr>

  <tr><td style="padding:0 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;padding:0;">
      <tr>
        <td style="padding:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;padding-bottom:4px;">Invoice</td>
              <td style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;padding-bottom:4px;text-align:center;">Due Date</td>
              <td style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;padding-bottom:4px;text-align:right;">Balance Due</td>
            </tr>
            <tr>
              <td style="font-size:16px;font-weight:500;color:#292524;">${esc(invoice_number)}</td>
              <td style="font-size:14px;color:#dc2626;text-align:center;">${fmtDate(due_date)}</td>
              <td style="font-size:16px;font-weight:600;color:#dc2626;text-align:right;">$${parseFloat(balance || total || 0).toFixed(2)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 40px 40px;text-align:center;">
    <p style="margin:0;font-size:14px;color:#57534e;line-height:1.6;">
      Please arrange payment at your earliest convenience. If you have already sent payment, please disregard this notice.<br><br>
      Contact us at (714) 999-0009 or Sales@romaflooringdesigns.com with any questions.
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
