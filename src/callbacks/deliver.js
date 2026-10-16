import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { signBody } from './sign.js';

export const MAX_ATTEMPTS = 30;        
const MAX_DELAY_SECONDS = 60;          


export async function attemptDelivery(row) {
 
  const body = JSON.stringify(row.payload);

  let failure = null;
  try {
    const res = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MarketlySignature': signBody(body),   
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => {});      
    if (res.status < 200 || res.status >= 300) failure = `HTTP ${res.status}`;
  } catch (err) {
    failure = err.message;                        
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