import crypto from 'node:crypto';
import { config } from '../config/index.js';

const expected = Buffer.from(config.merchantApiKey);


export function requireApiKey(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.get('Authorization') ?? '');
  if (match) {
    const given = Buffer.from(match[1]);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return next();
    }
  }
  return res.status(401).json({ error: 'unauthorized' });
}