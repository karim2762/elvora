// Errors that are safe to show to the client (message + optional per-field messages + optional safe details).
export class HttpError extends Error {
  constructor(status, message, { code, fields, details } = {}) {
    super(message);
    this.status = status; this.code = code; this.fields = fields; this.details = details; this.expose = true;
  }
}
export const badRequest = (message, fields) => new HttpError(400, message, { code: 'VALIDATION', fields });
export const unauthorized = (message = 'Please sign in to continue') => new HttpError(401, message, { code: 'UNAUTHENTICATED' });
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new HttpError(404, message, { code });
