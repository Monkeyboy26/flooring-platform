// Review-request orchestration: queue → send (email + SMS) → capture rating →
// route (public vs. private feedback). Sits on top of emailService and
// smsService; the public HTTP routes and the delivered-order hooks in server.js
// call into here.
//
// Compliance posture: every delivered customer is asked the same neutral
// "how did we do?" question. The rating self-selects the destination — this is
// NOT deceptive review-gating (we don't decide who to ask based on a guess at
// their happiness). Low ratings go to a private feedback form so we can make it
// right; they are never shown the public review links. SMS carries a STOP
// opt-out and requires prior consent under the TCPA (send only to customers who
// gave a number in the course of their order).

import crypto from 'crypto';
import { pool } from '../db.js';
import { sendReviewRequestEmail } from './emailService.js';
import { sendSms, smsConfigured } from './smsService.js';
import { reviewSmsBody } from '../templates/reviewRequest.js';

// Master switch: when false, nothing (auto, manual, or test) sends.
const ENABLED = process.env.REVIEW_REQUESTS_ENABLED !== 'false';
// Auto-send on delivered orders is OFF by default — opt in with REVIEW_AUTO_ENABLED=true
// once you're happy with the messaging. The manual rep/admin button and the test
// send work regardless (as long as the master switch is on).
const AUTO_ENABLED = process.env.REVIEW_AUTO_ENABLED === 'true';
const DELAY_HOURS = Math.max(0, parseFloat(process.env.REVIEW_REQUEST_DELAY_HOURS || '72'));
export const MIN_PUBLIC_RATING = Math.min(5, Math.max(1, parseInt(process.env.REVIEW_MIN_PUBLIC_RATING || '4', 10)));

export function reviewsEnabled() { return ENABLED; }
export function autoReviewEnabled() { return ENABLED && AUTO_ENABLED; }

function genToken() { return crypto.randomBytes(24).toString('base64url'); }

/**
 * Queue a review request for a (delivered) order.
 * - createdBy: 'auto' | 'rep' | 'admin'
 * - immediate: send now (manual rep/admin action) rather than after the delay.
 * Idempotent per order via the unique index on order_id: a second call resends
 * the existing request instead of creating a duplicate.
 */
export async function queueReviewRequest(order, { createdBy = 'auto', immediate = false } = {}) {
  if (!ENABLED) return { queued: false, reason: 'disabled' };
  if (!order || !order.id) return { queued: false, reason: 'no_order' };
  const email = order.customer_email || null;
  const phone = order.customer_phone || order.phone || null;
  if (!email && !phone) return { queued: false, reason: 'no_contact' };

  // SMS consent (TCPA): text only if the order carries consent, or — for orders
  // created without the flag (e.g. rep orders) — if the linked customer has a
  // standing consent on file. Email is unaffected.
  let smsConsent = order.sms_consent === true;
  if (!smsConsent && order.customer_id) {
    try {
      const c = await pool.query('SELECT sms_consent FROM customers WHERE id = $1', [order.customer_id]);
      smsConsent = !!(c.rows[0] && c.rows[0].sms_consent);
    } catch (err) { /* non-fatal — default to no SMS */ }
  }

  const sendAfter = immediate ? new Date() : new Date(Date.now() + DELAY_HOURS * 3600 * 1000);
  const token = genToken();
  try {
    const r = await pool.query(
      `INSERT INTO review_requests
        (order_id, customer_id, order_number, customer_name, customer_email, customer_phone,
         rep_email, rep_first_name, rep_last_name, token, status, send_after, created_by, sms_consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',$11,$12,$13)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING *`,
      [order.id, order.customer_id || null, order.order_number || null,
       order.customer_name || null, email, phone,
       order.rep_email || null, order.rep_first_name || null, order.rep_last_name || null,
       token, sendAfter, createdBy, smsConsent]
    );

    if (!r.rows.length) {
      // Already exists for this order. For a manual/immediate action, resend it.
      if (immediate) {
        const existing = await pool.query('SELECT * FROM review_requests WHERE order_id = $1', [order.id]);
        if (existing.rows.length) {
          const res = await sendReviewRequest(existing.rows[0]);
          return { queued: true, resent: true, id: existing.rows[0].id, sent: res.sent };
        }
      }
      return { queued: false, reason: 'already_exists' };
    }

    const row = r.rows[0];
    if (immediate) {
      const res = await sendReviewRequest(row);
      return { queued: true, id: row.id, sent: res.sent };
    }
    return { queued: true, id: row.id };
  } catch (err) {
    console.error('[Reviews] queue failed:', err.message);
    return { queued: false, reason: err.message };
  }
}

/**
 * Fire a one-off test review request to an arbitrary email/phone (not tied to an
 * order). Used to preview the flow. Gated only by the master switch, so it works
 * even when auto-send is off. The token makes the rating links functional.
 */
export async function sendTestReviewRequest({ name, email, phone } = {}) {
  if (!ENABLED) return { sent: false, reason: 'disabled' };
  if (!email && !phone) return { sent: false, reason: 'no_contact' };
  const token = genToken();
  // Test sends are initiated by an admin who typed the number, so SMS is allowed.
  const r = await pool.query(
    `INSERT INTO review_requests
       (order_number, customer_name, customer_email, customer_phone, token, status, send_after, created_by, sms_consent)
     VALUES ($1,$2,$3,$4,$5,'scheduled',CURRENT_TIMESTAMP,'test',true) RETURNING *`,
    ['TEST', name || 'there', email || null, phone || null, token]
  );
  const res = await sendReviewRequest(r.rows[0]);
  return { sent: res.sent, channels: res.channels, token };
}

/**
 * Send one queued request across all available channels, then record the outcome.
 */
export async function sendReviewRequest(row) {
  let emailSent = false;
  let smsSent = false;
  const channels = [];

  if (row.customer_email) {
    try {
      const r = await sendReviewRequestEmail(row);
      if (r && r.sent) { emailSent = true; channels.push('email'); }
    } catch (err) {
      console.error('[Reviews] email send error:', err.message);
    }
  }

  // Only text customers who consented (TCPA). Email always allowed.
  if (row.customer_phone && row.sms_consent && smsConfigured()) {
    const r = await sendSms(row.customer_phone, reviewSmsBody({ customer_name: row.customer_name, token: row.token }));
    if (r && r.sent) { smsSent = true; channels.push('sms'); }
  }

  const anySent = emailSent || smsSent;
  try {
    await pool.query(
      `UPDATE review_requests
         SET status = $1,
             sent_at = CASE WHEN $2 AND sent_at IS NULL THEN CURRENT_TIMESTAMP ELSE sent_at END,
             email_sent = email_sent OR $3,
             sms_sent = sms_sent OR $4,
             channels = $5,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [anySent ? 'sent' : 'failed', anySent, emailSent, smsSent, channels, row.id]
    );
  } catch (err) {
    console.error('[Reviews] failed to record send outcome:', err.message);
  }
  return { sent: anySent, channels };
}

/**
 * Poll for scheduled requests that are now due and send them. Started on an
 * interval from server.js.
 */
export async function processDueReviewRequests() {
  if (!ENABLED) return;
  try {
    const due = await pool.query(
      `SELECT * FROM review_requests
       WHERE status = 'scheduled' AND send_after <= CURRENT_TIMESTAMP
       ORDER BY send_after ASC LIMIT 50`
    );
    for (const row of due.rows) {
      await sendReviewRequest(row);
    }
    if (due.rows.length) console.log(`[Reviews] processed ${due.rows.length} due request(s)`);
  } catch (err) {
    console.error('[Reviews] poller error:', err.message);
  }
}

export async function getByToken(token) {
  const r = await pool.query('SELECT * FROM review_requests WHERE token = $1', [token]);
  return r.rows[0] || null;
}

/**
 * Record a star rating and decide where to route the customer next. Rating is
 * only stamped once (rated_at COALESCE), but re-clicks update routed_to so the
 * same link always lands on the right page.
 */
export async function recordRating(token, rating) {
  const row = await getByToken(token);
  if (!row) return null;
  const routed = rating >= MIN_PUBLIC_RATING ? 'public' : 'private';
  await pool.query(
    `UPDATE review_requests
       SET rating = $1,
           rated_at = COALESCE(rated_at, CURRENT_TIMESTAMP),
           routed_to = $2,
           status = CASE WHEN status IN ('scheduled','sent') THEN 'rated' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [rating, routed, row.id]
  );
  return { ...row, rating, routed_to: routed };
}

export async function saveFeedback(token, feedback) {
  const row = await getByToken(token);
  if (!row) return null;
  await pool.query(
    `UPDATE review_requests SET feedback_text = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [String(feedback || '').slice(0, 4000), row.id]
  );
  return row;
}

/**
 * Save a first-party review the customer wrote on our own page (high-rating path).
 * Stored in service_reviews (unpublished, pending moderation), deduped per
 * review request via external_id so a re-submit edits rather than duplicates.
 */
export async function saveFirstPartyReview(token, { rating, body, author } = {}) {
  const row = await getByToken(token);
  if (!row) return null;
  const r = Math.min(5, Math.max(1, parseInt(rating || row.rating || 5, 10)));
  const name = (author || row.customer_name || 'Roma customer').toString().trim().slice(0, 120) || 'Roma customer';
  const text = (body || '').toString().slice(0, 4000);
  await pool.query(
    `INSERT INTO service_reviews (source, author, rating, body, review_date, external_id, is_published)
     VALUES ('first_party', $1, $2, $3, CURRENT_DATE, $4, false)
     ON CONFLICT (external_id) DO UPDATE
       SET author = EXCLUDED.author, rating = EXCLUDED.rating, body = EXCLUDED.body, review_date = EXCLUDED.review_date`,
    [name, r, text, 'rr_' + row.token]
  );
  await pool.query(
    `UPDATE review_requests SET feedback_text = $1, status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [text, row.id]
  );
  return { ok: true };
}

// Admin: list first-party reviews for moderation.
export async function listFirstPartyReviews() {
  const r = await pool.query(
    `SELECT id, source, author, rating, body, review_date, is_published, created_at
     FROM service_reviews WHERE source = 'first_party' ORDER BY created_at DESC LIMIT 500`
  );
  return r.rows;
}

// Admin: publish / unpublish a review (published ones feed the on-site aggregateRating).
export async function setReviewPublished(id, published) {
  await pool.query('UPDATE service_reviews SET is_published = $1 WHERE id = $2', [published !== false, id]);
  return { ok: true };
}

export async function recordPublicClick(token, provider) {
  await pool.query(
    `UPDATE review_requests
       SET public_provider = $1, public_clicked_at = COALESCE(public_clicked_at, CURRENT_TIMESTAMP),
           status = 'posted', updated_at = CURRENT_TIMESTAMP
     WHERE token = $2`,
    [provider, token]
  );
}
