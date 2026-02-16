function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function generateTradeDenialHTML(customer) {
  const reason = customer.denial_reason ? `<p style="color:#57534e;line-height:1.6;margin:0 0 16px;"><strong>Reason:</strong> ${esc(customer.denial_reason)}</p>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px 40px 20px;text-align:center;border-bottom:1px solid #e7e5e4;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0;">Roma Flooring Designs</h1>
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#78716c;margin:8px 0 0;">Trade Program</p>
  </td></tr>
  <tr><td style="padding:40px;">
    <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:400;color:#1c1917;margin:0 0 16px;">Trade Application Update</h2>
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">Dear ${esc(customer.contact_name)},</p>
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">Thank you for your interest in our trade program. Unfortunately, we are unable to approve your application for <strong>${esc(customer.company_name)}</strong> at this time.</p>
    ${reason}
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">If you believe this was in error or would like to provide additional documentation, please don't hesitate to contact us.</p>
    <p style="color:#57534e;line-height:1.6;margin:0;">We appreciate your understanding and hope to work with you in the future.</p>
  </td></tr>
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-size:12px;color:#78716c;">Roma Flooring Designs | 1440 S. State College Blvd #6M, Anaheim, CA 92806 | (714) 999-0009</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
