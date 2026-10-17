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
const { createInstrumentIdentityService } = require('./modules/instruments/instrument-identity.service');
const { createTradingRouter } = require('./modules/trading/trading.routes');
const { createAccountControlRouter } = require('./modules/trading/account-control.routes');
const { createAccountLedgerRouter } = require('./modules/accounts/account-ledger.routes');
const { createAuthRouter } = require('./modules/auth/auth.routes');
const { createIdentityRouter } = require('./modules/identity/identity.routes');
const { createAccountGrantRouter } = require('./modules/identity/account-grant.routes');
const { AccountGrantManagementService } = require('./modules/identity/account-grant-management.service');
const { IdentityService } = require('./modules/identity/identity.service');
const { PersonalDemoService } = require('./modules/identity/personal-demo.service');
const { verifyProviderEmail } = require('./modules/identity/personal-email-verifier');
const { SupabaseTokenVerifier } = require('./modules/identity/supabase-token-verifier');
const { createInternalAuthRouter } = require('./modules/auth/internal-auth.routes');
const { createOperationsRouter } = require('./modules/operations/operations.routes');
const { TraderProfileService } = require('./modules/profile/trader-profile.service');
const { createTraderProfileRouter } = require('./modules/profile/trader-profile.routes');
const { notFoundHandler, errorHandler } = require('./shared/http/error-middleware');

function createApp({ marketRuntime, tradingRuntime, authRuntime }) {
  const app = express();
  const { authService } = authRuntime;
  const personalDemoService = env.identity.personalDemoEnabled
    ? new PersonalDemoService({ accountControlService: tradingRuntime.accountControlService })
    : null;
  if (personalDemoService) {
    authService.personalDemoEnabled = true;
    authService.personalNamespaceValidator = tenantId => personalDemoService.isPersonalNamespace(tenantId);
  }
  const supabaseIdentityService = env.identity.bootstrapEnabled
    ? new IdentityService({ verifier: new SupabaseTokenVerifier({ projectRef: env.identity.supabaseProjectRef }) })
    : null;
  const identityService = createInstrumentIdentityService({
    apiKey: env.twelveData.apiKey,
    apiBase: env.twelveData.apiBase,
    timeoutMs: env.twelveData.httpTimeoutMs,
    logger,
  });

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
  app.use(express.json({ limit: '512kb' }));

  app.use('/health', createHealthRouter({ marketRuntime, tradingRuntime }));
  // Realtime valuation uses WebSocket. Keep a generous REST safety ceiling so
  // normal authenticated trading is not exhausted by users sharing a NAT IP.
  app.use('/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5000, standardHeaders: true, legacyHeaders: false }));

  app.get('/v1', (_req, res) => {
    res.json({ service: 'acg-trader-backend', apiVersion: 'v1', status: 'multi_tenant_execution_platform', market: marketRuntime.health(), trading: tradingRuntime.health() });
  });

  app.use(['/v1/auth/login', '/v1/auth/federated/exchange', '/v1/auth/personal/demo'], rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  app.use('/v1/auth', createAuthRouter(authService, {
    identityService: supabaseIdentityService,
    personalDemoService,
    verifyPersonalEmail: token => verifyProviderEmail(token, {
      identityService: supabaseIdentityService,
      projectRef: env.identity.supabaseProjectRef,
      publishableKey: env.identity.supabasePublicApiKey,
    }),
  }));
  if (env.identity.bootstrapEnabled) {
    app.use('/v1/identity/bootstrap', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
    app.use('/v1/identity', createIdentityRouter(supabaseIdentityService));
  }
  app.use('/v1/profile', createTraderProfileRouter({ authService, profileService: new TraderProfileService() }));
  app.use('/v1/internal/auth', createInternalAuthRouter(authService));
  if (env.identity.tradingSessionsEnabled) {
    app.use('/v1/internal/identity', createAccountGrantRouter({
      authService, managementService: new AccountGrantManagementService(),
    }));
  }
  app.use('/v1/instruments', createInstrumentRouter({ identityService }));
  app.use('/v1/market', createMarketRouter(marketRuntime, authService));
  app.use('/v1/internal/operations', createOperationsRouter(tradingRuntime, authService));
  app.use('/v1/internal/trading/accounts/:accountId/ledger', createAccountLedgerRouter(tradingRuntime, authService));
  app.use('/v1/internal/trading/accounts', createAccountControlRouter(tradingRuntime, authService));
  app.use('/v1/trading', createTradingRouter(tradingRuntime, authService));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
