'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const decimalInput = z.union([z.string().min(1), z.number().finite()]).transform(value => String(value));
const optionalDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value == null ? null : String(value));

const openSchema = z.object({
  accountId: objectId,
  clientOrderId: z.string().trim().min(1).max(128),
  symbol: z.string().trim().min(1).max(32),
  side: z.enum(['BUY', 'SELL']),
  volume: decimalInput,
  stopLoss: optionalDecimal,
  takeProfit: optionalDecimal,
  requestedPrice: optionalDecimal,
  source: z.enum(['WEB', 'MOBILE', 'API']).optional().default('API'),
}).strict();

const pendingSchema = z.object({
  accountId: objectId,
  clientOrderId: z.string().trim().min(1).max(128),
  symbol: z.string().trim().min(1).max(32),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'STOP', 'STOP_LIMIT']),
  volume: decimalInput,
  limitPrice: optionalDecimal,
  stopPrice: optionalDecimal,
  stopLoss: optionalDecimal,
  takeProfit: optionalDecimal,
  timeInForce: z.enum(['GTC', 'TODAY', 'SPECIFIED']).optional().default('GTC'),
  expiresAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional().default(null),
  source: z.enum(['WEB', 'MOBILE', 'API']).optional().default('API'),
}).strict();

const closeSchema = z.object({
  accountId: objectId,
  clientOrderId: z.string().trim().min(1).max(128),
  volume: optionalDecimal,
  requestedPrice: optionalDecimal,
  source: z.enum(['WEB', 'MOBILE', 'API']).optional().default('API'),
}).strict();

const cancelPendingSchema = z.object({
  accountId: objectId,
  clientRequestId: z.string().trim().min(1).max(128),
}).strict();

function createTradingRouter(runtime) {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json(runtime.health());
  });

  router.get('/accounts/:accountId/valuation', requireEnabled(runtime), async (req, res) => {
    const accountId = parseObjectId(req.params.accountId);
    const valuation = await runtime.valuationEngine.getOrLoadAccountSnapshot(accountId);
    if (!valuation) {
      throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
    }
    res.json(valuation);
  });

  router.get('/positions/:positionId/valuation', requireEnabled(runtime), (req, res) => {
    const positionId = parseObjectId(req.params.positionId);
    const valuation = runtime.valuationEngine.getPositionSnapshot(positionId);
    if (!valuation) {
      throw new AppError('Open position valuation was not found', { statusCode: 404, code: 'POSITION_VALUATION_NOT_FOUND' });
    }
    res.json(valuation);
  });

  router.get('/accounts/:accountId/orders/pending', requireEnabled(runtime), async (req, res) => {
    const accountId = parseObjectId(req.params.accountId);
    const orders = await runtime.pendingOrderService.listPendingOrders(accountId);
    res.json({ orders });
  });

  router.post('/orders/market', requireEnabled(runtime), async (req, res) => {
    const command = parse(openSchema, req.body);
    const result = await runtime.marketOrderService.openMarketOrder(command);
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  router.post('/orders/pending', requireEnabled(runtime), async (req, res) => {
    const command = parse(pendingSchema, req.body);
    const result = await runtime.pendingOrderService.placePendingOrder(command);
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  router.post('/orders/:orderId/cancel', requireEnabled(runtime), async (req, res) => {
    const orderId = parseObjectId(req.params.orderId);
    const body = parse(cancelPendingSchema, req.body);
    const result = await runtime.pendingOrderService.cancelPendingOrder({ ...body, orderId });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  router.post('/positions/:positionId/close', requireEnabled(runtime), async (req, res) => {
    const positionId = parseObjectId(req.params.positionId);
    const body = parse(closeSchema, req.body);
    const result = await runtime.marketOrderService.closeMarketPosition({ ...body, positionId });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  return router;
}

function requireEnabled(runtime) {
  return (_req, _res, next) => {
    if (!runtime.enabled) {
      return next(new AppError('Trading API is disabled. Enable it only in a local/development environment after configuring execution-enabled instruments.', {
        statusCode: 503,
        code: 'TRADING_API_DISABLED',
      }));
    }
    return next();
  };
}

function parseObjectId(value) {
  const result = objectId.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function validationError(error) {
  return new AppError('Invalid trading command', {
    statusCode: 400,
    code: 'INVALID_TRADING_COMMAND',
    details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

module.exports = {
  createTradingRouter,
  openSchema,
  pendingSchema,
  closeSchema,
  cancelPendingSchema,
};
