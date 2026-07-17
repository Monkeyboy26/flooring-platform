-- Durable record of emails that exhausted all delivery retries.
-- Transactional emails (order confirmation, etc.) are sent fire-and-forget in the
-- background; before this table a failed send was only console-logged and lost.
-- Now the delivery wrapper (emailService.deliver) records permanent failures here
-- so they are queryable and can be surfaced/alerted on.

CREATE TABLE IF NOT EXISTS email_failures (
  id            SERIAL PRIMARY KEY,
  recipient     TEXT,
  subject       TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

-- Fast lookup of outstanding (unresolved) failures for the admin surface.
CREATE INDEX IF NOT EXISTS idx_email_failures_unresolved
  ON email_failures (created_at DESC)
  WHERE resolved_at IS NULL;
