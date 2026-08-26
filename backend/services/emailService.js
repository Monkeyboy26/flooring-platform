import nodemailer from 'nodemailer';
import { pool } from '../db.js';
import { generateOrderConfirmationHTML } from '../templates/orderConfirmation.js';
import { generateQuoteSentHTML } from '../templates/quoteSent.js';
import { generateOrderStatusUpdateHTML } from '../templates/orderStatusUpdate.js';
import { generateTradeApprovalHTML } from '../templates/tradeApproval.js';
import { generateTradeDenialHTML } from '../templates/tradeDenial.js';
import { generateTierPromotionHTML } from '../templates/tierPromotion.js';
import { generateInstallationInquiryStaffHTML } from '../templates/installationInquiryStaff.js';
import { generateInstallationInquiryConfirmationHTML } from '../templates/installationInquiryConfirmation.js';
import { generatePasswordResetHTML } from '../templates/passwordReset.js';
import { generateEmailChangeConfirmHTML } from '../templates/emailChangeConfirm.js';
import { generateEmailChangeNoticeHTML } from '../templates/emailChangeNotice.js';
import { generateStaffPasswordResetHTML } from '../templates/staffPasswordReset.js';
import { generateStaffInviteHTML } from '../templates/staffInvite.js';
import { generateVisitRecapHTML } from '../templates/visitRecap.js';
import { generateSampleRequestConfirmationHTML } from '../templates/sampleRequestConfirmation.js';
import { generateSampleRequestShippedHTML } from '../templates/sampleRequestShipped.js';
import { generateSampleRequestReadyHTML } from '../templates/sampleRequestReady.js';
import { generateStockAlertHTML } from '../templates/stockAlert.js';
import { generateInvoiceSentHTML } from '../templates/invoiceSent.js';
import { generateInvoiceReminderHTML } from '../templates/invoiceReminder.js';
import { generateSampleRequestVendorEmailHTML } from '../templates/sampleRequestVendor.js';
import { generateSampleShippingPaymentHTML } from '../templates/sampleShippingPayment.js';
import { generateWelcomeSetPasswordHTML } from '../templates/welcomeSetPassword.js';
import { generateWelcomeCustomerHTML } from '../templates/welcomeCustomer.js';
import { generateDailyHealthCheckHTML } from '../templates/dailyHealthCheck.js';
import { generateEstimateSentHTML } from '../templates/estimateSent.js';
import { generateEstimateAcceptedHTML } from '../templates/estimateAccepted.js';
import { generateProductShareHTML } from '../templates/productShare.js';
import { generatePaymentRequestHTML } from '../templates/paymentRequest.js';
import { generatePaymentReceivedHTML } from '../templates/paymentReceived.js';
import { generateCreditMemoIssuedHTML } from '../templates/creditMemoIssued.js';
import { generateMaterialReleaseHTML } from '../templates/materialRelease.js';
import { generateInstallScheduledHTML } from '../templates/installScheduled.js';
import { generateInstallCompleteHTML } from '../templates/installComplete.js';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@romaflooringdesigns.com';
const SALES_FROM = process.env.SALES_FROM || 'sales@romaflooringdesigns.com';
const BRAND_NAME = 'Roma Flooring Designs';
const DEFAULT_FROM = `"${BRAND_NAME}" <${SMTP_FROM}>`;

// Minimal HTML escaper for interpolating user/staff-entered text into email HTML.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Automated security (2FA, password reset, welcome) and bulk/system notifications
// (stock alerts, internal digests, scraper alerts) send from the no-reply address.
// No real noreply@ mailbox exists yet, so this defaults to the authenticated
// sending address (Sales@) — set the NOREPLY_FROM env var to a real, send-as-verified
// noreply@ once it exists to isolate these from the sales inbox / reps' reputation.
const NOREPLY_ADDR = process.env.NOREPLY_FROM || SMTP_FROM;
const NOREPLY_FROM = `"${BRAND_NAME}" <${NOREPLY_ADDR}>`;

// Scraper/pipeline ops alerts (failures, health check) go to the owner, not
// the shared sales inbox or the whole staff list.
export const SCRAPER_ALERT_ADDR = process.env.SCRAPER_ALERT_EMAIL || 'kian@romaflooringdesigns.com';

// Customer-facing mail is sent AS the responsible sales rep — reps use
// @romaflooringdesigns.com addresses, so this passes SPF/DKIM for the domain.
// Falls back to the brand address when no rep is known (e.g. self-serve
// storefront orders, system notifications). Reply-To is also the rep.
function repFrom(d = {}) {
  const email = d && d.rep_email;
  if (!email) return DEFAULT_FROM;
  const name = [d.rep_first_name, d.rep_last_name].filter(Boolean).join(' ').trim();
  return `"${name ? name + ' · ' + BRAND_NAME : BRAND_NAME}" <${email}>`;
}

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

const EMAIL_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.EMAIL_MAX_ATTEMPTS || '3', 10));
const EMAIL_RETRY_BASE_MS = Math.max(0, parseInt(process.env.EMAIL_RETRY_BASE_MS || '2000', 10));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send an email with retry + durable failure recording.
 *
 * Transactional emails are dispatched fire-and-forget (via setImmediate) from
 * request handlers, so a swallowed SMTP error used to mean a customer silently
 * never got their confirmation. deliver() retries transient failures with
 * exponential backoff and, once all attempts are exhausted, records the failure
 * in email_failures (queryable via GET /api/admin/email-failures) before
 * re-throwing so each caller's existing catch/log still runs.
 */
async function deliver(mailOptions) {
  let lastErr;
  for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt++) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastErr = err;
      if (attempt < EMAIL_MAX_ATTEMPTS) {
        await sleep(EMAIL_RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  // Every attempt failed — persist a durable record before giving up.
  try {
    const recipient = Array.isArray(mailOptions.to) ? mailOptions.to.join(', ') : (mailOptions.to || null);
    await pool.query(
      'INSERT INTO email_failures (recipient, subject, error_message, attempts) VALUES ($1, $2, $3, $4)',
      [recipient, mailOptions.subject || null, lastErr ? String(lastErr.message || lastErr) : 'unknown', EMAIL_MAX_ATTEMPTS]
    );
    console.error(`[Email] Delivery failed after ${EMAIL_MAX_ATTEMPTS} attempts to ${recipient} — recorded to email_failures`);
  } catch (dbErr) {
    console.error('[Email] Could not record email failure:', dbErr.message);
  }
  throw lastErr;
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
    await deliver({
      from: repFrom(orderData),
      to: orderData.customer_email,
      replyTo: orderData.rep_email,
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
export async function sendQuoteSent(quoteData, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping quote email for ${quoteData.quote_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateQuoteSentHTML(quoteData, { tracking: true });
    await deliver({
      from: repFrom(quoteData),
      to: quoteData.customer_email,
      replyTo: quoteData.rep_email,
      subject: `Your Roma quote ${quoteData.quote_number} — ready when you are`,
      html,
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {})
    });
    console.log(`[Email] Quote email sent to ${quoteData.customer_email} for ${quoteData.quote_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send quote email for ${quoteData.quote_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send credit-memo email to customer after a return is processed.
 */
export async function sendCreditMemoIssued(data, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping credit memo email for ${data.cm_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateCreditMemoIssuedHTML(data);
    const list = Array.isArray(data.settlement) ? data.settlement : [];
    const hasRefund = list.some(s => s.method !== 'store_credit');
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
      subject: `Credit memo ${data.cm_number} — your return is ${hasRefund ? 'refunded' : 'credited'}`,
      html,
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {})
    });
    console.log(`[Email] Credit memo email sent to ${data.customer_email} for ${data.cm_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send credit memo email for ${data.cm_number}:`, err.message);
    return { sent: false };
  }
}

export async function sendMaterialRelease(data, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping material release email for ${data.release_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateMaterialReleaseHTML(data);
    const isDelivery = data.release_method === 'delivery';
    const isWillCall = data.release_method === 'will_call';
    const subjectState = isDelivery ? 'released for delivery'
      : isWillCall ? `ready to pick up at ${data.distributor_name || 'the distributor'}`
      : 'ready for pickup';
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
      subject: `Material release ${data.release_number} — your order is ${subjectState}`,
      html,
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {})
    });
    console.log(`[Email] Material release email sent to ${data.customer_email} for ${data.release_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send material release email for ${data.release_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send order status update email to customer.
 */
export async function sendOrderStatusUpdate(orderData, status) {
  if (!['shipped', 'delivered', 'cancelled', 'ready_for_pickup'].includes(status)) return;
  if (!transporter) {
    console.log(`[Email] Skipping status update (${status}) for ${orderData.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateOrderStatusUpdateHTML(orderData, status);
    if (!html) return;

    const subjectMap = {
      shipped: `Your Order Has Shipped — ${orderData.order_number}`,
      ready_for_pickup: `Your Order Is Ready for Pickup — ${orderData.order_number}`,
      delivered: `Your Order Has Been Delivered — ${orderData.order_number}`,
      cancelled: `Order Cancelled — ${orderData.order_number}`
    };

    await deliver({
      from: repFrom(orderData),
      to: orderData.customer_email,
      replyTo: orderData.rep_email,
      subject: subjectMap[status],
      html
    });
    console.log(`[Email] Status update (${status}) sent to ${orderData.customer_email} for ${orderData.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send status update (${status}) for ${orderData.order_number}:`, err.message);
  }
}

/**
 * Send "installation scheduled" email to the customer (rep booked the date).
 */
export async function sendInstallScheduled(orderData) {
  if (!transporter) {
    console.log(`[Email] Skipping install-scheduled email for ${orderData.order_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateInstallScheduledHTML(orderData);
    if (!html) return { sent: false };
    await deliver({
      from: repFrom(orderData),
      to: orderData.customer_email,
      replyTo: orderData.rep_email,
      subject: `Your Installation Is Scheduled — ${orderData.order_number}`,
      html
    });
    console.log(`[Email] Install-scheduled sent to ${orderData.customer_email} for ${orderData.order_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send install-scheduled for ${orderData.order_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send "installation complete" email to the customer (job marked complete).
 */
export async function sendInstallComplete(orderData, balance) {
  if (!transporter) {
    console.log(`[Email] Skipping install-complete email for ${orderData.order_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateInstallCompleteHTML(orderData, balance);
    if (!html) return { sent: false };
    await deliver({
      from: repFrom(orderData),
      to: orderData.customer_email,
      replyTo: orderData.rep_email,
      subject: `Your Installation Is Complete — ${orderData.order_number}`,
      html
    });
    console.log(`[Email] Install-complete sent to ${orderData.customer_email} for ${orderData.order_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send install-complete for ${orderData.order_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Load active trade tiers (name, discount, spend threshold) ordered low→high.
 * Single source of truth for the tier ladder shown in trade emails. Returns []
 * on failure so templates fall back to their built-in defaults.
 */
async function loadTradeTiers() {
  try {
    const r = await pool.query(
      'SELECT name, discount_percent, spend_threshold, tier_level FROM margin_tiers WHERE is_active = true ORDER BY tier_level'
    );
    return r.rows;
  } catch (err) {
    console.error('[Email] Failed to load trade tiers:', err.message);
    return [];
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
    const tiers = await loadTradeTiers();
    const html = generateTradeApprovalHTML(customer, tiers);
    await deliver({
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
    await deliver({
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
    const tiers = await loadTradeTiers();
    const html = generateTierPromotionHTML(customer, tierName, tiers);
    await deliver({
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

    await deliver({
      from: NOREPLY_FROM,
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
 * Internal alert: a new storefront order landed. Without this, orders sit
 * unseen until someone opens the admin — the customer gets a confirmation
 * but staff got nothing.
 */
export async function sendNewOrderStaffAlert(order) {
  if (!transporter) {
    console.log(`[Email] Skipping new-order staff alert for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const toAddress = process.env.ORDER_NOTIFY_EMAIL || 'Sales@romaflooringdesigns.com';
    const items = Array.isArray(order.items) ? order.items : [];
    const itemRows = items.slice(0, 12).map(i =>
      `<tr><td style="padding:4px 12px 4px 0;color:#44403c;">${i.product_name || i.name || 'Item'}${i.variant_name ? ' — ' + i.variant_name : ''}</td>` +
      `<td style="padding:4px 0;color:#78716c;white-space:nowrap;">×${i.quantity || i.num_boxes || 1}</td></tr>`
    ).join('');
    const more = items.length > 12 ? `<p style="color:#78716c;">…and ${items.length - 12} more line(s)</p>` : '';
    const method = order.delivery_method === 'pickup' ? 'Pickup' : (order.delivery_method || 'Delivery');
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;">
        <h2 style="color:#1c1917;margin:0 0 4px;">New order ${order.order_number}</h2>
        <p style="font-size:22px;margin:0 0 16px;color:#1c1917;"><strong>$${parseFloat(order.total || 0).toFixed(2)}</strong> · ${method}</p>
        <p style="margin:0 0 16px;color:#44403c;">
          ${order.customer_name || 'Guest'} · ${order.customer_email || ''}${order.phone ? ' · ' + order.phone : ''}
        </p>
        <table style="border-collapse:collapse;font-size:14px;">${itemRows}</table>${more}
        <p style="margin:20px 0 0;">
          <a href="https://romaflooringdesigns.com/admin" style="color:#8a6d3b;">Open in admin</a>
        </p>
      </div>`;
    await deliver({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: toAddress,
      replyTo: order.customer_email || undefined,
      subject: `New order ${order.order_number} — $${parseFloat(order.total || 0).toFixed(2)} — ${order.customer_name || 'Guest'}`,
      html
    });
    console.log(`[Email] New-order staff alert sent to ${toAddress} for ${order.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send new-order staff alert for ${order.order_number}:`, err.message);
  }
}

/**
 * Personal new-order alert to the assigned sales rep. Complements the shared
 * staff alert: sent only when the order carries a rep (rep_email attached via
 * attachRep). Reply-To is the customer so the rep can respond in one step.
 */
export async function sendNewOrderRepAlert(order) {
  if (!order.rep_email) return;
  if (!transporter) {
    console.log(`[Email] Skipping new-order rep alert for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const items = Array.isArray(order.items) ? order.items : [];
    const itemRows = items.slice(0, 12).map(i =>
      `<tr><td style="padding:4px 12px 4px 0;color:#44403c;">${i.product_name || i.name || 'Item'}${i.variant_name ? ' — ' + i.variant_name : ''}</td>` +
      `<td style="padding:4px 0;color:#78716c;white-space:nowrap;">×${i.quantity || i.num_boxes || 1}</td></tr>`
    ).join('');
    const more = items.length > 12 ? `<p style="color:#78716c;">…and ${items.length - 12} more line(s)</p>` : '';
    const method = order.delivery_method === 'pickup' ? 'Pickup' : (order.delivery_method || 'Delivery');
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;">
        <p style="margin:0 0 12px;color:#44403c;">Hi ${escapeHtml(order.rep_first_name || 'there')},</p>
        <p style="margin:0 0 16px;color:#44403c;">Your customer just placed an order online — it's assigned to you.</p>
        <h2 style="color:#1c1917;margin:0 0 4px;">Order ${order.order_number}</h2>
        <p style="font-size:22px;margin:0 0 16px;color:#1c1917;"><strong>$${parseFloat(order.total || 0).toFixed(2)}</strong> · ${method}</p>
        <p style="margin:0 0 16px;color:#44403c;">
          ${escapeHtml(order.customer_name || 'Guest')} · ${escapeHtml(order.customer_email || '')}${order.phone ? ' · ' + escapeHtml(order.phone) : ''}
        </p>
        <table style="border-collapse:collapse;font-size:14px;">${itemRows}</table>${more}
        <p style="margin:20px 0 0;">
          <a href="https://romaflooringdesigns.com/rep" style="color:#8a6d3b;">Open in rep portal</a>
        </p>
      </div>`;
    await deliver({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: order.rep_email,
      replyTo: order.customer_email || undefined,
      subject: `Your customer placed order ${order.order_number} — $${parseFloat(order.total || 0).toFixed(2)} — ${order.customer_name || 'Guest'}`,
      html
    });
    console.log(`[Email] New-order rep alert sent to ${order.rep_email} for ${order.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send new-order rep alert for ${order.order_number}:`, err.message);
  }
}

/**
 * Personal sample-request alert to the customer's dedicated rep. Same contract
 * as sendNewOrderRepAlert: silently skipped unless rep_email is attached.
 */
export async function sendNewSampleRequestRepAlert(sr) {
  if (!sr.rep_email) return;
  if (!transporter) {
    console.log(`[Email] Skipping sample-request rep alert for ${sr.request_number} — SMTP not configured`);
    return;
  }
  try {
    const items = Array.isArray(sr.items) ? sr.items : [];
    const itemRows = items.slice(0, 12).map(i =>
      `<tr><td style="padding:4px 12px 4px 0;color:#44403c;">${i.product_name || 'Item'}${i.variant_name ? ' — ' + i.variant_name : ''}</td></tr>`
    ).join('');
    const more = items.length > 12 ? `<p style="color:#78716c;">…and ${items.length - 12} more sample(s)</p>` : '';
    const method = sr.delivery_method === 'pickup' ? 'Pickup' : 'Shipping';
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;">
        <p style="margin:0 0 12px;color:#44403c;">Hi ${escapeHtml(sr.rep_first_name || 'there')},</p>
        <p style="margin:0 0 16px;color:#44403c;">Your customer just requested samples online.</p>
        <h2 style="color:#1c1917;margin:0 0 4px;">Sample request ${sr.request_number}</h2>
        <p style="font-size:18px;margin:0 0 16px;color:#1c1917;">${items.length} sample${items.length === 1 ? '' : 's'} · ${method}</p>
        <p style="margin:0 0 16px;color:#44403c;">
          ${escapeHtml(sr.customer_name || 'Guest')} · ${escapeHtml(sr.customer_email || '')}${sr.phone ? ' · ' + escapeHtml(sr.phone) : ''}
        </p>
        <table style="border-collapse:collapse;font-size:14px;">${itemRows}</table>${more}
        <p style="margin:20px 0 0;">
          <a href="https://romaflooringdesigns.com/rep" style="color:#8a6d3b;">Open in rep portal</a>
        </p>
      </div>`;
    await deliver({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: sr.rep_email,
      replyTo: sr.customer_email || undefined,
      subject: `Your customer requested samples — ${sr.request_number} — ${sr.customer_name || 'Guest'}`,
      html
    });
    console.log(`[Email] Sample-request rep alert sent to ${sr.rep_email} for ${sr.request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample-request rep alert for ${sr.request_number}:`, err.message);
  }
}

/**
 * Personal installation-inquiry alert to the customer's dedicated rep. Same
 * contract as sendNewOrderRepAlert: silently skipped unless rep_email is attached.
 */
export async function sendNewInstallInquiryRepAlert(inquiry) {
  if (!inquiry.rep_email) return;
  if (!transporter) {
    console.log(`[Email] Skipping install-inquiry rep alert for ${inquiry.customer_email} — SMTP not configured`);
    return;
  }
  try {
    const facts = [];
    if (inquiry.product_name) facts.push(escapeHtml(inquiry.product_name + (inquiry.collection ? ' (' + inquiry.collection + ')' : '')));
    const sqft = parseFloat(inquiry.estimated_sqft);
    if (!isNaN(sqft) && sqft > 0) facts.push(sqft.toFixed(0) + ' sqft');
    if (inquiry.zip_code) facts.push('zip ' + escapeHtml(inquiry.zip_code));
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;">
        <p style="margin:0 0 12px;color:#44403c;">Hi ${escapeHtml(inquiry.rep_first_name || 'there')},</p>
        <p style="margin:0 0 16px;color:#44403c;">Your customer just sent an installation inquiry.</p>
        <h2 style="color:#1c1917;margin:0 0 4px;">Installation inquiry</h2>
        ${facts.length ? `<p style="font-size:18px;margin:0 0 16px;color:#1c1917;">${facts.join(' · ')}</p>` : ''}
        <p style="margin:0 0 16px;color:#44403c;">
          ${escapeHtml(inquiry.customer_name || '')} · ${escapeHtml(inquiry.customer_email || '')}${inquiry.phone ? ' · ' + escapeHtml(inquiry.phone) : ''}
        </p>
        ${inquiry.message ? `<p style="margin:0 0 16px;color:#44403c;border-left:3px solid #e7e5e4;padding-left:12px;">${escapeHtml(inquiry.message)}</p>` : ''}
        <p style="margin:20px 0 0;">
          <a href="https://romaflooringdesigns.com/rep" style="color:#8a6d3b;">Open in rep portal</a>
        </p>
      </div>`;
    await deliver({
      from: `"${BRAND_NAME}" <${SMTP_FROM}>`,
      to: inquiry.rep_email,
      replyTo: inquiry.customer_email || undefined,
      subject: `Your customer sent an installation inquiry — ${inquiry.customer_name || ''}`,
      html
    });
    console.log(`[Email] Install-inquiry rep alert sent to ${inquiry.rep_email} for ${inquiry.customer_email}`);
  } catch (err) {
    console.error(`[Email] Failed to send install-inquiry rep alert for ${inquiry.customer_email}:`, err.message);
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
    await deliver({
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
    await deliver({
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
export async function sendPurchaseOrderToVendor({ vendor_email, vendor_name, po_number, is_revised, pdf_buffer, rep_email, rep_name, vendor_contact_email, cc_list, notes }) {
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
    <p style="color:#57534e;font-size:16px;margin:0 0 8px;">Dear ${escapeHtml(vendor_name || 'Vendor')},</p>
    <p style="color:#57534e;font-size:16px;margin:0 0 24px;">
      ${is_revised ? 'Please find the revised purchase order attached.' : 'Please find the attached purchase order for your review.'}
    </p>
    <div style="background:#f5f5f4;display:inline-block;padding:12px 32px;margin:0 0 24px;font-size:18px;font-weight:500;color:#1c1917;">
      ${po_number}
    </div>
    ${notes && String(notes).trim() ? `<div style="text-align:left;background:#faf7f2;border:1px solid #e7e0d4;border-left:3px solid #a87935;padding:14px 18px;margin:0 0 24px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#a87935;margin:0 0 6px;">Notes</div>
      <div style="color:#57534e;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(String(notes).trim())}</div>
    </div>` : ''}
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

    // An explicit cc_list (from the send dialog) overrides the default CC, which
    // is just the Roma rep — the PO goes To the vendor's order desk and CCs only
    // our own rep, not the vendor's rep. Dedupe against the To address.
    const cc = (Array.isArray(cc_list) ? cc_list : [rep_email])
      .filter(Boolean)
      .filter(addr => addr.toLowerCase() !== String(vendor_email || '').toLowerCase());
    await deliver({
      from: `"${BRAND_NAME} Purchasing" <${SALES_FROM}>`,
      to: vendor_email,
      cc: cc.length ? cc : undefined,
      replyTo: rep_email || SALES_FROM,
      subject,
      html,
      attachments: [{ filename: `${po_number}.pdf`, content: pdf_buffer, contentType: 'application/pdf' }]
    });
    console.log(`[Email] PO ${po_number} sent to ${vendor_email}${cc.length ? ' (cc ' + cc.join(', ') + ')' : ''}`);
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
    await deliver({
      from: NOREPLY_FROM,
      to: email,
      subject: 'Reset Your Password — Roma Flooring Designs',
      html
    });
    console.log(`[Email] Password reset sent to ${email}`);
  } catch (err) {
    console.error(`[Email] Failed to send password reset to ${email}:`, err.message);
  }
}

// Staff / admin password reset — operations-console flavored, 7-day link.
// opts.expiresLabel / opts.loginPath let reps reuse this with a 1-hour link that
// points at the rep portal instead of the admin console.
export async function sendStaffPasswordReset(email, firstName, resetUrl, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping staff password reset for ${email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateStaffPasswordResetHTML(firstName, resetUrl, { expiresLabel: opts.expiresLabel || '7 days', loginPath: opts.loginPath });
    await deliver({
      from: NOREPLY_FROM,
      to: email,
      subject: 'Reset your Roma staff password',
      html
    });
    console.log(`[Email] Staff password reset sent to ${email}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send staff password reset to ${email}:`, err.message);
    return { sent: false };
  }
}

// Staff invite / onboarding — first-time console invitation with a 7-day link.
export async function sendStaffInvite(email, firstName, resetUrl, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping staff invite for ${email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateStaffInviteHTML(firstName, resetUrl, { expiresLabel: '7 days', ...opts });
    await deliver({
      from: NOREPLY_FROM,
      to: email,
      subject: 'You’re invited to the Roma operations console',
      html
    });
    console.log(`[Email] Staff invite sent to ${email}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send staff invite to ${email}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send payment request email to customer with Stripe checkout link.
 */
export async function sendPaymentRequest({ order, amount, checkout_url, message, items = [], pdf_buffer = null, expires_at = null }) {
  if (!transporter) {
    console.log(`[Email] Skipping payment request for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generatePaymentRequestHTML({ order, items, balance: amount, checkout_url, message, expires_at });

    const mailOpts = {
      from: repFrom(order),
      to: order.customer_email,
      replyTo: order.rep_email,
      subject: `Payment Required — Order ${order.order_number}`,
      html
    };
    if (pdf_buffer) {
      mailOpts.attachments = [{
        filename: `invoice-${order.order_number}.pdf`,
        content: pdf_buffer,
        contentType: 'application/pdf'
      }];
    }

    await deliver(mailOpts);
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
    await deliver({
      from: repFrom(visitData),
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

export async function sendPaymentReceived(order, amount, pdf_buffer = null) {
  if (!transporter) {
    console.log(`[Email] Skipping payment received for ${order.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generatePaymentReceivedHTML({ order, amount });

    const mailOpts = {
      from: repFrom(order),
      to: order.customer_email,
      replyTo: order.rep_email,
      subject: `Payment Received — Order ${order.order_number}`,
      html
    };
    if (pdf_buffer) {
      mailOpts.attachments = [{
        filename: `invoice-${order.order_number}.pdf`,
        content: pdf_buffer,
        contentType: 'application/pdf'
      }];
    }

    await deliver(mailOpts);
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
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
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
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
      subject: `Your Samples Have Shipped — ${data.request_number}`,
      html
    });
    console.log(`[Email] Sample request shipped sent to ${data.customer_email} for ${data.request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample request shipped for ${data.request_number}:`, err.message);
  }
}

/**
 * Send "your samples are ready" email to the customer — fired once when every
 * sample on the request has been marked ready. Copy adapts to pickup vs. shipping.
 */
export async function sendSampleRequestReady(data) {
  if (!transporter) {
    console.log(`[Email] Skipping sample request ready for ${data.request_number} — SMTP not configured`);
    return;
  }
  if (!data.customer_email) {
    console.log(`[Email] Skipping sample request ready for ${data.request_number} — no customer email`);
    return;
  }
  try {
    const html = generateSampleRequestReadyHTML(data);
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
      subject: `Your Samples Are Ready — ${data.request_number}`,
      html
    });
    console.log(`[Email] Sample request ready sent to ${data.customer_email} for ${data.request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample request ready for ${data.request_number}:`, err.message);
  }
}

/**
 * Send scraper failure notification to admin staff.
 * Notifies SCRAPER_ALERT_EMAIL (or SMTP_FROM as fallback) when a scrape job fails.
 */
export async function sendScraperFailure({ source_name, scraper_key, job_id, error, started_at, duration_minutes }) {
  const alertEmail = SCRAPER_ALERT_ADDR;
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
    await deliver({
      from: `"${BRAND_NAME} Alerts" <${NOREPLY_ADDR}>`,
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
 * Send a catalog pipeline summary (activations / retirements) to the ops team.
 * Called by lifecycle steps only when a live run actually changed the catalog.
 */
export async function sendPipelineSummary({ label, activated = [], retired = [], coverage = null }) {
  const alertEmail = SCRAPER_ALERT_ADDR;
  if (!transporter) {
    console.log(`[Email] Skipping pipeline summary for ${label} — SMTP not configured`);
    return;
  }
  const list = (items) => items.length
    ? `<ul style="margin:8px 0 0; padding-left:20px; font-size:13px; color:#333;">${
        items.slice(0, 50).map(i => `<li>${i}</li>`).join('')
      }${items.length > 50 ? `<li>… and ${items.length - 50} more</li>` : ''}</ul>`
    : '<p style="margin:8px 0 0; font-size:13px; color:#888;">None</p>';
  try {
    const html = `
      <div style="font-family: Inter, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
        <h2 style="margin-bottom: 8px;">${label} — Catalog Update</h2>
        ${coverage ? `<p style="font-size:13px; color:#666;">Image coverage: ${coverage}</p>` : ''}
        <h3 style="margin:20px 0 0; font-size:15px; color:#27ae60;">Activated (${activated.length})</h3>
        ${list(activated)}
        <h3 style="margin:20px 0 0; font-size:15px; color:#c0392b;">Retired to draft (${retired.length})</h3>
        ${list(retired)}
        <p style="margin-top: 20px; font-size: 12px; color: #888;">Automated by the ${label} pipeline. View full logs in the admin panel.</p>
      </div>
    `;
    await deliver({
      from: `"${BRAND_NAME} Alerts" <${NOREPLY_ADDR}>`,
      to: alertEmail,
      subject: `[Catalog] ${label}: +${activated.length} activated, −${retired.length} retired`,
      html
    });
    console.log(`[Email] Pipeline summary sent for ${label} (+${activated.length}/−${retired.length})`);
  } catch (err) {
    console.error(`[Email] Failed to send pipeline summary for ${label}:`, err.message);
  }
}

/**
 * Alert the ops team when a vendor pipeline run fails a step (opt-in via the
 * pipeline config's `notify` flag). Fires from the pipeline runner, so it covers
 * failures in any step — including ones that abort before the reporting step.
 */
export async function sendPipelineFailure({ label, vendor_code, step_label, error }) {
  const alertEmail = SCRAPER_ALERT_ADDR;
  if (!transporter) {
    console.log(`[Email] Skipping pipeline failure alert for ${vendor_code} — SMTP not configured`);
    return;
  }
  try {
    const html = `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #c0392b; margin-bottom: 16px;">Pipeline Failed: ${label}</h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Pipeline</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600;">${vendor_code}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Failed step</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${step_label || 'N/A'}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">Error</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #c0392b;">${error}</td></tr>
        </table>
        <p style="margin-top: 20px; font-size: 13px; color: #888;">Check the admin panel for full pipeline logs.</p>
      </div>
    `;
    await deliver({
      from: `"${BRAND_NAME} Alerts" <${NOREPLY_ADDR}>`,
      to: alertEmail,
      subject: `[Pipeline Alert] ${label} failed`,
      html
    });
    console.log(`[Email] Pipeline failure alert sent for ${vendor_code}`);
  } catch (err) {
    console.error(`[Email] Failed to send pipeline failure alert for ${vendor_code}:`, err.message);
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
    await deliver({
      from: NOREPLY_FROM,
      to: data.email,
      subject: `Back in Stock — ${data.product_name}`,
      html
    });
    console.log(`[Email] Stock alert sent to ${data.email} for ${data.product_name}`);
  } catch (err) {
    console.error(`[Email] Failed to send stock alert to ${data.email}:`, err.message);
  }
}

/**
 * Send invoice email to customer.
 */
export async function sendInvoiceSent(invoice) {
  if (!transporter) {
    console.log(`[Email] Skipping invoice email for ${invoice.invoice_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateInvoiceSentHTML(invoice);
    await deliver({
      from: repFrom(invoice),
      to: invoice.customer_email,
      replyTo: invoice.rep_email,
      subject: `Invoice ${invoice.invoice_number} — Roma Flooring Designs`,
      html
    });
    console.log(`[Email] Invoice sent to ${invoice.customer_email} for ${invoice.invoice_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send invoice ${invoice.invoice_number}:`, err.message);
  }
}

/**
 * Send overdue invoice reminder to customer.
 */
export async function sendInvoiceReminder(invoice) {
  if (!transporter) {
    console.log(`[Email] Skipping invoice reminder for ${invoice.invoice_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateInvoiceReminderHTML(invoice);
    await deliver({
      from: repFrom(invoice),
      to: invoice.customer_email,
      replyTo: invoice.rep_email,
      subject: `Payment Reminder — Invoice ${invoice.invoice_number}`,
      html
    });
    console.log(`[Email] Invoice reminder sent to ${invoice.customer_email} for ${invoice.invoice_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send invoice reminder ${invoice.invoice_number}:`, err.message);
  }
}

/**
 * Send sample request PDF to vendor via email.
 */
export async function sendSampleRequestToVendor({ vendor_email, vendor_name, request_number, rep_name, rep_email, vendor_contact_email, item_count, ship_to, pdf_buffer }) {
  if (!transporter) {
    console.log(`[Email] Skipping sample request email for ${request_number} to ${vendor_email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const emailBody = generateSampleRequestVendorEmailHTML({
      vendor_name, request_number, rep_name, item_count, ship_to
    });

    const cc = [rep_email, vendor_contact_email].filter(Boolean);
    await deliver({
      from: `"${BRAND_NAME} Purchasing" <${SALES_FROM}>`,
      to: vendor_email,
      cc: cc.length ? cc : undefined,
      replyTo: rep_email || SALES_FROM,
      subject: `Sample Request — ${request_number}`,
      html: emailBody,
      attachments: [{ filename: `Sample-Request-${request_number}.pdf`, content: pdf_buffer, contentType: 'application/pdf' }]
    });
    console.log(`[Email] Sample request ${request_number} sent to ${vendor_email}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send sample request ${request_number} to ${vendor_email}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send sample shipping payment request email to customer with Stripe checkout link.
 */
export async function sendSampleShippingPayment({ customer_name, customer_email, request_number, checkout_url, amount, rep_email, rep_first_name, rep_last_name }) {
  if (!transporter) {
    console.log(`[Email] Skipping sample shipping payment for ${request_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateSampleShippingPaymentHTML({ customer_name, request_number, checkout_url, amount });

    await deliver({
      from: repFrom({ rep_email, rep_first_name, rep_last_name }),
      to: customer_email,
      replyTo: rep_email || undefined,
      subject: `Shipping Payment Required — Sample Request ${request_number}`,
      html
    });
    console.log(`[Email] Sample shipping payment request sent to ${customer_email} for ${request_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send sample shipping payment for ${request_number}:`, err.message);
  }
}

/**
 * Send welcome / set-your-password email to a newly auto-created customer.
 */
/**
 * Send order invoice email to customer with PDF attachment.
 * If checkout_url is provided, includes a "Pay Now" payment button.
 */
export async function sendOrderInvoiceEmail({ order, items, balance, checkout_url, message, pdf_buffer }) {
  if (!transporter) {
    console.log(`[Email] Skipping order invoice email for ${order.order_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const total = parseFloat(order.total || 0);
    const amountPaid = parseFloat(order.amount_paid || 0);
    const balanceDue = balance > 0.01 ? balance : 0;

    const itemRows = (items || []).map(i => {
      const isUnit = i.sell_by === 'unit';
      const qty = i.is_sample ? '1 sample' : (i.num_boxes + (isUnit ? '' : ' box' + (i.num_boxes > 1 ? 'es' : '')));
      const price = i.is_sample ? '$0.00' : '$' + parseFloat(i.subtotal || 0).toFixed(2);
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;color:#1c1917;">${escapeHtml(i.product_name || '')}${i.is_sample ? ' <span style="color:#c8a97e;">(Sample)</span>' : ''}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;color:#57534e;text-align:center;">${qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;color:#1c1917;text-align:right;">${price}</td>
      </tr>`;
    }).join('');

    const totalsRows = [
      `<tr><td style="padding:4px 0;font-size:13px;color:#57534e;">Subtotal</td><td style="padding:4px 0;font-size:13px;color:#1c1917;text-align:right;">$${parseFloat(order.subtotal || 0).toFixed(2)}</td></tr>`
    ];
    if (parseFloat(order.shipping || 0) > 0)
      totalsRows.push(`<tr><td style="padding:4px 0;font-size:13px;color:#57534e;">Shipping</td><td style="padding:4px 0;font-size:13px;color:#1c1917;text-align:right;">$${parseFloat(order.shipping).toFixed(2)}</td></tr>`);
    if (parseFloat(order.tax_amount || 0) > 0)
      totalsRows.push(`<tr><td style="padding:4px 0;font-size:13px;color:#57534e;">Tax</td><td style="padding:4px 0;font-size:13px;color:#1c1917;text-align:right;">$${parseFloat(order.tax_amount).toFixed(2)}</td></tr>`);
    if (parseFloat(order.discount_amount || 0) > 0)
      totalsRows.push(`<tr><td style="padding:4px 0;font-size:13px;color:#57534e;">Discount</td><td style="padding:4px 0;font-size:13px;color:#16a34a;text-align:right;">-$${parseFloat(order.discount_amount).toFixed(2)}</td></tr>`);
    totalsRows.push(`<tr><td style="padding:8px 0 4px;font-size:14px;font-weight:600;color:#1c1917;border-top:2px solid #1c1917;">Total</td><td style="padding:8px 0 4px;font-size:14px;font-weight:600;color:#1c1917;text-align:right;border-top:2px solid #1c1917;">$${total.toFixed(2)}</td></tr>`);
    totalsRows.push(`<tr><td style="padding:4px 0;font-size:13px;color:#57534e;">Amount Paid</td><td style="padding:4px 0;font-size:13px;color:#1c1917;text-align:right;">$${amountPaid.toFixed(2)}</td></tr>`);
    if (balanceDue > 0) {
      totalsRows.push(`<tr><td style="padding:4px 0;font-size:14px;font-weight:600;color:#b91c1c;">Balance Due</td><td style="padding:4px 0;font-size:14px;font-weight:600;color:#b91c1c;text-align:right;">$${balanceDue.toFixed(2)}</td></tr>`);
    } else {
      totalsRows.push(`<tr><td style="padding:4px 0;font-size:13px;font-weight:500;color:#16a34a;">Balance Due</td><td style="padding:4px 0;font-size:13px;font-weight:500;color:#16a34a;text-align:right;">$0.00</td></tr>`);
    }

    const paySection = balanceDue > 0 && checkout_url ? `
      <tr><td style="padding:24px 40px;text-align:center;background:#fefce8;border-top:1px solid #fde68a;">
        <p style="margin:0 0 12px;font-size:15px;font-weight:500;color:#92400e;">Payment of $${balanceDue.toFixed(2)} is due</p>
        <a href="${checkout_url}" style="display:inline-block;background:#1c1917;color:#fff;padding:14px 40px;text-decoration:none;font-size:15px;font-weight:500;">Pay Now</a>
        <p style="margin:12px 0 0;font-size:12px;color:#a16207;">This payment link expires in 72 hours.</p>
      </td></tr>` : '';

    const msgSection = message ? `
      <tr><td style="padding:0 40px 24px;">
        <div style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;font-size:13px;color:#57534e;line-height:1.6;">
          <strong style="color:#1c1917;">Message from your rep:</strong><br/>${escapeHtml(message).replace(/\n/g, '<br/>')}
        </div>
      </td></tr>` : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <div style="text-align:center;">
<p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;line-height:1;font-weight:400;letter-spacing:0.34em;color:#1c1917;">ROMA <span style="font-size:24px;letter-spacing:normal;color:#1c1917;">FLOORING</span></p>
<p style="margin:-10px 0 0;font-family:'Pinyon Script','Brush Script MT','Segoe Script','Cormorant Garamond',cursive;font-size:33px;line-height:1;color:#a87935;">Designs</p>
</div>
  </td></tr>
  <tr><td style="padding:32px 40px 16px;text-align:center;">
    <h1 style="margin:0 0 8px;font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:400;color:#1c1917;">Invoice</h1>
    <p style="margin:0;font-size:14px;color:#57534e;">Order <strong>${order.order_number}</strong> &mdash; ${new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </td></tr>
  ${msgSection}
  <tr><td style="padding:0 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr>
        <th style="padding:8px 12px;background:#1c1917;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;text-align:left;">Product</th>
        <th style="padding:8px 12px;background:#1c1917;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;text-align:center;">Qty</th>
        <th style="padding:8px 12px;background:#1c1917;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;text-align:right;">Amount</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <table width="50%" cellpadding="0" cellspacing="0" style="margin-left:auto;">
      ${totalsRows.join('')}
    </table>
  </td></tr>
  ${paySection}
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">A PDF copy of this invoice is attached.</p>
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">Questions? Contact us at Sales@romaflooringdesigns.com or (714) 999-0009</p>
    <p style="margin:0;font-size:11px;color:#a8a29e;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    const mailOpts = {
      from: repFrom(order),
      to: order.customer_email,
      replyTo: order.rep_email,
      subject: balanceDue > 0
        ? `Invoice & Payment Request — Order ${order.order_number}`
        : `Invoice — Order ${order.order_number}`,
      html
    };
    if (pdf_buffer) {
      mailOpts.attachments = [{
        filename: `invoice-${order.order_number}.pdf`,
        content: pdf_buffer,
        contentType: 'application/pdf'
      }];
    }
    await deliver(mailOpts);
    console.log(`[Email] Order invoice sent to ${order.customer_email} for ${order.order_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send order invoice for ${order.order_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send estimate email to customer.
 */
export async function sendEstimateSent(estimateData, opts = {}) {
  if (!transporter) {
    console.log(`[Email] Skipping estimate email for ${estimateData.estimate_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateEstimateSentHTML(estimateData, { tracking: true, reminder: opts.reminder });
    await deliver({
      from: repFrom(estimateData),
      to: estimateData.customer_email,
      replyTo: estimateData.rep_email,
      subject: opts.reminder
        ? `Reminder: your ${estimateData.has_labor === false ? 'quote' : 'estimate'} ${estimateData.estimate_number} expires soon`
        : `Your ${estimateData.doc_type || 'Construction Estimate'} — ${estimateData.estimate_number}`,
      html,
      ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {})
    });
    console.log(`[Email] Estimate email sent to ${estimateData.customer_email} for ${estimateData.estimate_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send estimate email for ${estimateData.estimate_number}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send the customer their acceptance confirmation (receipt) after they sign
 * off on an estimate on the public page.
 */
export async function sendEstimateAccepted(estimateData) {
  if (!transporter) {
    console.log(`[Email] Skipping estimate-accepted email for ${estimateData.estimate_number} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateEstimateAcceptedHTML(estimateData);
    await deliver({
      from: repFrom(estimateData),
      to: estimateData.customer_email,
      replyTo: estimateData.rep_email,
      subject: `${estimateData.has_labor === false ? 'Quote' : 'Estimate'} accepted — ${estimateData.estimate_number}`,
      html
    });
    console.log(`[Email] Estimate-accepted email sent to ${estimateData.customer_email} for ${estimateData.estimate_number}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send estimate-accepted email for ${estimateData.estimate_number}:`, err.message);
    return { sent: false };
  }
}

export async function sendWelcomeSetPassword(toEmail, firstName, resetUrl) {
  if (!transporter) {
    console.log(`[Email] Skipping welcome set-password for ${toEmail} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateWelcomeSetPasswordHTML(firstName, resetUrl);
    await deliver({
      from: NOREPLY_FROM,
      to: toEmail,
      subject: 'Welcome to Roma Flooring Designs — Set Your Password',
      html
    });
    console.log(`[Email] Welcome set-password sent to ${toEmail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send welcome set-password to ${toEmail}:`, err.message);
    return { sent: false };
  }
}

// Welcome for a first-time customer who already has a login (self sign-up / Google).
export async function sendWelcomeCustomer(toEmail, firstName) {
  if (!transporter) {
    console.log(`[Email] Skipping welcome for ${toEmail} — SMTP not configured`);
    return { sent: false };
  }
  try {
    await deliver({
      from: NOREPLY_FROM,
      to: toEmail,
      subject: 'Welcome to Roma Flooring Designs',
      html: generateWelcomeCustomerHTML(firstName)
    });
    console.log(`[Email] Welcome sent to ${toEmail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send welcome to ${toEmail}:`, err.message);
    return { sent: false };
  }
}

// Send the confirmation link to the NEW email a customer wants to switch to.
export async function sendEmailChangeConfirm(toEmail, firstName, confirmUrl) {
  if (!transporter) {
    console.log(`[Email] Skipping email-change confirm for ${toEmail} — SMTP not configured`);
    return { sent: false };
  }
  try {
    await deliver({
      from: NOREPLY_FROM,
      to: toEmail,
      subject: 'Confirm your new email — Roma Flooring Designs',
      html: generateEmailChangeConfirmHTML(firstName, confirmUrl, toEmail)
    });
    console.log(`[Email] Email-change confirm sent to ${toEmail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send email-change confirm to ${toEmail}:`, err.message);
    return { sent: false };
  }
}

// Notify the OLD email that its account's sign-in email is changing/changed.
// stage = 'requested' (link sent, not yet applied) or 'completed' (applied).
export async function sendEmailChangeNotice(toEmail, firstName, newEmail, stage = 'requested') {
  if (!transporter) {
    console.log(`[Email] Skipping email-change notice for ${toEmail} — SMTP not configured`);
    return { sent: false };
  }
  try {
    await deliver({
      from: NOREPLY_FROM,
      to: toEmail,
      subject: stage === 'completed'
        ? 'Your email was changed — Roma Flooring Designs'
        : 'Email change requested — Roma Flooring Designs',
      html: generateEmailChangeNoticeHTML(firstName, newEmail, stage)
    });
    console.log(`[Email] Email-change notice (${stage}) sent to ${toEmail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send email-change notice to ${toEmail}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send product share email from rep to customer.
 */
export async function sendProductShare(data) {
  if (!transporter) {
    console.log(`[Email] Skipping product share for ${data.customer_email} — SMTP not configured`);
    return { sent: false };
  }
  try {
    const html = generateProductShareHTML(data);
    await deliver({
      from: repFrom(data),
      to: data.customer_email,
      replyTo: data.rep_email,
      subject: `Check This Out — ${data.product_name}`,
      html
    });
    console.log(`[Email] Product share sent to ${data.customer_email} for "${data.product_name}"`);
    return { sent: true };
  } catch (err) {
    console.error(`[Email] Failed to send product share to ${data.customer_email}:`, err.message);
    return { sent: false };
  }
}

/**
 * Send daily scraper health check to admin/manager staff.
 */
export async function sendScraperHealthCheck(staffEmails, healthData) {
  if (!transporter) {
    console.log(`[Email] Skipping scraper health check — SMTP not configured`);
    return;
  }
  if (!staffEmails || staffEmails.length === 0) {
    console.log(`[Email] Skipping scraper health check — no recipients`);
    return;
  }
  try {
    const html = generateDailyHealthCheckHTML(healthData);
    const problemCount = healthData.summary.warning + healthData.summary.critical;
    const subject = problemCount > 0
      ? `[Scraper Health] ${problemCount} issue${problemCount !== 1 ? 's' : ''} detected`
      : `[Scraper Health] All ${healthData.summary.total_sources} sources healthy`;
    await deliver({
      from: NOREPLY_FROM,
      to: staffEmails.join(', '),
      subject,
      html
    });
    console.log(`[Email] Scraper health check sent to ${staffEmails.length} recipient(s) (${problemCount} issues)`);
  } catch (err) {
    console.error(`[Email] Failed to send scraper health check:`, err.message);
  }
}

/**
 * Send "Order Received — Awaiting Bank Transfer" email with bank instructions.
 */
export async function sendBankTransferAwaitingEmail(orderData, bankInstructions) {
  if (!transporter) {
    console.log(`[Email] Skipping bank transfer awaiting email for ${orderData.order_number} — SMTP not configured`);
    return;
  }
  try {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const bi = bankInstructions || {};
    const fa = (bi.financial_addresses || [])[0] || {};
    const aba = fa.aba || {};
    const total = parseFloat(orderData.total || 0).toFixed(2);
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:white;border:1px solid #e7e5e4;">
<div style="background:#1c1917;color:white;padding:24px;text-align:center;font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;">Roma Flooring Designs</div>
<div style="padding:32px 24px;">
<div style="text-align:center;margin-bottom:24px;"><div style="display:inline-block;width:48px;height:48px;border-radius:50%;background:#fef3c7;text-align:center;line-height:48px;font-size:24px;">⏳</div></div>
<h1 style="text-align:center;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:400;margin:0 0 8px;">Order Received — Awaiting Payment</h1>
<p style="text-align:center;color:#78716c;font-size:14px;margin:0 0 24px;">Order ${esc(orderData.order_number)}</p>
<p style="font-size:14px;color:#44403c;line-height:1.6;">Hi ${esc(orderData.customer_name)},</p>
<p style="font-size:14px;color:#44403c;line-height:1.6;">Thank you for your order! To complete your purchase, please send a bank transfer using the details below. Your order will be confirmed once payment is received (typically 1–3 business days).</p>
<div style="background:#fefce8;border:1px solid #fde68a;padding:20px;margin:24px 0;">
<h3 style="margin:0 0 12px;font-size:15px;color:#92400e;">Bank Transfer Details</h3>
<table style="width:100%;font-size:14px;border-collapse:collapse;">
<tr><td style="padding:6px 0;color:#78716c;">Bank Name</td><td style="padding:6px 0;font-weight:600;text-align:right;">${esc(aba.bank_name || 'See Stripe dashboard')}</td></tr>
<tr><td style="padding:6px 0;color:#78716c;">Routing Number</td><td style="padding:6px 0;font-weight:600;text-align:right;">${esc(aba.routing_number || '—')}</td></tr>
<tr><td style="padding:6px 0;color:#78716c;">Account Number</td><td style="padding:6px 0;font-weight:600;text-align:right;">${esc(aba.account_number || '—')}</td></tr>
<tr><td style="padding:6px 0;color:#78716c;">Reference</td><td style="padding:6px 0;font-weight:600;text-align:right;">${esc(bi.reference || '—')}</td></tr>
<tr style="border-top:1px solid #fde68a;"><td style="padding:8px 0;color:#78716c;">Amount Due</td><td style="padding:8px 0;font-weight:700;text-align:right;font-size:16px;">$${total}</td></tr>
</table>
</div>
<div style="background:#fef2f2;border:1px solid #fecaca;padding:12px 16px;font-size:13px;color:#991b1b;margin-bottom:24px;">
<strong>Important:</strong> Please include the reference number in your transfer memo so we can match your payment.
</div>
<p style="font-size:13px;color:#78716c;line-height:1.6;">Payment must be received within 14 days. If not received, the order will be automatically cancelled.</p>
</div>
<div style="background:#f5f5f4;padding:16px 24px;text-align:center;font-size:12px;color:#a8a29e;">Roma Flooring Designs · 1440 S. State College Blvd. #6M, Anaheim, CA 92806</div>
</div></body></html>`;
    await deliver({
      from: repFrom(orderData),
      to: orderData.customer_email,
      replyTo: orderData.rep_email,
      subject: `Order Received — Awaiting Payment — ${orderData.order_number}`,
      html
    });
    console.log(`[Email] Bank transfer awaiting email sent to ${orderData.customer_email} for ${orderData.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send bank transfer awaiting email for ${orderData.order_number}:`, err.message);
  }
}
