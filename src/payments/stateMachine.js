// The ONLY place that knows which status changes are allowed.
const PAYMENT = {
  pending: ['succeeded', 'expired'],
  expired: ['succeeded'],                          // a verified late transfer only
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
};

const REFUND = {
  pending: ['processed', 'failed'],
  processed: [],
  failed: [],
};

// Which statuses may a payment be in when it moves to `to`?
// Used in conditional updates:
//   UPDATE payments SET status = $to WHERE id = $id AND status = ANY($from)
// If 0 rows change, someone else got there first and we do nothing.
export const paymentFromStates = (to) =>
  Object.keys(PAYMENT).filter((from) => PAYMENT[from].includes(to));

export const refundFromStates = (to) =>
  Object.keys(REFUND).filter((from) => REFUND[from].includes(to));

export const canPaymentTransition = (from, to) => PAYMENT[from]?.includes(to) ?? false;
export const canRefundTransition = (from, to) => REFUND[from]?.includes(to) ?? false;