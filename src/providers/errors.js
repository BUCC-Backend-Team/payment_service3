
export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.code = code;          // 'network_error' | 'provider_5xx' | 'duplicate_reference' | 'rejected'
    this.retryable = retryable;
    this.status = status;      // HTTP status from Paystack, when there was one
  }
}