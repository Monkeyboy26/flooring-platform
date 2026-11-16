// Transactional order-status texts — the SMS twin of emailService's
// sendOrderStatusUpdate (call them side by side at every status-change site).
// Consent-gated (TCPA): only texts customers with standing sms_consent, read
// from the order flag or the customers table (by id, then by email — retail
// orders carry no owning FK, the email is the join key). Statuses without an
// entry in MESSAGES are silently ignored, so callers can pass every status.
// One text per (order, status) ever: order_sms_log claims before sending, so
// re-PUTs of the same status and admin/rep double-fires can't double-text.
// Master switch ORDER_SMS_ENABLED (default on — the consent gate is the real
// throttle, same posture as REVIEW_REQUESTS_ENABLED).
import { pool } from '../db.js';
import { sendSms, smsConfigured } from './smsService.js';

const ENABLED = process.env.ORDER_SMS_ENABLED !== 'false';

const SHOWROOM = '1440 S. State College Blvd Suite 6M, Anaheim';
const PHONE = '(714) 999-0009';

const MESSAGES = {
  ready_for_pickup: (o) => `Roma Flooring Designs: Order ${o.order_number} is ready for pickup! ${SHOWROOM} — Mon–Fri 9am–5pm, Sat 10am–5pm. Questions? ${PHONE}. Reply STOP to opt out.`,
  shipped: (o) => `Roma Flooring Designs: Order ${o.order_number} is on its way! We'll follow up once it arrives. Questions? ${PHONE}. Reply STOP to opt out.`,
  delivered: (o) => `Roma Flooring Designs: Order ${o.order_number} has been delivered. Thank you for choosing us! Questions? ${PHONE}. Reply STOP to opt out.`
};

async function hasStandingConsent(order) {
  if (order.sms_consent === true) return true;
  try {
    if (order.customer_id) {
      const r = await pool.query('SELECT sms_consent FROM customers WHERE id = $1', [order.customer_id]);
      if (r.rows[0] && r.rows[0].sms_consent) return true;
    }
    if (order.customer_email) {
      const r = await pool.query('SELECT sms_consent FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1', [order.customer_email]);
      if (r.rows[0] && r.rows[0].sms_consent) return true;
    }
  } catch (err) { /* non-fatal — default to no SMS */ }
  return false;
}

export async function sendOrderStatusSms(order, status) {
  try {
    if (!ENABLED || !smsConfigured()) return { sent: false, reason: 'disabled' };
    const build = MESSAGES[status];
    if (!build || !order || !order.id) return { sent: false, reason: 'not_applicable' };
    const phone = order.customer_phone || order.phone || null;
    if (!phone) return { sent: false, reason: 'no_phone' };
    if (!(await hasStandingConsent(order))) return { sent: false, reason: 'no_consent' };

    // Claim the (order, status) slot before sending; losing the race or a
    // repeat transition means someone already texted this update.
    const claim = await pool.query(
      `INSERT INTO order_sms_log (order_id, status) VALUES ($1, $2)
       ON CONFLICT (order_id, status) DO NOTHING RETURNING id`,
      [order.id, status]);
    if (!claim.rows.length) return { sent: false, reason: 'already_sent' };

    const result = await sendSms(phone, build(order));
    if (!result || result.sent !== true) {
      // Release the claim so a later retry (e.g. after fixing Twilio) can send.
      await pool.query('DELETE FROM order_sms_log WHERE order_id = $1 AND status = $2', [order.id, status]).catch(() => {});
      return { sent: false, reason: 'send_failed' };
    }
    console.log(`[OrderSMS] ${status} text sent for ${order.order_number}`);
    return { sent: true };
  } catch (err) {
    console.error('[OrderSMS] error:', err.message);
    return { sent: false, reason: 'error' };
  }
}
