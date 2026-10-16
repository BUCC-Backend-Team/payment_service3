import { pool } from '../db/pool.js';
import { attemptDelivery } from './deliver.js';

const TICK_MS = 500;
const BATCH = 10;
const LEASE_SECONDS = 15;   // a claimed row is hidden this long; if we crash it reappears

let timer = null;
let busy = false;

// Claim due rows by pushing their next_attempt_at forward (a short "lease"), so two
// workers never grab the same row and a crash never loses one.
async function claimDue() {
  const { rows } = await pool.query(
    `UPDATE callback_outbox
        SET next_attempt_at = now() + make_interval(secs => $2::double precision)
      WHERE id IN (
        SELECT id FROM callback_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [BATCH, LEASE_SECONDS]
  );
  return rows;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const rows = await claimDue();
    await Promise.all(
      rows.map((r) => attemptDelivery(r).catch((e) => console.error('callback delivery error:', e)))
    );
  } catch (err) {
    console.error('callback worker error:', err);
  } finally {
    busy = false;
  }
}

export async function startCallbackWorker() {
  // After a restart, rows that were leased but never tried can go out straight away.
  await pool.query(
    `UPDATE callback_outbox SET next_attempt_at = now()
      WHERE status = 'pending' AND attempts = 0 AND next_attempt_at > now()`
  );
  timer = setInterval(tick, TICK_MS);
}

export function stopCallbackWorker() {
  clearInterval(timer);
}