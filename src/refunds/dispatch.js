import { pool } from '../db/pool.js';
import { provider, ProviderError } from '../providers/index.js';
import { markRefundProcessed, markRefundFailed } from './finalize.js';

const mapStatus = (s) => (s === 'processed' ? 'processed' : s === 'failed' ? 'failed' : 'pending');

async function applyProviderStatus(refund, provRefund) {
  const st = mapStatus(provRefund.status);
  if (st === 'processed') return markRefundProcessed({ refundId: refund.id, providerRefundId: provRefund.id });
  if (st === 'failed') return markRefundFailed({ refundId: refund.id, providerRefundId: provRefund.id });
  await pool.query(
    `UPDATE refunds SET provider_refund_id = COALESCE(provider_refund_id, $2),
            dispatched_at = COALESCE(dispatched_at, now()), updated_at = now()
      WHERE id = $1`, [refund.id, provRefund.id]);
  return { outcome: 'accepted' };
}
export async function dispatchRefund(refundId) {
  const claim = await pool.query(
    `UPDATE refunds
        SET dispatch_attempts = dispatch_attempts + 1, last_dispatch_at = now()
      WHERE id = $1 AND status = 'pending'
        AND provider_refund_id IS NULL AND dispatched_at IS NULL
        AND (last_dispatch_at IS NULL
             OR last_dispatch_at <= now() - make_interval(
                  secs => GREATEST(15, LEAST(power(2, dispatch_attempts), 60))::double precision))
      RETURNING *`,
    [refundId]
  );
  const refund = claim.rows[0];
  if (!refund) return { outcome: 'skipped' };

  try {
    if (refund.dispatch_attempts > 1) {
      const list = await provider.listRefunds(refund.payment_id);
      const { rows: taken } = await pool.query(
        'SELECT provider_refund_id FROM refunds WHERE payment_id = $1 AND provider_refund_id IS NOT NULL',
        [refund.payment_id]);
      const takenIds = new Set(taken.map((t) => t.provider_refund_id));
      const match = list.find((x) => x.amount === refund.amount && !takenIds.has(x.id));
      if (match) return await applyProviderStatus(refund, match);
    }

    const res = await provider.refund({ reference: refund.payment_id, amount: refund.amount });
    return await applyProviderStatus(refund, { id: res.id, status: res.status });
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
     
      console.warn(`refund ${refund.id} rejected by Paystack: ${err.message}`);
      return markRefundFailed({ refundId: refund.id });
    }
    console.warn(`refund ${refund.id} dispatch attempt ${refund.dispatch_attempts} failed, will retry:`, err.message);
    return { outcome: 'retry' };
  }
}

// Reconciliation for refunds Paystack accepted but whose webhook never arrived.
export async function reconcileRefund(refund) {
  await pool.query('UPDATE refunds SET last_checked_at = now() WHERE id = $1', [refund.id]);
  try {
    if (refund.provider_refund_id) {
      return await applyProviderStatus(refund, await provider.getRefund(refund.provider_refund_id));
    }
    const list = await provider.listRefunds(refund.payment_id);
    const { rows: taken } = await pool.query(
      'SELECT provider_refund_id FROM refunds WHERE payment_id = $1 AND provider_refund_id IS NOT NULL',
      [refund.payment_id]);
    const takenIds = new Set(taken.map((t) => t.provider_refund_id));
    const match = list.find((x) => x.amount === refund.amount && !takenIds.has(x.id));
    if (match) return await applyProviderStatus(refund, match);
  } catch (err) {
    console.warn(`refund reconcile ${refund.id} failed:`, err.message);
  }
  return { outcome: 'unchanged' };
}