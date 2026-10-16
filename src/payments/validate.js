// Returns an error message (string) if the body is invalid, or null if it is fine.
export function validateCreatePayment(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return 'body must be a JSON object';
  }
  if (typeof b.orderId !== 'string' || !b.orderId.trim() || b.orderId.length > 255) {
    return 'orderId is required (text, up to 255 characters)';
  }
  if (!Number.isInteger(b.amount) || b.amount <= 0) {
    return 'amount must be a positive whole number (kobo)';
  }
  if (b.currency !== 'NGN') {
    return 'currency must be NGN';
  }
  if (typeof b.customerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.customerEmail)) {
    return 'customerEmail must be a valid email';
  }
  try {
    const u = new URL(b.returnUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    return 'returnUrl must be a valid http(s) URL';
  }
  return null;
}