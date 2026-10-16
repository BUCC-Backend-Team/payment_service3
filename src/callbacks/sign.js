import crypto from 'node:crypto';
import { config } from '../config/index.js';

export function signBody(body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto
    .createHmac('sha256', config.callbackSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}