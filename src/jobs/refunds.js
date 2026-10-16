import { pool } from '../db/pool.js';
import { dispatchRefund, reconcileRefund } from '../refunds/dispatch.js';

const TICK_MS = 2000;
let timer = null;
let busy = false;

export async function runRefundJobOnce() {
  // 1. Never sent (or send failed with a retryable error): try again.
  //    dispatchRefund() applies the backoff itself.
  const { rows: unsent } = await pool.query(
    `SELECT id FROM refunds
      WHERE status = 'pending' AND provider_refund_id IS NULL AND dispatched_at IS NULL
      ORDER BY created_at LIMIT 20`);
  for (const r of unsent) await dispatchRefund(r.id);

  // 2. Sent, but no webhook yet: ask Paystack (covers lost webhooks and downtime).
  const { rows: waiting } = await pool.query(
    `SELECT * FROM refunds
      WHERE status = 'pending' AND (provider_refund_id IS NOT NULL OR dispatched_at IS NOT NULL)
        AND COALESCE(last_checked_at, dispatched_at) <= now() - interval '60 seconds'
      ORDER BY created_at LIMIT 20`);
  for (const r of waiting) await reconcileRefund(r);
}

export function startRefundJob() {
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await runRefundJobOnce(); }
    catch (err) { console.error('refund job error:', err); }
    finally { busy = false; }
  }, TICK_MS);
}

export function stopRefundJob() {
  clearInterval(timer);
}