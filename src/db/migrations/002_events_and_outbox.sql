-- 002_events_and_outbox.sql

-- Webhook dedupe log. A row is inserted in the SAME transaction as the state change,
-- so "we handled this event" and "the payment changed" can never disagree.
CREATE TABLE processed_events (
  dedupe_key  TEXT PRIMARY KEY,            -- e.g. 'charge.success:<data.id>'
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Callbacks waiting to be delivered to Marketly.
-- A row is written in the SAME transaction as the state change, then a background
-- worker delivers it and retries until Marketly accepts it.
CREATE TABLE callback_outbox (
  id              UUID PRIMARY KEY,        -- sent as the callback "id"; never changes on retry
  type            TEXT NOT NULL,           -- payment.succeeded, payment.expired, ...
  payload         JSONB NOT NULL,          -- the full body, so every retry is identical
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivered','dead')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

-- The delivery worker looks for due rows here; the partial index keeps that fast.
CREATE INDEX outbox_due ON callback_outbox (next_attempt_at) WHERE status = 'pending';