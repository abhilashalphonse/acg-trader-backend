'use strict';

const pino = require('pino');
const { env } = require('../../config/env');

const logger = pino({
  level: env.logLevel,
  base: {
    service: 'acg-trader-backend',
    environment: env.nodeEnv,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      '*.password',
      '*.token',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = { logger };
