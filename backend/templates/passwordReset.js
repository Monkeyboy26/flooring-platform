function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function generatePasswordResetHTML(resetUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px 40px 20px;text-align:center;border-bottom:1px solid #e7e5e4;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0;">Roma Flooring Designs</h1>
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#78716c;margin:8px 0 0;">Account Security</p>
  </td></tr>
  <tr><td style="padding:40px;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="display:inline-block;width:48px;height:48px;background:#f5f5f4;border-radius:50%;line-height:48px;font-size:24px;">&#128274;</span>
    </div>
    <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:400;color:#1c1917;margin:0 0 16px;text-align:center;">Reset Your Password</h2>
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">We received a request to reset your password. Click the button below to choose a new password:</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${esc(resetUrl)}" style="display:inline-block;background:#b8960c;color:#fff;text-decoration:none;padding:14px 40px;font-size:14px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Reset Password</a>
    </div>
    <p style="color:#78716c;font-size:13px;line-height:1.6;margin:0 0 16px;">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
    <p style="color:#78716c;font-size:13px;line-height:1.6;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br/>
      <span style="color:#57534e;word-break:break-all;">${esc(resetUrl)}</span>
    </p>
  </td></tr>
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">Questions? Contact us at Sales@romaflooringdesigns.com</p>
    <p style="margin:0;font-size:12px;color:#78716c;">Roma Flooring Designs | 1440 S. State College Blvd #6M, Anaheim, CA 92806 | (714) 999-0009</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
