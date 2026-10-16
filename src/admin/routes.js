import { Router } from 'express';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

const router = Router();

// POST /admin/reset  (only when TEST_MODE=true; otherwise it does not exist)
router.post('/reset', async (req, res, next) => {
  if (!config.testMode) return res.status(404).json({ error: 'not_found' });
  try {
    await pool.query(
      'TRUNCATE refunds, payments, idempotency_keys, processed_events, callback_outbox');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;