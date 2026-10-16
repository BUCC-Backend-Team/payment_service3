import { config } from '../config/index.js';
import { ProviderError } from './errors.js';

const BASE = 'https://api.paystack.co';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry only network errors / 5xx / 429. Never retry declines or validation errors.
async function withRetry(fn, attempts = 3, baseMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ProviderError) || !err.retryable) throw err;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Timeout / DNS / connection reset: we do NOT know whether Paystack processed it.
    throw new ProviderError('network_error', err.message, { retryable: true });
  }

  const json = await res.json().catch(() => ({}));

  if (res.status >= 500 || res.status === 429) {
    throw new ProviderError('provider_5xx', json.message ?? `HTTP ${res.status}`, {
      retryable: true,
      status: res.status,
    });
  }
  if (!res.ok) {
    const msg = json.message ?? `HTTP ${res.status}`;
    const code = /duplicate/i.test(msg) ? 'duplicate_reference' : 'rejected';
    throw new ProviderError(code, msg, { retryable: false, status: res.status });
  }
  return json;
}

export const paystack = {

  // Start a transaction. `reference` is OUR payment ID.
  async initialize({ reference, email, amount, callbackUrl }) {
    const json = await withRetry(() =>
      request('POST', '/transaction/initialize', {
        reference,
        email,
        amount,
        currency: 'NGN',
        callback_url: callbackUrl,
        channels: ['card', 'bank_transfer'],
      })
    );
    return { authorizationUrl: json.data.authorization_url, accessCode: json.data.access_code };
  },
    async refund({ reference, amount }) {
    const json = await request('POST', '/refund', { transaction: reference, amount });
    const d = json.data ?? {};
    return { id: d.id != null ? String(d.id) : null, status: d.status };
  },

  // All refunds Paystack has for a transaction (used to recover after a timeout).
  async listRefunds(reference) {
    const json = await withRetry(() =>
      request('GET', `/refund?transaction=${encodeURIComponent(reference)}`)
    );
    return (json.data ?? []).map((d) => ({ id: String(d.id), amount: Number(d.amount), status: d.status }));
  },

  async getRefund(id) {
    const json = await withRetry(() => request('GET', `/refund/${encodeURIComponent(id)}`));
    const d = json.data ?? {};
    return { id: String(d.id ?? id), amount: Number(d.amount), status: d.status };
  },

  // Ask Paystack what really happened. Returns null if it has never seen the reference.
  async verify(reference) {
    try {
      const json = await withRetry(() =>
        request('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
      );
      const d = json.data;
      return {
        status: d.status,        // 'success' | 'abandoned' | 'failed' | ...
        amount: d.amount,
        currency: d.currency,
        channel: d.channel,      // 'card' | 'bank_transfer'
        reference: d.reference,
      };
    } catch (err) {
      // Paystack answers an unknown reference with a 400 "Transaction reference not found".
      if (
        err instanceof ProviderError &&
        (err.status === 404 || /not found/i.test(err.message))
      ) {
        return null;
      }
      throw err;
    }
  },
};