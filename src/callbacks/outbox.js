import { randomUUID } from 'node:crypto';

// Queue a callback for Marketly. Always call this INSIDE the same transaction as the
// state change, passing that transaction's `client`. Either both commit or neither does.
//
// `payment` is a row from the payments table.
export async function enqueueCallback(client, type, payment) {
  const id = randomUUID();
  const payload = {
    id,
    type,                                   // payment.succeeded | payment.expired | ...
    createdAt: new Date().toISOString(),
    data: {
      paymentId: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amount: payment.amount,
      amountRefunded: payment.amount_refunded,
      currency: payment.currency,
      late: payment.late,
    },
  };

  await client.query(
    `INSERT INTO callback_outbox (id, type, payload) VALUES ($1, $2, $3)`,
    [id, type, JSON.stringify(payload)]
  );
  return id;
}