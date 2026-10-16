// Throw this anywhere; the error handler in app.js turns it into a JSON response.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}