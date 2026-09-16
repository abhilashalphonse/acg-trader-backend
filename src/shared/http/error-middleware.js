'use strict';

const { AppError } = require('../errors/app-error');

function notFoundHandler(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, {
    statusCode: 404,
    code: 'ROUTE_NOT_FOUND',
  }));
}

function errorHandler(error, req, res, _next) {
  const statusCode = Number(error.statusCode) || 500;
  const code = error.code || 'INTERNAL_ERROR';
  const expose = error.expose === true || statusCode < 500;

  req.log?.[statusCode >= 500 ? 'error' : 'warn']({ err: error, code }, 'Request failed');

  res.status(statusCode).json({
    error: {
      code,
      message: expose ? error.message : 'Internal server error',
      ...(expose && error.details !== undefined ? { details: error.details } : {}),
      requestId: req.id,
    },
  });
}

module.exports = { notFoundHandler, errorHandler };
