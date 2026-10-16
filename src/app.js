import express from 'express';
import { requireApiKey } from './middleware/auth.js';
import paymentsRouter from './payments/routes.js';
import { paystackWebhook } from './webhooks/routes.js';
import refundsRouter from './refunds/routes.js';
import adminRouter from './admin/routes.js';
export function buildApp() {
  const app = express();
  app.disable('x-powered-by');


  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/webhooks/paystack', express.raw({ type: '*/*', limit: '1mb' }), paystackWebhook);

  app.use(express.json({ limit: '100kb' }));
  app.use(requireApiKey);
  app.use('/payments/:id/refunds', refundsRouter);
  app.use('/payments', paymentsRouter);
  app.use('/admin', adminRouter);

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON' });
    }
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}