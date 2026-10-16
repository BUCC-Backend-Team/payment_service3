import { pool, withTx } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { provider, ProviderError } from '../providers/index.js';
import { saveResponse } from './idempotency.js';

// Step 2 of creating a payment: call Paystack, then save the checkout URL and the
// final response. Also used to finish a request that died half-way: the payment
// ID is the Paystack reference, so repeating the call is safe.
export async function completePayment(paymentId, scope, key) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const p = rows[0];
  if (!p) throw new HttpError(500, 'internal_error', 'Payment record is missing');

  let checkoutUrl = p.checkout_url;

  if (!checkoutUrl) {
    try {
      const init = await provider.initialize({
        reference: p.id,
        email: p.customer_email,
        amount: p.amount,
        callbackUrl: p.return_url,
      });
      checkoutUrl = init.authorizationUrl;
    } catch (err) {
      const definitelyRejected =
        err instanceof ProviderError && !err.retryable && err.code !== 'duplicate_reference';

      if (definitelyRejected) {
        // Paystack said no, so nothing exists there. Free the order and the key.
        await withTx(async (c) => {
          await c.query('DELETE FROM payments WHERE id = $1 AND checkout_url IS NULL', [p.id]);
          await c.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
        });
        throw new HttpError(502, 'provider_rejected', err.message);
      }

      // Outcome unknown (timeout, 5xx, duplicate reference). Keep the pending payment.
      // The same Idempotency-Key can retry, and the expiry job reconciles it later.
      throw new HttpError(503, 'provider_unavailable',
        'Payment provider did not confirm. Retry with the same Idempotency-Key.');
    }
  }

  const body = {
    paymentId: p.id,
    orderId: p.order_id,
    status: 'pending',
    amount: p.amount,
    currency: p.currency,
    checkoutUrl,
  };

  await withTx(async (c) => {
    await c.query('UPDATE payments SET checkout_url = $2, updated_at = now() WHERE id = $1', [p.id, checkoutUrl]);
    await saveResponse(c, scope, key, 201, body);
  });

  return { status: 201, body };
}