import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export const hashBody = (body) =>
  crypto.createHash('sha256').update(stable(body)).digest('hex');


export async function claimKey(client, scope, key, requestHash) {
  const ins = await client.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash)
     VALUES ($1, $2, $3) ON CONFLICT (scope, key) DO NOTHING`,
    [scope, key, requestHash]
  );
  if (ins.rowCount === 1) return { state: 'claimed' };

  const { rows } = await client.query(
    `SELECT request_hash, response_status, response_body, resource_id
       FROM idempotency_keys WHERE scope = $1 AND key = $2`,
    [scope, key]
  );
  const row = rows[0];
  if (!row) return claimKey(client, scope, key, requestHash); // deleted in between: try again
  if (row.request_hash !== requestHash) return { state: 'mismatch' };
  if (row.response_status == null) return { state: 'in_flight', resourceId: row.resource_id };
  return { state: 'replay', status: row.response_status, body: row.response_body };
}

// Store the final response so repeats can be answered from it.
export async function saveResponse(client, scope, key, status, body) {
  await client.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4
      WHERE scope = $1 AND key = $2`,
    [scope, key, status, JSON.stringify(body)]
  );
}

// Another request with the same key is still working. Wait for its answer.
export async function waitForResponse(scope, key, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT response_status, response_body FROM idempotency_keys
        WHERE scope = $1 AND key = $2`,
      [scope, key]
    );
    if (rows[0]?.response_status != null) {
      return { status: rows[0].response_status, body: rows[0].response_body };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}