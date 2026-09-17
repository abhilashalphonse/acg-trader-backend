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
const { createTradingRouter } = require('./modules/trading/trading.routes');
const { createAccountControlRouter } = require('./modules/trading/account-control.routes');
const { createAccountLedgerRouter } = require('./modules/accounts/account-ledger.routes');
const { createAuthRouter } = require('./modules/auth/auth.routes');
const { createInternalAuthRouter } = require('./modules/auth/internal-auth.routes');
const { createOperationsRouter } = require('./modules/operations/operations.routes');
const { notFoundHandler, errorHandler } = require('./shared/http/error-middleware');

function createApp({ marketRuntime, tradingRuntime, authRuntime }) {
  const app = express();
  const { authService } = authRuntime;

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

  app.use('/health', createHealthRouter({ marketRuntime, tradingRuntime }));
  app.use('/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  app.get('/v1', (_req, res) => {
    res.json({ service: 'acg-trader-backend', apiVersion: 'v1', status: 'multi_tenant_execution_platform', market: marketRuntime.health(), trading: tradingRuntime.health() });
  });

  app.use('/v1/auth', createAuthRouter(authService));
  app.use('/v1/internal/auth', createInternalAuthRouter(authService));
  app.use('/v1/instruments', createInstrumentRouter());
  app.use('/v1/market', createMarketRouter(marketRuntime));
  app.use('/v1/internal/operations', createOperationsRouter(tradingRuntime, authService));
  app.use('/v1/internal/trading/accounts/:accountId/ledger', createAccountLedgerRouter(tradingRuntime, authService));
  app.use('/v1/internal/trading/accounts', createAccountControlRouter(tradingRuntime, authService));
  app.use('/v1/trading', createTradingRouter(tradingRuntime, authService));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
