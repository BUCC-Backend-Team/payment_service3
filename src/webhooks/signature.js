import crypto from 'node:crypto';
import { config } from '../config/index.js';

// rawBody: the exact bytes Paystack sent (a Buffer). signature: the x-paystack-signature header.
export function isValidSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;

  const expected = crypto
    .createHmac('sha512', config.paystackSecretKey)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}