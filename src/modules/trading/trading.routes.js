'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireTraderSession, requireAccountGrant } = require('../auth/auth.middleware');
const { Order } = require('./order.model');
const { Position } = require('./position.model');
const {
  marketExecutionTimingMiddleware,
  setExecutionContext,
  timeAsync,
} = require('../../shared/observability/execution-timing');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const decimalInput = z.union([z.string().min(1), z.number().finite()]).transform(value => String(value));
const optionalDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value == null ? null : String(value));
const patchDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value === undefined ? undefined : value === null ? null : String(value));
const source = z.enum(['WEB', 'MOBILE', 'API']).optional().default('API');

const openSchema = z.object({ accountId: objectId, clientOrderId: z.string().trim().min(1).max(128), symbol: z.string().trim().min(1).max(32), side: z.enum(['BUY', 'SELL']), volume: decimalInput, stopLoss: optionalDecimal, takeProfit: optionalDecimal, requestedPrice: optionalDecimal, source }).strict();
const pendingSchema = z.object({ accountId: objectId, clientOrderId: z.string().trim().min(1).max(128), symbol: z.string().trim().min(1).max(32), side: z.enum(['BUY', 'SELL']), type: z.enum(['LIMIT', 'STOP', 'STOP_LIMIT']), volume: decimalInput, limitPrice: optionalDecimal, stopPrice: optionalDecimal, stopLoss: optionalDecimal, takeProfit: optionalDecimal, timeInForce: z.enum(['GTC', 'TODAY', 'SPECIFIED']).optional().default('GTC'), expiresAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional().default(null), source }).strict();
const amendPendingSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), volume: patchDecimal, limitPrice: patchDecimal, stopPrice: patchDecimal, stopLoss: patchDecimal, takeProfit: patchDecimal, timeInForce: z.enum(['GTC', 'TODAY', 'SPECIFIED']).optional(), expiresAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional() }).strict().superRefine((value, ctx) => { if (!['volume','limitPrice','stopPrice','stopLoss','takeProfit','timeInForce','expiresAt'].some(key => value[key] !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['volume'], message: 'At least one pending-order field must be supplied' }); });
const closeSchema = z.object({ accountId: objectId, clientOrderId: z.string().trim().min(1).max(128), volume: optionalDecimal, requestedPrice: optionalDecimal, source }).strict();
const cancelPendingSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128) }).strict();
const protectionSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), stopLoss: patchDecimal, takeProfit: patchDecimal, source }).strict().superRefine((value, ctx) => { if (value.stopLoss === undefined && value.takeProfit === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopLoss'], message: 'At least one of stopLoss or takeProfit must be supplied' }); });
const breakEvenSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), source }).strict();
const trailingSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), enabled: z.boolean(), distancePoints: z.union([z.string().min(1), z.number().finite(), z.null()]).optional().default(null).transform(value => value == null ? null : String(value)), source }).strict().superRefine((value, ctx) => { if (value.enabled && value.distancePoints == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['distancePoints'], message: 'distancePoints is required when trailing is enabled' }); });
const reverseSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), stopLoss: optionalDecimal, takeProfit: optionalDecimal, requestedPrice: optionalDecimal, source }).strict();
const closeAllSchema = z.object({ accountId: objectId, clientRequestId: z.string().trim().min(1).max(128), source }).strict();
const historyQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional().default(50), cursor: objectId.optional(), symbol: z.string().trim().min(1).max(32).optional(), status: z.string().trim().min(1).max(32).optional(), side: z.enum(['BUY','SELL']).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).strict();

function createTradingRouter(runtime, authService) {
  const router = express.Router();
  router.get('/status', (_req, res) => res.json(runtime.health()));
  router.use(requireEnabled(runtime));
  router.use(marketExecutionTimingMiddleware());
  router.use(requireTraderSession(authService));
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
    keyGenerator: req => `session:${req.traderPrincipal.sessionId}`,
  }));

  router.get('/accounts/:accountId/valuation', async (req, res) => { const accountId = parseObjectId(req.params.accountId); requireAccountGrant(req.traderPrincipal, accountId); const valuation = await runtime.valuationEngine.getOrLoadAccountSnapshot(accountId); if (!valuation) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' }); res.json(valuation); });
  router.get('/positions/:positionId/valuation', async (req, res) => { const positionId = parseObjectId(req.params.positionId); const accountId = await positionAccountId(positionId); requireAccountGrant(req.traderPrincipal, accountId); const valuation = runtime.valuationEngine.getPositionSnapshot(positionId); if (!valuation) throw new AppError('Open position valuation was not found', { statusCode: 404, code: 'POSITION_VALUATION_NOT_FOUND' }); res.json(valuation); });
  router.get('/accounts/:accountId/orders/pending', async (req, res) => { const accountId = parseObjectId(req.params.accountId); requireAccountGrant(req.traderPrincipal, accountId); res.json({ orders: await runtime.pendingOrderService.listPendingOrders(accountId) }); });

  router.get('/accounts/:accountId/history/orders', historyHandler(runtime, 'orders'));
  router.get('/accounts/:accountId/history/deals', historyHandler(runtime, 'deals'));
  router.get('/accounts/:accountId/history/positions', historyHandler(runtime, 'positions'));

  router.post('/orders/market', async (req, res) => {
    const command = parse(openSchema, req.body);
    requireAccountGrant(req.traderPrincipal, command.accountId);
    setExecutionContext(req.executionTiming, {
      accountId: command.accountId,
      symbol: command.symbol,
      clientOrderId: command.clientOrderId,
    });
    const result = await runtime.marketOrderService.openMarketOrder(command, {
      timing: req.executionTiming,
      requestId: req.id,
      tenantId: req.traderPrincipal?.tenantId || null,
    });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });
  router.post('/orders/pending', async (req, res) => { const command = parse(pendingSchema, req.body); requireAccountGrant(req.traderPrincipal, command.accountId); const result = await runtime.pendingOrderService.placePendingOrder(command); res.status(result.idempotentReplay ? 200 : 201).json(result); });
  router.patch('/orders/:orderId', async (req, res) => { const orderId = parseObjectId(req.params.orderId); const command = parse(amendPendingSchema, req.body); const accountId = await orderAccountId(orderId); assertResourceAccount(accountId, command.accountId, 'ORDER_ACCOUNT_MISMATCH'); requireAccountGrant(req.traderPrincipal, accountId); res.json(await runtime.pendingOrderAmendService.amend({ ...command, orderId })); });
  router.post('/orders/:orderId/cancel', async (req, res) => { const orderId = parseObjectId(req.params.orderId); const command = parse(cancelPendingSchema, req.body); const accountId = await orderAccountId(orderId); assertResourceAccount(accountId, command.accountId, 'ORDER_ACCOUNT_MISMATCH'); requireAccountGrant(req.traderPrincipal, accountId); const result = await runtime.pendingOrderService.cancelPendingOrder({ ...command, orderId }); res.status(result.idempotentReplay ? 200 : 201).json(result); });
  router.post('/accounts/:accountId/positions/close-all', async (req, res) => { const accountId = parseObjectId(req.params.accountId); const command = parse(closeAllSchema, req.body); assertResourceAccount(accountId, command.accountId, 'ACCOUNT_MISMATCH'); requireAccountGrant(req.traderPrincipal, accountId); const result = await runtime.tradingCommandService.closeAllPositions(command); res.status(result.complete ? 200 : 207).json(result); });
  router.post('/positions/:positionId/reverse', async (req, res) => { const positionId = parseObjectId(req.params.positionId); const command = parse(reverseSchema, req.body); const accountId = await positionAccountId(positionId); assertResourceAccount(accountId, command.accountId, 'POSITION_ACCOUNT_MISMATCH'); requireAccountGrant(req.traderPrincipal, accountId); const result = await runtime.tradingCommandService.reversePosition({ ...command, positionId }); res.status(result.idempotentReplay ? 200 : 201).json(result); });

  router.patch('/positions/:positionId/protection', positionCommand(positionProtectionCommand(runtime, 'updateProtection'), protectionSchema));
  router.post('/positions/:positionId/break-even', positionCommand(positionProtectionCommand(runtime, 'moveStopToBreakEven'), breakEvenSchema));
  router.patch('/positions/:positionId/trailing', positionCommand(async command => runtime.trailingStopService.configure(command), trailingSchema));
  router.post('/positions/:positionId/close', positionCommand(
    async (command, context) => runtime.marketOrderService.closeMarketPosition(command, context),
    closeSchema,
    true,
  ));

  function historyHandlerFactory(method) { return async (req, res) => { const accountId = parseObjectId(req.params.accountId); requireAccountGrant(req.traderPrincipal, accountId); res.json(await runtime.tradingHistoryService[method](accountId, parse(historyQuerySchema, req.query || {}))); }; }
  function positionCommand(executor, schema, createdResponse = false) {
    return async (req, res) => {
      const positionId = parseObjectId(req.params.positionId);
      const command = parse(schema, req.body);
      const accountId = await timeAsync(req.executionTiming, 'resource_auth_read', () => positionAccountId(positionId));
      assertResourceAccount(accountId, command.accountId, 'POSITION_ACCOUNT_MISMATCH');
      requireAccountGrant(req.traderPrincipal, accountId);
      setExecutionContext(req.executionTiming, {
        accountId,
        positionId,
        clientOrderId: command.clientOrderId || command.clientRequestId,
      });
      const result = await executor(
        { ...command, positionId },
        {
          timing: req.executionTiming,
          requestId: req.id,
          tenantId: req.traderPrincipal?.tenantId || null,
        },
      );
      res.status(createdResponse && !result.idempotentReplay ? 201 : 200).json(result);
    };
  }
  function historyHandler(_runtime, method) { return historyHandlerFactory(method); }
  return router;
}

function positionProtectionCommand(runtime, method) { return command => runtime.positionProtectionService[method](command); }
async function orderAccountId(orderId) { const order = await Order.findById(orderId).select('accountId').lean(); if (!order) throw new AppError('Order was not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' }); return String(order.accountId); }
async function positionAccountId(positionId) { const position = await Position.findById(positionId).select('accountId').lean(); if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' }); return String(position.accountId); }
function assertResourceAccount(actual, requested, code) { if (String(actual) !== String(requested)) throw new AppError('Resource does not belong to this trading account', { statusCode: 403, code }); }
function requireEnabled(runtime) { return (_req, _res, next) => runtime.enabled ? next() : next(new AppError('Trading API is disabled', { statusCode: 503, code: 'TRADING_API_DISABLED' })); }
function parseObjectId(value) { const result = objectId.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function validationError(error) { return new AppError('Invalid trading command', { statusCode: 400, code: 'INVALID_TRADING_COMMAND', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); }

module.exports = { createTradingRouter, openSchema, pendingSchema, amendPendingSchema, closeSchema, cancelPendingSchema, protectionSchema, breakEvenSchema, trailingSchema, reverseSchema, closeAllSchema, historyQuerySchema };
