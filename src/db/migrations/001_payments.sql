-- 001_payments.sql  (amounts are integer kobo, currency is NGN only)

CREATE TABLE payments (
  id              UUID PRIMARY KEY,          -- also used as the Paystack reference
  order_id        TEXT NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL CHECK (currency = 'NGN'),
  customer_email  TEXT NOT NULL,
  return_url      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('pending','succeeded','expired','partially_refunded','refunded')),
  channel         TEXT,                      -- card | bank_transfer, filled in on success
  amount_refunded BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  checkout_url    TEXT,
  late            BOOLEAN NOT NULL DEFAULT FALSE,   -- true if it succeeded after expiring
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_refunded <= amount)
);

-- At most ONE active payment per order, enforced by the database itself.
CREATE UNIQUE INDEX one_active_payment_per_order
  ON payments (order_id)
  WHERE status IN ('pending','succeeded','partially_refunded');

-- Every idempotency key we have seen, with the response we gave.
-- scope separates payments from refunds so their keys can't collide.
CREATE TABLE idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,             -- fingerprint of the request body
  response_status INT,                       -- NULL until the request has finished
  response_body   JSONB,
  resource_id     TEXT,                      -- the payment this key created (crash recovery)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);