import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { withTx } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { claimKey, hashBody, saveResponse, waitForResponse } from '../payments/idempotency.js';
import { dispatchRefund } from './dispatch.js';

const router = Router({ mergeParams: true });
const SCOPE = 'refund';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /payments/:id/refunds
router.post('/', async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 255) {
      throw new HttpError(400, 'invalid_request', 'Idempotency-Key header is required');
    }
    const paymentId = req.params.id;
    if (!UUID_RE.test(paymentId)) throw new HttpError(404, 'not_found', 'Payment not found');

    const amount = req.body?.amount;
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      throw new HttpError(400, 'invalid_request', 'amount must be a positive whole number (kobo)');
    }
    const hash = hashBody({ paymentId, amount: amount ?? null });

    const outcome = await withTx(async (c) => {
      const claim = await claimKey(c, SCOPE, key, hash);
      if (claim.state !== 'claimed') return { existing: claim };

      const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const p = rows[0];
      if (!p) throw new HttpError(404, 'not_found', 'Payment not found');
      if (!['succeeded', 'partially_refunded'].includes(p.status)) {
        throw new HttpError(409, 'not_refundable', `Payment is ${p.status}`);
      }
      const remaining = p.amount - p.refund_reserved;
      const refundAmount = amount ?? remaining;
      if (refundAmount <= 0 || refundAmount > remaining) {
        throw new HttpError(409, 'not_refundable', `Only ${remaining} kobo is left to refund`);
      }

      const refundId = randomUUID();
      await c.query('INSERT INTO refunds (id, payment_id, amount) VALUES ($1, $2, $3)',
        [refundId, paymentId, refundAmount]);
      // The CHECK (refund_reserved <= amount) is the final database-level guard.
      await c.query('UPDATE payments SET refund_reserved = refund_reserved + $2::bigint, updated_at = now() WHERE id = $1',
        [paymentId, refundAmount]);

      const body = { refundId, amount: refundAmount, status: 'pending' };
      await saveResponse(c, SCOPE, key, 202, body);
      return { refundId, body };
    });

    if (outcome.refundId) {

      dispatchRefund(outcome.refundId).catch((e) => console.error('refund dispatch error:', e));
      return res.status(202).json(outcome.body);
    }

    const ex = outcome.existing;
    if (ex.state === 'mismatch') {
      throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was used with a different request');
    }
    let saved = ex.state === 'replay' ? ex : await waitForResponse(SCOPE, key);
    if (!saved) throw new HttpError(503, 'in_progress', 'Original request still in progress; retry shortly');
    res.set('Idempotent-Replayed', 'true');
    return res.status(saved.status).json(saved.body);
  } catch (err) {
    next(err);
  }
});

export default router;