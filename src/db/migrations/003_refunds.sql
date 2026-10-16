-- 003_refunds.sql

-- refund_reserved = money promised to refunds that are pending OR processed.
--   amount_refunded = only processed refunds (what the customer actually got back).
-- Reserving happens in a single conditional UPDATE, so concurrent refund requests
-- can never reserve more than the payment amount. Failed refunds release it.
ALTER TABLE payments
  ADD COLUMN refund_reserved BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT refund_reserved_bounds
    CHECK (refund_reserved >= amount_refunded AND refund_reserved <= amount);

CREATE TABLE refunds (
  id                 UUID PRIMARY KEY,
  payment_id         UUID NOT NULL REFERENCES payments(id),
  amount             BIGINT NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processed','failed')),
  provider_refund_id TEXT,                 -- Paystack's refund id, once we know it
  dispatch_attempts  INT NOT NULL DEFAULT 0,   -- bumped BEFORE each call to Paystack
  last_dispatch_at   TIMESTAMPTZ,
  dispatched_at      TIMESTAMPTZ,          -- set when Paystack accepted the request
  last_checked_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment ON refunds (payment_id);
CREATE INDEX refunds_pending ON refunds (created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX refunds_provider_id ON refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;