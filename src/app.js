'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const pinoHttp = require('pino-http');

const { env } = require('./config/env');
const { logger } = require('./infrastructure/logger/logger');
const { createHealthRouter } = require('./modules/health/health.routes');
const { createMarketRouter } = require('./modules/market-data/market.routes');
const { createInstrumentRouter } = require('./modules/instruments/instrument.routes');
const { notFoundHandler, errorHandler } = require('./shared/http/error-middleware');

function createApp({ marketRuntime }) {
  const app = express();

  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : crypto.randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
  }));

  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '64kb' }));

  app.use('/health', createHealthRouter({ marketRuntime }));

  app.use('/v1', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.get('/v1', (_req, res) => {
    res.json({
      service: 'acg-trader-backend',
      apiVersion: 'v1',
      status: 'market_gateway_ready',
      market: marketRuntime.health(),
    });
  });

  app.use('/v1/instruments', createInstrumentRouter());
  app.use('/v1/market', createMarketRouter(marketRuntime));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
