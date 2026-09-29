/**
 * One-shot Sentry backend connectivity check. Sends a single test event using
 * SENTRY_DSN_BACKEND and flushes, so you can confirm the DSN + network path
 * reach the "backend" Sentry project without waiting for a real error.
 *
 * Usage (inside the api container, where @sentry/node + the env var live):
 *   docker exec flooring-api node scripts/sentry-verify.mjs
 *
 * Safe to leave in the repo — it's a manual tool, never imported by the server.
 */
const dsn = process.env.SENTRY_DSN_BACKEND || '';
if (!dsn) { console.error('SENTRY_DSN_BACKEND not set — nothing to test'); process.exit(1); }

const Sentry = await import('@sentry/node');
Sentry.init({ dsn, environment: process.env.NODE_ENV || 'development', tracesSampleRate: 0 });

const id = Sentry.captureException(new Error('[sentry-verify] backend connectivity test — safe to ignore'));
console.log('event queued:', id);
const ok = await Sentry.flush(5000);
console.log('flushed:', ok);
process.exit(ok ? 0 : 2);
