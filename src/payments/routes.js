import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, withTx } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { validateCreatePayment } from './validate.js';
import { claimKey, hashBody, waitForResponse } from './idempotency.js';
import { completePayment } from './complete.js';

const router = Router();
const SCOPE = 'payment';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendSaved(res, saved) {
  res.set('Idempotent-Replayed', 'true');
  return res.status(saved.status).json(saved.body);
}

// POST /payments
router.post('/', async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 255) {
      throw new HttpError(400, 'invalid_request', 'Idempotency-Key header is required');
    }
    const invalid = validateCreatePayment(req.body);
    if (invalid) throw new HttpError(400, 'invalid_request', invalid);

    const { orderId, amount, currency, customerEmail, returnUrl } = req.body;
    const hash = hashBody({ orderId, amount, currency, customerEmail, returnUrl });

    // Transaction 1: claim the key AND insert the pending payment, together.
    const outcome = await withTx(async (c) => {
      const claim = await claimKey(c, SCOPE, key, hash);
      if (claim.state !== 'claimed') return { existing: claim };

      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO payments (id, order_id, amount, currency, customer_email, return_url, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [id, orderId, amount, currency, customerEmail, returnUrl]
        );
      } catch (err) {
        // The one_active_payment_per_order index refused it.
        if (err.code === '23505') {
          throw new HttpError(409, 'payment_exists', 'Order already has an active payment');
        }
        throw err;
      }
      await c.query(
        'UPDATE idempotency_keys SET resource_id = $3 WHERE scope = $1 AND key = $2',
        [SCOPE, key, id]
      );
      return { paymentId: id };
    });

     if (outcome.paymentId) {
      const result = await completePayment(outcome.paymentId, SCOPE, key);
      return res.status(result.status).json(result.body);
    }

    const ex = outcome.existing;
    if (ex.state === 'mismatch') {
      throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was used with a different request body');
    }
    if (ex.state === 'replay') return sendSaved(res, ex);

    const saved = await waitForResponse(SCOPE, key);
    if (saved) return sendSaved(res, saved);

    // Still nothing: the original request probably died. Pick it up and finish it.
    const result = await completePayment(ex.resourceId, SCOPE, key);
    return sendSaved(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /payments/:id
router.get('/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw new HttpError(404, 'not_found', 'Payment not found');
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found');
    res.json({
      paymentId: p.id,
      orderId: p.order_id,
      status: p.status,
      channel: p.channel,
      amount: p.amount,
      currency: p.currency,
      amountRefunded: p.amount_refunded,
      checkoutUrl: p.checkout_url,
      late: p.late,
    });
  } catch (err) {
    next(err);
  }
});

export default router;