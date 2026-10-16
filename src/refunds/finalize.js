import { withTx } from '../db/pool.js';
import { enqueueCallback } from '../callbacks/outbox.js';
import { paymentFromStates, refundFromStates } from '../payments/stateMachine.js';

// Refund pending -> processed. In ONE transaction: dedupe key, refund status,
// payment totals/status, callback. Safe against webhook + reconciliation racing.
export async function markRefundProcessed({ refundId, dedupeKey = null, providerRefundId = null }) {
  return withTx(async (c) => {
    if (dedupeKey) {
      const seen = await c.query(
        'INSERT INTO processed_events (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [dedupeKey]);
      if (seen.rowCount === 0) return { outcome: 'duplicate' };
    }
    const r = await c.query(
      `UPDATE refunds
          SET status = 'processed',
              provider_refund_id = COALESCE(provider_refund_id, $3),
              updated_at = now()
        WHERE id = $1 AND status = ANY($2)
        RETURNING *`,
      [refundId, refundFromStates('processed'), providerRefundId]
    );
    if (!r.rows.length) return { outcome: 'noop' };
    const refund = r.rows[0];

    const p = await c.query(
      `UPDATE payments
          SET amount_refunded = amount_refunded + $2::bigint,
              status = CASE WHEN amount_refunded + $2::bigint >= amount
                            THEN 'refunded' ELSE 'partially_refunded' END,
              updated_at = now()
        WHERE id = $1 AND status = ANY($3)
        RETURNING *`,
      [refund.payment_id, refund.amount, paymentFromStates('refunded')]
    );
    // The reservation guarantees this can't happen; if it does, roll everything back.
    if (!p.rows.length) throw new Error(`payment ${refund.payment_id} cannot accept refund ${refundId}`);

    await enqueueCallback(c, 'payment.refunded', p.rows[0]);
    return { outcome: 'processed', refund, payment: p.rows[0] };
  });
}

// Refund pending -> failed. Releases the reserved amount so it can be refunded again.
export async function markRefundFailed({ refundId, dedupeKey = null, providerRefundId = null }) {
  return withTx(async (c) => {
    if (dedupeKey) {
      const seen = await c.query(
        'INSERT INTO processed_events (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [dedupeKey]);
      if (seen.rowCount === 0) return { outcome: 'duplicate' };
    }
    const r = await c.query(
      `UPDATE refunds
          SET status = 'failed',
              provider_refund_id = COALESCE(provider_refund_id, $3),
              updated_at = now()
        WHERE id = $1 AND status = ANY($2)
        RETURNING *`,
      [refundId, refundFromStates('failed'), providerRefundId]
    );
    if (!r.rows.length) return { outcome: 'noop' };
    const refund = r.rows[0];

    const p = await c.query(
      `UPDATE payments
          SET refund_reserved = refund_reserved - $2::bigint, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [refund.payment_id, refund.amount]
    );
    await enqueueCallback(c, 'payment.refund_failed', p.rows[0]);
    return { outcome: 'failed', refund, payment: p.rows[0] };
  });
}