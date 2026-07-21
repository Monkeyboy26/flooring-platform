import { emailShell, heroSection, section, ctaButton, detailList, money, T, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

// Payment confirmation email, sent after a customer settles (part of) their
// balance via a payment link. Matches the Brass Charcoal house style used by
// the order-confirmation and payment-request emails. `order` is the order row
// with amount_paid already updated; `amount` is the payment just received.
export function generatePaymentReceivedHTML({ order, amount }) {
  const { order_number, customer_name } = order;
  const paid = parseFloat(amount || 0);
  const remaining = parseFloat((parseFloat(order.total || 0) - parseFloat(order.amount_paid || 0)).toFixed(2));
  const hasBalance = remaining > 0.01;
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');

  const summary = detailList([
    { label: 'Amount received', value: money(paid) },
    { label: 'Order', value: esc(order_number) },
    hasBalance
      ? { label: 'Remaining balance', value: money(remaining) }
      : { label: 'Balance', value: 'Paid in full &#10003;' }
  ]);

  const content = [
    heroSection({
      eyebrow: `Order ${esc(order_number)} &middot; Payment received`,
      headline: 'Payment <em style="font-style:italic;">received</em>.',
      body: hasBalance
        ? `${firstName} &mdash; thank you. We've received your payment of ${money(paid)} toward order ${esc(order_number)}. A balance of ${money(remaining)} remains; details are below.`
        : `${firstName} &mdash; thank you. We've received your payment of ${money(paid)} and order ${esc(order_number)} is now paid in full.`,
      chip: `&#10003; Paid &middot; ${money(paid)}`
    }),
    section(summary, '8px 40px 28px'),
    ctaButton({
      href: `${SITE_URL}/account`,
      label: 'View your order &rarr;',
      note: 'A receipt is on file under Account &middot; Orders. Questions? Reply to this email or call (714) 999-0009 &mdash; it reaches our showroom team in Anaheim.'
    })
  ].join('');

  return emailShell({
    title: `Payment Received — Order ${order_number}`,
    preheader: hasBalance
      ? `We received ${money(paid)} toward order ${order_number}. ${money(remaining)} remaining.`
      : `We received ${money(paid)} — order ${order_number} is paid in full. Thank you.`,
    content
  });
}
