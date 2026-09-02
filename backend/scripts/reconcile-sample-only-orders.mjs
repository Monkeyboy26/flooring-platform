#!/usr/bin/env node
/**
 * Reconcile legacy "sample-only" orders created BEFORE the sample-only checkout
 * change (server.js: /api/checkout/place-order now creates NO order when a cart
 * is samples-only — the paid $12 shipping fee lives on the sample_request).
 *
 * Historically a sample-only checkout produced a hollow order (zero order_items,
 * only sample_shipping charged) AND a sample_request, and double-emailed the
 * customer. This script cleans up each such order by:
 *   1. Copying the $12 payment onto its matching sample_request
 *      (shipping_payment_collected / _method / _intent_id / _amount / _at) so
 *      the request carries its own refundable payment going forward.
 *   2. Voiding the hollow order (status='cancelled' + an explanatory note).
 *      The $12 is NOT refunded — it is a legitimate sample-shipping charge, now
 *      recorded on the request. The Stripe charge itself is untouched.
 *
 * The order is matched to its sample_request by customer_email + a ±60s
 * created_at window (they were created in the same place-order transaction),
 * only pairing requests that don't already carry a payment intent.
 *
 * Sends NO emails and issues NO refunds. Idempotent — safe to re-run (skips
 * already-cancelled orders and requests that already have a payment intent).
 *
 * Usage:
 *   node scripts/reconcile-sample-only-orders.mjs            # dry-run (default)
 *   node scripts/reconcile-sample-only-orders.mjs --apply    # write changes
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  const client = await pool.connect();
  try {
    // Hollow sample-only orders: no product line items, a sample-shipping charge,
    // not already cancelled.
    const orders = await client.query(`
      SELECT o.id, o.order_number, o.customer_email, o.customer_name, o.total,
             o.sample_shipping, o.stripe_payment_intent_id, o.payment_method,
             o.status, o.created_at, o.notes
      FROM orders o
      WHERE (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) = 0
        AND COALESCE(o.sample_shipping, 0) > 0
        AND o.status <> 'cancelled'
      ORDER BY o.created_at
    `);

    if (!orders.rows.length) {
      console.log('No hollow sample-only orders found. Nothing to do.');
      return;
    }

    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${orders.rows.length} hollow sample-only order(s):\n`);
    let reconciled = 0, skipped = 0;

    for (const o of orders.rows) {
      // Find the sample_request created alongside this order.
      const srRes = await client.query(`
        SELECT id, request_number, shipping_payment_intent_id, shipping_payment_collected
        FROM sample_requests
        WHERE customer_email IS NOT DISTINCT FROM $1
          AND created_at BETWEEN $2::timestamp - INTERVAL '60 seconds' AND $2::timestamp + INTERVAL '60 seconds'
        ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $2::timestamp)))
        LIMIT 2
      `, [o.customer_email, o.created_at]);

      if (srRes.rows.length === 0) {
        console.log(`  ✗ ${o.order_number} (${o.customer_email}) — NO matching sample_request; leaving order untouched.`);
        skipped++;
        continue;
      }
      if (srRes.rows.length > 1) {
        console.log(`  ✗ ${o.order_number} (${o.customer_email}) — AMBIGUOUS (${srRes.rows.length} sample_requests in window); leaving untouched. Reconcile manually.`);
        skipped++;
        continue;
      }
      const sr = srRes.rows[0];
      const amt = parseFloat(o.sample_shipping).toFixed(2);
      console.log(`  ✓ ${o.order_number} → sample request ${sr.request_number} — move $${amt} onto request, void order.`);

      if (APPLY) {
        await client.query('BEGIN');
        // 1) Move payment onto the request (only if it isn't already there).
        await client.query(`
          UPDATE sample_requests
             SET shipping_payment_collected = true,
                 shipping_payment_collected_at = COALESCE(shipping_payment_collected_at, $2),
                 shipping_payment_method = COALESCE(shipping_payment_method, $3),
                 shipping_payment_intent_id = COALESCE(shipping_payment_intent_id, $4),
                 shipping_amount_paid = COALESCE(shipping_amount_paid, $5)
           WHERE id = $1
        `, [sr.id, o.created_at, o.payment_method || 'stripe', o.stripe_payment_intent_id, amt]);

        // 2) Void the hollow order (no refund — the $12 is now recorded on the
        //    request). Note references the request for the audit trail.
        const note = `[Sample-only order migrated to sample request ${sr.request_number} — $${amt} shipping recorded there, not refunded]`;
        await client.query(`
          UPDATE orders
             SET status = 'cancelled',
                 notes = CASE WHEN COALESCE(notes,'') = '' THEN $2 ELSE notes || ' ' || $2 END
           WHERE id = $1
        `, [o.id, note]);
        await client.query('COMMIT');
      }
      reconciled++;
    }

    console.log(`\n${APPLY ? 'Applied' : 'Would reconcile'}: ${reconciled}; skipped: ${skipped}.`);
    if (!APPLY) console.log('Re-run with --apply to write changes.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
