import { withTx } from '../db/pool.js';
import { enqueueCallback } from '../callbacks/outbox.js';
import { paymentFromStates } from './stateMachine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Turn a payment into `succeeded`, but only if Paystack's own answer (`verified`,
// from provider.verify) says it was paid and the amount and currency match our record.
//
// In ONE transaction this: records the dedupe key, updates the payment, queues the
// callback. Safe to call from the webhook handler and the expiry job, even at the
// same moment.
//
// Returns { outcome }, one of:
//   succeeded       - the payment moved to succeeded and a callback was queued
//   duplicate       - this exact event was already handled (nothing changed)
//   noop            - payment was not in a state that can become succeeded
//   mismatch        - Paystack's amount/currency differ from ours (nothing changed)
//   not_successful  - Paystack says the transaction was not paid
//   conflict        - a late success, but the order now has another active payment
//   ignored         - reference is not one of our payments
export async function markPaymentSucceeded({ reference, verified, dedupeKey = null }) {
  if (!UUID_RE.test(reference)) return { outcome: 'ignored' };
  if (verified.status !== 'success') return { outcome: 'not_successful' };

  try {
    return await withTx(async (c) => {
      if (dedupeKey) {
        const seen = await c.query(
          'INSERT INTO processed_events (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING',
          [dedupeKey]
        );
        if (seen.rowCount === 0) return { outcome: 'duplicate' };
      }

  
      const { rows } = await c.query(
        `UPDATE payments
            SET status = 'succeeded',
                channel = $2,
                late = (status = 'expired'),
                updated_at = now()
          WHERE id = $1
            AND status = ANY($3)
            AND amount = $4
            AND currency = $5
        RETURNING *`,
        [reference, verified.channel, paymentFromStates('succeeded'), verified.amount, verified.currency]
      );

      if (rows.length === 1) {
        await enqueueCallback(c, 'payment.succeeded', rows[0]);
        return { outcome: 'succeeded', payment: rows[0] };
      }

      // Nothing updated. Work out why, so the caller can log it properly.
      const { rows: cur } = await c.query(
        'SELECT amount, currency FROM payments WHERE id = $1', [reference]
      );
      if (!cur[0]) return { outcome: 'ignored' };
      if (cur[0].amount !== verified.amount || cur[0].currency !== verified.currency) {
        return { outcome: 'mismatch' };
      }
      return { outcome: 'noop' };
    });
  } catch (err) {
    // 23505: this was a late success, but the order now has a different active payment.
    if (err.code === '23505') return { outcome: 'conflict' };
    throw err;
  }
}