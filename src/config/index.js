import 'dotenv/config';

const required = [
  'DATABASE_URL',
  'PAYSTACK_SECRET_KEY',
  'MERCHANT_API_KEY',
  'CALLBACK_URL',
  'CALLBACK_SECRET',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const timeout = Number(process.env.PAYMENT_TIMEOUT_SECONDS ?? 1800);
if (!Number.isFinite(timeout) || timeout <= 0) {
  console.error('PAYMENT_TIMEOUT_SECONDS must be a positive number');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  merchantApiKey: process.env.MERCHANT_API_KEY,
  callbackUrl: process.env.CALLBACK_URL,
  callbackSecret: process.env.CALLBACK_SECRET,
  paymentTimeoutSeconds: timeout,
  testMode: process.env.TEST_MODE === 'true',
};