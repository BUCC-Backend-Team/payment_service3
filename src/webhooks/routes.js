import { pool } from '../db/pool.js';
import { provider } from '../providers/index.js';
import { markPaymentSucceeded } from '../payments/succeed.js';
import { isValidSignature } from './signature.js';
import { markRefundProcessed, markRefundFailed } from '../refunds/finalize.js';

// POST /webhooks/paystack
// Mounted in app.js with express.raw(), so req.body is the exact bytes Paystack sent.
export async function paystackWebhook(req, res) {
  // 1. Prove it came from Paystack. Anything else changes nothing.
  if (!isValidSignature(req.body, req.get('x-paystack-signature'))) {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON' });
  }

  try {
    switch (event.event) {
      case 'charge.success':
        await handleChargeSuccess(event);
        break;
      case 'refund.processed':
      case 'refund.failed':
        await handleRefundEvent(event);
        break;
      default:
        break; // any other event: just acknowledge
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Something broke on OUR side (database, or Paystack's verify was unreachable).
    // Answer 500 so Paystack sends the event again. Nothing was recorded as handled.
    console.error('webhook processing failed:', err);
    return res.status(500).json({ error: 'processing_failed' });
  }
}

async function handleChargeSuccess(event) {
  const data = event.data ?? {};
  const reference = data.reference;
  if (!reference) return;

  const dedupeKey = `charge.success:${data.id ?? reference}`;


  const seen = await pool.query('SELECT 1 FROM processed_events WHERE dedupe_key = $1', [dedupeKey]);
  if (seen.rowCount) return;

  // Never trust the webhook body. Ask Paystack what really happened.
  const verified = await provider.verify(reference);
  if (!verified) {
    console.warn(`webhook: Paystack does not know reference ${reference}`);
    return;
  }

  const { outcome } = await markPaymentSucceeded({ reference, verified, dedupeKey });
  if (outcome === 'mismatch') {
    console.warn(`webhook: amount/currency mismatch for ${reference}, payment left unchanged`);
  } else if (outcome === 'conflict') {
    console.warn(`webhook: late success for ${reference} but its order has another active payment`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


async function findRefund(data) {
  if (data.id != null) {
    const { rows } = await pool.query('SELECT * FROM refunds WHERE provider_refund_id = $1', [String(data.id)]);
    if (rows[0]) return rows[0];
  }
  const ref = data.transaction_reference ?? data.transaction?.reference;
  if (!ref || !UUID_RE.test(ref)) return null;
  const { rows } = await pool.query(
    `SELECT * FROM refunds
      WHERE payment_id = $1 AND status = 'pending' AND provider_refund_id IS NULL
        AND ($2::bigint IS NULL OR amount = $2::bigint)
      ORDER BY created_at LIMIT 1`,
    [ref, data.amount != null ? Number(data.amount) : null]
  );
  return rows[0] ?? null;
}

async function handleRefundEvent(event) {
  const data = event.data ?? {};
  const dedupeKey = `${event.event}:${data.id ?? data.refund_reference ?? data.transaction_reference}`;

  const seen = await pool.query('SELECT 1 FROM processed_events WHERE dedupe_key = $1', [dedupeKey]);
  if (seen.rowCount) return;

  const refund = await findRefund(data);
  if (!refund) {
    console.warn(`webhook: ${event.event} for a refund we do not know (id ${data.id})`);
    return;
  }
  const args = { refundId: refund.id, dedupeKey, providerRefundId: data.id != null ? String(data.id) : null };
  if (event.event === 'refund.processed') await markRefundProcessed(args);
  else await markRefundFailed(args);
}