import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { signBody } from './sign.js';

export const MAX_ATTEMPTS = 30;        // after this many failures a callback is marked 'dead'
const MAX_DELAY_SECONDS = 60;          // backoff is 1s, 2s, 4s, 8s ... capped at this

// Send ONE outbox row to Marketly and record what happened.
// `row` is a callback_outbox row. Returns true if Marketly accepted it.
export async function attemptDelivery(row) {
  // The stored payload is serialised once; the same string is signed AND sent.
  const body = JSON.stringify(row.payload);

  let failure = null;
  try {
    const res = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MarketlySignature': signBody(body),   // fresh timestamp on every attempt
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => {});      // free the connection
    if (res.status < 200 || res.status >= 300) failure = `HTTP ${res.status}`;
  } catch (err) {
    failure = err.message;                        // timeout, connection refused, DNS...
  }

  if (!failure) {
    await pool.query(
      `UPDATE callback_outbox
          SET status = 'delivered', delivered_at = now(), attempts = attempts + 1, last_error = NULL
        WHERE id = $1`,
      [row.id]
    );
    return true;
  }

  // Failed: wait 1s, 2s, 4s, ... before the next try (row.attempts counts earlier tries).
  const delaySeconds = Math.min(2 ** row.attempts, MAX_DELAY_SECONDS);
  await pool.query(
    `UPDATE callback_outbox
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + make_interval(secs => $3::double precision),
            status = CASE WHEN attempts + 1 >= $4 THEN 'dead' ELSE 'pending' END
      WHERE id = $1`,
    [row.id, failure.slice(0, 500), delaySeconds, MAX_ATTEMPTS]
  );
  return false;
}