import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Build the X-MarketlySignature header value for a callback.
// `body` must be the EXACT string that gets sent, byte for byte.
export function signBody(body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto
    .createHmac('sha256', config.callbackSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}