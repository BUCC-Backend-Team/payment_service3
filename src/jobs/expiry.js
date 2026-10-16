import { pool, withTx } from '../db/pool.js';
import { config } from '../config/index.js';
import { provider } from '../providers/index.js';
import { markPaymentSucceeded } from '../payments/succeed.js';
import { paymentFromStates } from '../payments/stateMachine.js';
import { enqueueCallback } from '../callbacks/outbox.js';

const TICK_MS = 2000;
const LATE_CHECK_EVERY = 8;        // look at recently expired payments every 8th tick
const LATE_WINDOW = '1 hour';

let timer = null;
let busy = false;
let ticks = 0;

async function expire(id) {
  await withTx(async (c) => {
    // Conditional: if a webhook succeeded it first, 0 rows match and we do nothing.
    const { rows } = await c.query(
      `UPDATE payments SET status = 'expired', updated_at = now()
        WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [id, paymentFromStates('expired')]
    );
    if (rows.length) await enqueueCallback(c, 'payment.expired', rows[0]);
  });
}

// Ask Paystack the truth about one payment and make our database agree.
async function reconcile(payment) {
  let verified;
  try {
    verified = await provider.verify(payment.id);
  } catch (err) {
    console.warn(`expiry job: could not verify ${payment.id}, will retry:`, err.message);
    return;
  }
  if (verified && verified.status === 'success') {

    const { outcome } = await markPaymentSucceeded({ reference: payment.id, verified });
    if (outcome === 'mismatch') console.warn(`expiry job: amount mismatch for ${payment.id}`);
    return;
  }
  if (payment.status === 'pending') await expire(payment.id);
}

export async function runExpiryOnce() {
  const { rows: stale } = await pool.query(
    `SELECT id, status FROM payments
      WHERE status = 'pending' AND created_at <= now() - make_interval(secs => $1::double precision)
      ORDER BY created_at LIMIT 50`,
    [config.paymentTimeoutSeconds]
  );
  for (const p of stale) await reconcile(p);

  if (ticks % LATE_CHECK_EVERY === 0) {
    const { rows: expired } = await pool.query(
      `SELECT id, status FROM payments
        WHERE status = 'expired' AND updated_at > now() - interval '${LATE_WINDOW}'
        ORDER BY updated_at DESC LIMIT 50`
    );
    for (const p of expired) await reconcile(p);
  }
  ticks++;
}

export function startExpiryJob() {
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runExpiryOnce();
    } catch (err) {
      console.error('expiry job error:', err);
    } finally {
      busy = false;
    }
  }, TICK_MS);
}

export function stopExpiryJob() {
  clearInterval(timer);
}