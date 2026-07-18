const BASE = process.env.SITE_URL || 'http://localhost:3001';
export const LOGO_URL = BASE + '/assets/logo/roma-square.png';
export const SITE_URL = BASE;

// CAN-SPAM: every MARKETING email must include the physical address and a
// working unsubscribe link (transactional emails are exempt). Pass the
// subscriber's unsubscribe_token from newsletter_subscribers.
export const BUSINESS_ADDRESS = 'Roma Flooring Designs · 1440 South State College Blvd #6M, Anaheim, CA 92806';
export const unsubscribeUrl = (token) => `${BASE}/api/newsletter/unsubscribe/${token}`;
export const marketingFooter = (token) => `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e7e2db;font-size:12px;line-height:1.6;color:#a8a29e;text-align:center">
    ${BUSINESS_ADDRESS}<br>
    You received this email because you subscribed to updates from Roma Flooring Designs.<br>
    <a href="${unsubscribeUrl(token)}" style="color:#78716c">Unsubscribe</a>
  </div>`;
