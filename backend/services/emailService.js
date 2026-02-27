import nodemailer from 'nodemailer';
import { generateOrderConfirmationHTML } from '../templates/orderConfirmation.js';
import { generateQuoteSentHTML } from '../templates/quoteSent.js';
import { generateOrderStatusUpdateHTML } from '../templates/orderStatusUpdate.js';
import { generateTradeApprovalHTML } from '../templates/tradeApproval.js';
import { generateTradeDenialHTML } from '../templates/tradeDenial.js';
import { generateTierPromotionHTML } from '../templates/tierPromotion.js';
import { generateRenewalReminderHTML } from '../templates/renewalReminder.js';
import { generateSubscriptionWarningHTML } from '../templates/subscriptionWarning.js';
import { generateSubscriptionLapsedHTML } from '../templates/subscriptionLapsed.js';
import { generateSubscriptionDeactivatedHTML } from '../templates/subscriptionDeactivated.js';
import { generateInstallationInquiryStaffHTML } from '../templates/installationInquiryStaff.js';
import { generateInstallationInquiryConfirmationHTML } from '../templates/installationInquiryConfirmation.js';
import { generatePasswordResetHTML } from '../templates/passwordReset.js';
import { generateVisitRecapHTML } from '../templates/visitRecap.js';
import { generateSampleRequestConfirmationHTML } from '../templates/sampleRequestConfirmation.js';
import { generateSampleRequestShippedHTML } from '../templates/sampleRequestShipped.js';
import { generateStockAlertHTML } from '../templates/stockAlert.js';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@romaflooringdesigns.com';
const BRAND_NAME = 'Roma Flooring Designs';

let transporter = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log(`[Email] SMTP transporter configured (${SMTP_HOST}:${SMTP_PORT})`);
} else {
  console.log('[Email] SMTP not configured — emails will be skipped. Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable.');
}

/**
 * Send order confirmation email to customer.
 */
export async function sendOrderConfirmation(orderData) {
  if (!transporter) {
    console.log(`[Email] Skipping order confirmation for ${orderData.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateOrderConfirmationHTML(orderData);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: orderData.customer_email,
      subject: `Order Confirmed — ${orderData.order_number}`,
      html
    });
    console.log(`[Email] Order confirmation sent to ${orderData.customer_email} for ${orderData.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send order confirmation for ${orderData.order_number}:`, err.message);
  }
}

/**
 * Send quote email to customer.
 */
export async function sendQuoteSent(quoteData) {
  if (!transporter) {
    console.log(`[Email] Skipping quote email for ${quoteData.quote_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateQuoteSentHTML(quoteData);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: quoteData.customer_email,
      replyTo: quoteData.rep_email,
      subject: `Your Custom Quote — ${quoteData.quote_number}`,
      html
    });
    console.log(`[Email] Quote email sent to ${quoteData.customer_email} for ${quoteData.quote_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send quote email for ${quoteData.quote_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send order status update email to customer.
 */
export async function sendOrderStatusUpdate(orderData, status) {
  if (!['shipped', 'delivered', 'cancelled'].includes(status)) return;
  if (!transporter) {
    console.log(`[Email] Skipping status update (${status}) for ${orderData.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateOrderStatusUpdateHTML(orderData, status);
    if (!html) return;

    const subjectMap = {
      shipped: `Your Order Has Shipped — ${orderData.order_number}`,
      delivered: `Your Order Has Been Delivered — ${orderData.order_number}`,
      cancelled: `Order Cancelled — ${orderData.order_number}`
    };

    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: orderData.customer_email,
      subject: subjectMap[status],
      html
    });
    console.log(`[Email] Status update (${status}) sent to ${orderData.customer_email} for ${orderData.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send status update (${status}) for ${orderData.order_number}:`, err.message);
  }
}

/**
 * Send trade approval email.
 */
export async function sendTradeApproval(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping trade approval email for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateTradeApprovalHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Trade Application Approved — Welcome!',
      html
    });
    console.log(`[Email] Trade approval sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send trade approval to ${customer.email}:`, err.message);
  }
}

/**
 * Send trade denial email.
 */
export async function sendTradeDenial(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping trade denial email for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateTradeDenialHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Trade Application Update',
      html
    });
    console.log(`[Email] Trade denial sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send trade denial to ${customer.email}:`, err.message);
  }
}

/**
 * Send tier promotion email.
 */
export async function sendTierPromotion(customer, tierName) {
  if (!transporter) {
    console.log(`[Email] Skipping tier promotion email for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateTierPromotionHTML(customer, tierName);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: `Congratulations! You've been promoted to ${tierName}`,
      html
    });
    console.log(`[Email] Tier promotion (${tierName}) sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send tier promotion to ${customer.email}:`, err.message);
  }
}

/**
 * Send 2FA verification code.
 */
export async function send2FACode(email, code) {
  if (!transporter) {
    console.log(`[Email] Skipping 2FA code for ${email} — SMTP not configured`);
    return;
  }
  try {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px;text-align:center;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0 0 24px;">Roma Flooring Designs</h1>
    <p style="color:#57534e;font-size:16px;margin:0 0 24px;">Your verification code is:</p>
    <div style="background:#f5f5f4;display:inline-block;padding:16px 40px;margin:0 0 24px;letter-spacing:8px;font-size:32px;font-weight:500;color:#1c1917;">${code}</div>
    <p style="color:#78716c;font-size:13px;margin:0;">This code expires in 10 minutes. If you didn't request this, please ignore this email.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: email,
      subject: `Your verification code: ${code}`,
      html
    });
    console.log(`[Email] 2FA code sent to ${email}`);
  } catch (err) {
    console.error(`[Email] Failed to send 2FA code to ${email}:`, err.message);
  }
}

/**
 * Send renewal reminder email (30 days before expiry).
 */
export async function sendRenewalReminder(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping renewal reminder for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateRenewalReminderHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Trade Membership Renewal Reminder',
      html
    });
    console.log(`[Email] Renewal reminder sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send renewal reminder to ${customer.email}:`, err.message);
  }
}

/**
 * Send subscription warning email (payment failed, grace period started).
 */
export async function sendSubscriptionWarning(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping subscription warning for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSubscriptionWarningHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Action Required — Trade Membership Payment Issue',
      html
    });
    console.log(`[Email] Subscription warning sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send subscription warning to ${customer.email}:`, err.message);
  }
}

/**
 * Send subscription lapsed email (membership suspended).
 */
export async function sendSubscriptionLapsed(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping subscription lapsed for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSubscriptionLapsedHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Trade Membership Suspended',
      html
    });
    console.log(`[Email] Subscription lapsed sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send subscription lapsed to ${customer.email}:`, err.message);
  }
}

/**
 * Send subscription deactivated email (grace period expired).
 */
export async function sendSubscriptionDeactivated(customer) {
  if (!transporter) {
    console.log(`[Email] Skipping subscription deactivated for ${customer.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSubscriptionDeactivatedHTML(customer);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: customer.email,
      subject: 'Trade Membership Deactivated',
      html
    });
    console.log(`[Email] Subscription deactivated sent to ${customer.email}`);
  } catch (err) {
    console.error(`[Email] Failed to send subscription deactivated to ${customer.email}:`, err.message);
  }
}

/**
 * Send installation inquiry notification to staff.
 */
export async function sendInstallationInquiryNotification(inquiry) {
  if (!transporter) {
    console.log(`[Email] Skipping installation inquiry notification for ${inquiry.customer_email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateInstallationInquiryStaffHTML(inquiry);
    const toAddress = process.env.INSTALLATION_NOTIFY_EMAIL || 'Sales@romaflooringdesigns.com';
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: toAddress,
      replyTo: inquiry.customer_email,
      subject: `New Installation Inquiry — ${inquiry.customer_name}`,
      html
    });
    console.log(`[Email] Installation inquiry notification sent to ${toAddress} for ${inquiry.customer_email}`);
  } catch (err) {
    console.error(`[Email] Failed to send installation inquiry notification for ${inquiry.customer_email}:`, err.message);
  }
}

/**
 * Send installation inquiry confirmation to customer.
 */
export async function sendInstallationInquiryConfirmation(inquiry) {
  if (!transporter) {
    console.log(`[Email] Skipping installation inquiry confirmation for ${inquiry.customer_email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateInstallationInquiryConfirmationHTML(inquiry);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: inquiry.customer_email,
      subject: 'Installation Inquiry Received — Roma Flooring Designs',
      html
    });
    console.log(`[Email] Installation inquiry confirmation sent to ${inquiry.customer_email}`);
  } catch (err) {
    console.error(`[Email] Failed to send installation inquiry confirmation to ${inquiry.customer_email}:`, err.message);
  }
}

/**
 * Send purchase order PDF to vendor via email.
 */
export async function sendPurchaseOrderToVendor({ vendor_email, vendor_name, po_number, is_revised, pdf_buffer }) {
  if (!transporter) {
    console.log(`[Email] Skipping PO email for ${po_number} to ${vendor_email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const subject = is_revised
      ? `Revised Purchase Order — ${po_number}`
      : `Purchase Order — ${po_number}`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px;text-align:center;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0 0 24px;">Roma Flooring Designs</h1>
    <p style="color:#57534e;font-size:16px;margin:0 0 8px;">Dear ${vendor_name || 'Vendor'},</p>
    <p style="color:#57534e;font-size:16px;margin:0 0 24px;">
      ${is_revised ? 'Please find the revised purchase order attached.' : 'Please find the attached purchase order for your review.'}
    </p>
    <div style="background:#f5f5f4;display:inline-block;padding:12px 32px;margin:0 0 24px;font-size:18px;font-weight:500;color:#1c1917;">
      ${po_number}
    </div>
    <p style="color:#78716c;font-size:13px;margin:0;">
      If you have any questions, please contact us at (714) 999-0009 or Sales@romaflooringdesigns.com
    </p>
  </td></tr>
  <tr><td style="padding:16px 40px;background:#fafaf9;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: vendor_email,
      subject,
      html,
      attachments: [{ filename: `${po_number}.pdf`, content: pdf_buffer, contentType: 'application/pdf' }]
    });
    console.log(`[Email] PO ${po_number} sent to ${vendor_email}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send PO ${po_number} to ${vendor_email}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send password reset email to customer.
 */
export async function sendPasswordReset(email, resetUrl) {
  if (!transporter) {
    console.log(`[Email] Skipping password reset for ${email} — SMTP not configured`);
    return;
  }
  try {
    const html = generatePasswordResetHTML(resetUrl);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: email,
      subject: 'Reset Your Password — Roma Flooring Designs',
      html
    });
    console.log(`[Email] Password reset sent to ${email}`);
  } catch (err) {
    console.error(`[Email] Failed to send password reset to ${email}:`, err.message);
  }
}

/**
 * Send payment request email to customer with Stripe checkout link.
 */
export async function sendPaymentRequest({ order, amount, checkout_url, message }) {
  if (!transporter) {
    console.log(`[Email] Skipping payment request for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px;text-align:center;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0 0 24px;">Roma Flooring Designs</h1>
    <p style="color:#57534e;font-size:16px;margin:0 0 8px;">Payment Required for Order <strong>${order.order_number}</strong></p>
    <p style="color:#57534e;font-size:14px;margin:0 0 24px;">
      There is a balance due of <strong>$${parseFloat(amount).toFixed(2)}</strong> on your order.
    </p>
    ${message ? `<p style="color:#57534e;font-size:14px;margin:0 0 24px;padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;text-align:left;">${message}</p>` : ''}
    <a href="${checkout_url}" style="display:inline-block;background:#1c1917;color:#fff;padding:14px 40px;text-decoration:none;font-size:16px;font-weight:500;margin:0 0 24px;">Pay Now — $${parseFloat(amount).toFixed(2)}</a>
    <p style="color:#78716c;font-size:12px;margin:0;">This payment link expires in 72 hours. If you have questions, contact us at (714) 999-0009.</p>
  </td></tr>
  <tr><td style="padding:16px 40px;background:#fafaf9;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: order.customer_email,
      subject: `Payment Required — Order ${order.order_number}`,
      html
    });
    console.log(`[Email] Payment request sent to ${order.customer_email} for ${order.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send payment request for ${order.order_number}:`, err.message);
  }
}

/**
 * Send payment received confirmation email.
 */
/**
 * Send visit recap email to customer.
 */
export async function sendVisitRecap(visitData) {
  if (!transporter) {
    console.log(`[Email] Skipping visit recap for ${visitData.customer_email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateVisitRecapHTML(visitData);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: visitData.customer_email,
      replyTo: visitData.rep_email,
      subject: 'Your Showroom Visit Recap — Roma Flooring Designs',
      html
    });
    console.log(`[Email] Visit recap sent to ${visitData.customer_email}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send visit recap to ${visitData.customer_email}:`, err.message);
    return { sent: false, error: err.message };
  }
}

export async function sendPaymentReceived(order, amount) {
  if (!transporter) {
    console.log(`[Email] Skipping payment received for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px;text-align:center;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0 0 24px;">Roma Flooring Designs</h1>
    <div style="background:#dcfce7;display:inline-block;padding:8px 20px;margin:0 0 24px;font-size:14px;font-weight:500;color:#166534;">Payment Received</div>
    <p style="color:#57534e;font-size:16px;margin:0 0 8px;">Thank you! We received your payment of <strong>$${parseFloat(amount).toFixed(2)}</strong> for order <strong>${order.order_number}</strong>.</p>
    <p style="color:#78716c;font-size:13px;margin:16px 0 0;">If you have questions, contact us at (714) 999-0009 or Sales@romaflooringdesigns.com</p>
  </td></tr>
  <tr><td style="padding:16px 40px;background:#fafaf9;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: order.customer_email,
      subject: `Payment Received — Order ${order.order_number}`,
      html
    });
    console.log(`[Email] Payment received confirmation sent to ${order.customer_email} for ${order.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send payment received for ${order.order_number}:`, err.message);
  }
}

/**
 * Send sample request confirmation email to customer.
 */
export async function sendSampleRequestConfirmation(data) {
  if (!transporter) {
    console.log(`[Email] Skipping sample request confirmation for ${data.request_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSampleRequestConfirmationHTML(data);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: data.customer_email,
      subject: `Sample Request Received — ${data.request_number}`,
      html
    });
    console.log(`[Email] Sample request confirmation sent to ${data.customer_email} for ${data.request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample request confirmation for ${data.request_number}:`, err.message);
  }
}

/**
 * Send sample request shipped email to customer.
 */
export async function sendSampleRequestShipped(data) {
  if (!transporter) {
    console.log(`[Email] Skipping sample request shipped for ${data.request_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSampleRequestShippedHTML(data);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: data.customer_email,
      subject: `Your Samples Have Shipped — ${data.request_number}`,
      html
    });
    console.log(`[Email] Sample request shipped sent to ${data.customer_email} for ${data.request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample request shipped for ${data.request_number}:`, err.message);
  }
}

/**
 * Send scraper failure notification to admin staff.
 * Notifies SCRAPER_ALERT_EMAIL (or SMTP_FROM as fallback) when a scrape job fails.
 */
export async function sendScraperFailure({ source_name, scraper_key, job_id, error, started_at, duration_minutes }) {
  const alertEmail = process.env.SCRAPER_ALERT_EMAIL || SMTP_FROM;
  if (!transporter) {
    console.log(`[Email] Skipping scraper failure alert for ${scraper_key} — SMTP not configured`);
    return;
  }
  try {
    const html = `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #c0392b; margin-bottom: 16px;">Scraper Failed: ${source_name}</h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Scraper</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600;">${scraper_key}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Job ID</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px;">${job_id}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Started</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${started_at ? new Date(started_at).toLocaleString() : 'N/A'}</td></tr>
          ${duration_minutes != null ? `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Duration</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${duration_minutes} min</td></tr>` : ''}
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Error</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #c0392b;">${error}</td></tr>
        </table>
        <p style="margin-top: 20px; font-size: 13px; color: #888;">Check the admin panel for full job logs.</p>
      </div>
    `;
    await transporter.sendMail({
      from: `"${BRAND_NAME} Alerts" <${SMTP_FROM}>`,
      to: alertEmail,
      subject: `[Scraper Alert] ${source_name} failed`,
      html
    });
    console.log(`[Email] Scraper failure alert sent for ${scraper_key} (job ${job_id})`);
  } catch (err) {
    console.error(`[Email] Failed to send scraper failure alert for ${scraper_key}:`, err.message);
  }
}

/**
 * Send back-in-stock alert email.
 */
export async function sendStockAlert(data) {
  if (!transporter) {
    console.log(`[Email] Skipping stock alert for ${data.email} — SMTP not configured`);
    return;
  }
  try {
    const html = generateStockAlertHTML(data);
    await transporter.sendMail({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: data.email,
      subject: `Back in Stock — ${data.product_name}`,
      html
    });
    console.log(`[Email] Stock alert sent to ${data.email} for ${data.product_name}`);
  } catch (err) {
    console.error(`[Email] Failed to send stock alert to ${data.email}:`, err.message);
  }
}
