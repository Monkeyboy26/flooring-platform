// Backfill Stripe receipt data onto existing settled order_payments rows.
//
// For every completed card/ACH payment that has a Stripe payment_intent id but no
// captured receipt yet, retrieve the charge and store receipt_url / receipt_number /
// charge id / card brand+last4. Idempotent — re-running only touches rows still
// missing a receipt. Same logic the settlement webhooks now run going forward.
//
// Run in the API container (has STRIPE_SECRET_KEY + DB env):
//   docker exec flooring-api node scripts/backfill-stripe-receipts.mjs [--dry-run]

import pg from 'pg';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not set — aborting.');
    process.exit(1);
  }
  const { rows } = await pool.query(
    `SELECT id, stripe_payment_intent_id FROM order_payments
      WHERE stripe_payment_intent_id IS NOT NULL AND stripe_receipt_url IS NULL
        AND payment_type IN ('charge','additional_charge') AND status = 'completed'
      ORDER BY created_at`);
  console.log(`Found ${rows.length} settled Stripe payment(s) missing a receipt.${DRY ? ' (dry run)' : ''}`);

  let ok = 0, skip = 0, err = 0;
  for (const row of rows) {
    try {
      const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { expand: ['latest_charge'] });
      const ch = pi && pi.latest_charge;
      if (!ch || typeof ch !== 'object' || !ch.receipt_url) {
        skip++;
        console.log(`  skip ${row.id} — no charge/receipt on ${row.stripe_payment_intent_id}`);
        continue;
      }
      const card = ch.payment_method_details && ch.payment_method_details.card;
      if (!DRY) {
        await pool.query(
          `UPDATE order_payments
             SET stripe_charge_id = $1, stripe_receipt_url = $2, stripe_receipt_number = $3,
                 card_brand = COALESCE($4, card_brand), card_last4 = COALESCE($5, card_last4)
           WHERE id = $6`,
          [ch.id || null, ch.receipt_url || null, ch.receipt_number || null,
           card ? card.brand : null, card ? card.last4 : null, row.id]);
      }
      ok++;
      console.log(`  ${DRY ? '[dry] ' : ''}ok ${row.id} — ${ch.receipt_number || 'no receipt #'}${card ? ' · ' + card.brand + ' ····' + card.last4 : ''}`);
      await new Promise(r => setTimeout(r, 120)); // gentle rate limit
    } catch (e) {
      err++;
      console.error(`  err ${row.id} — ${e.message}`);
    }
  }
  console.log(`Done. updated=${ok} skipped=${skip} errors=${err}${DRY ? ' (dry run — no writes)' : ''}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
