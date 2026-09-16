'use strict';

class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details = undefined, expose = statusCode < 500 } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, AppError);
  }
}

module.exports = { AppError };
