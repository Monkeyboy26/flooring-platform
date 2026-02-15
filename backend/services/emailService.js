import nodemailer from 'nodemailer';
import { generateOrderConfirmationHTML } from '../templates/orderConfirmation.js';
import { generateQuoteSentHTML } from '../templates/quoteSent.js';
import { generateOrderStatusUpdateHTML } from '../templates/orderStatusUpdate.js';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@ateliersurfaces.com';

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
 * @param {object} orderData - order row merged with { items: [...] }
 */
export async function sendOrderConfirmation(orderData) {
  if (!transporter) {
    console.log(`[Email] Skipping order confirmation for ${orderData.order_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateOrderConfirmationHTML(orderData);
    await transporter.sendMail({
      from: `"Atelier Surfaces" <${SMTP_FROM}>`,
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
 * @param {object} quoteData - quote row merged with { items, rep_first_name, rep_last_name, rep_email }
 */
export async function sendQuoteSent(quoteData) {
  if (!transporter) {
    console.log(`[Email] Skipping quote email for ${quoteData.quote_number} — SMTP not configured`);
    return;
  }
  try {
    const html = generateQuoteSentHTML(quoteData);
    await transporter.sendMail({
      from: `"Atelier Surfaces" <${SMTP_FROM}>`,
      to: quoteData.customer_email,
      replyTo: quoteData.rep_email,
      subject: `Your Custom Quote — ${quoteData.quote_number}`,
      html
    });
    console.log(`[Email] Quote email sent to ${quoteData.customer_email} for ${quoteData.quote_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send quote email for ${quoteData.quote_number}:`, err.message);
  }
}

/**
 * Send order status update email to customer.
 * Only sends for shipped, delivered, and cancelled statuses.
 * @param {object} orderData - order row from DB
 * @param {string} status - new status
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
      from: `"Atelier Surfaces" <${SMTP_FROM}>`,
      to: orderData.customer_email,
      subject: subjectMap[status],
      html
    });
    console.log(`[Email] Status update (${status}) sent to ${orderData.customer_email} for ${orderData.order_number}`);
  } catch (err) {
    console.error(`[Email] Failed to send status update (${status}) for ${orderData.order_number}:`, err.message);
  }
}
