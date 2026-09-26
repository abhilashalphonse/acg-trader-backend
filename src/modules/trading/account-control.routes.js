'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireServicePrincipal } = require('../auth/auth.middleware');
const { serializeAccount } = require('./trading.serializer');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const decimalInput = z.union([z.string().min(1), z.number().finite()]).transform(value => String(value));
const nullableDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value == null ? null : String(value));
const patchNullableDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value === undefined ? undefined : value === null ? null : String(value));
const limitRule = z.object({ limit: decimalInput, reference: z.string().trim().min(1).max(64).optional() }).strict();
const riskPolicy = z.object({ dailyLoss: limitRule.optional(), maxLoss: limitRule.optional(), profitTarget: decimalInput.optional(), breachAction: z.enum(['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK']).optional(), maxOpenPositions: z.number().int().positive().nullable().optional(), maxPositionsPerSymbol: z.number().int().positive().nullable().optional(), maxPendingOrders: z.number().int().positive().nullable().optional(), maxPendingOrdersPerSymbol: z.number().int().positive().nullable().optional(), maxPositionVolume: nullableDecimal, maxSymbolVolume: nullableDecimal, maxTotalVolume: nullableDecimal, maxRiskPerTradePercent: nullableDecimal, maxAggregateRiskPercent: nullableDecimal, maxMarginUsagePercent: nullableDecimal, maxSingleOrderMarginPercentOfFree: nullableDecimal, maxSymbolMarginPercentOfPermitted: nullableDecimal, allowedSymbols: z.array(z.string().trim().min(1).max(32)).optional() }).strict().optional();
const riskPolicyPatch = z.object({ dailyLoss: limitRule.optional(), maxLoss: limitRule.optional(), profitTarget: decimalInput.optional(), breachAction: z.enum(['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK']).optional(), maxOpenPositions: z.number().int().positive().nullable().optional(), maxPositionsPerSymbol: z.number().int().positive().nullable().optional(), maxPendingOrders: z.number().int().positive().nullable().optional(), maxPendingOrdersPerSymbol: z.number().int().positive().nullable().optional(), maxPositionVolume: patchNullableDecimal, maxSymbolVolume: patchNullableDecimal, maxTotalVolume: patchNullableDecimal, maxRiskPerTradePercent: patchNullableDecimal, maxAggregateRiskPercent: patchNullableDecimal, maxMarginUsagePercent: patchNullableDecimal, maxSingleOrderMarginPercentOfFree: patchNullableDecimal, maxSymbolMarginPercentOfPermitted: patchNullableDecimal, allowedSymbols: z.array(z.string().trim().min(1).max(32)).optional() }).strict().optional();
const metadataValue = z.union([z.string(), z.number(), z.boolean()]);
const provisionSchema = z.object({ externalRef: z.string().trim().min(1).max(256), ownerExternalRef: z.string().trim().min(1).max(256).nullable().optional(), userId: objectId.nullable().optional(), accountCode: z.string().trim().min(1).max(64).optional(), accountType: z.enum(['DEMO', 'CHALLENGE', 'FUNDED']).optional().default('CHALLENGE'), currency: z.string().trim().min(3).max(8).optional().default('USD'), leverage: z.number().int().positive().max(10000).optional().default(100), initialBalance: decimalInput, activate: z.boolean().optional().default(true), riskPolicy, riskDayKey: z.string().trim().min(1).max(32).optional(), riskTimezone: z.string().trim().min(1).max(64).optional().default('UTC'), metadata: z.record(metadataValue).optional() }).strict().superRefine((value, ctx) => { if (!value.ownerExternalRef && !value.userId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerExternalRef'], message: 'Either ownerExternalRef or userId is required' }); });
const restrictSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), cancelPending: z.boolean().optional() }).strict();
const disableSchema = restrictSchema.extend({ liquidate: z.boolean().optional() }).strict();
const breachSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), action: z.enum(['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK']).nullable().optional() }).strict();
const closeSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), liquidate: z.boolean().optional() }).strict();
const flattenSchema = z.object({ reason: z.string().trim().min(1).max(256).optional() }).strict();
const lifecycleQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).optional().default(100) }).strict();
const observabilityQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional().default(100) }).strict();
const challengeSyncSchema = z.object({
  riskPolicy: riskPolicyPatch,
  dailyStartEquity: decimalInput.optional(),
  riskDayKey: z.string().trim().min(1).max(32).optional(),
  riskTimezone: z.string().trim().min(1).max(64).optional(),
  phase: z.string().trim().min(1).max(64).nullable().optional(),
  challengeStatus: z.string().trim().min(1).max(64).nullable().optional(),
  challengeId: z.string().trim().min(1).max(256).nullable().optional(),
  payoutStatus: z.string().trim().min(1).max(64).nullable().optional(),
  riskPolicyVersion: z.string().trim().min(1).max(64).nullable().optional(),
}).strict().superRefine((value, ctx) => { if (!Object.keys(value).length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['riskPolicy'], message: 'At least one challenge field must be supplied' }); });

function createAccountControlRouter(runtime, authService) {
  const router = express.Router();
  router.use(requireEnabled(runtime));
  router.use(requireServicePrincipal(authService, 'accounts:write'));

  router.post('/provision', async (req, res) => { const result = await runtime.accountControlService.provision({ ...parse(provisionSchema, req.body), tenantId: req.servicePrincipal.tenantId }); res.status(result.idempotentReplay ? 200 : 201).json(result); });
  router.get('/:accountId', async (req, res) => { const accountId = parseId(req.params.accountId); await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId); res.json({ account: await runtime.accountControlService.getById(accountId) }); });
  router.get('/:accountId/lifecycle', async (req, res) => {
    const accountId = parseId(req.params.accountId); await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId); const { limit } = parse(lifecycleQuerySchema, req.query || {});
    const events = await runtime.accountControlService.lifecycleModel.find({ tenantId: req.servicePrincipal.tenantId, accountId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    res.json({ events: events.map(event => ({ id: String(event._id), eventId: event.eventId, type: event.type, fromStatus: event.fromStatus, toStatus: event.toStatus, tradingEnabledBefore: event.tradingEnabledBefore, tradingEnabledAfter: event.tradingEnabledAfter, reason: event.reason, actorType: event.actorType, actorRef: event.actorRef || null, metadata: event.metadata instanceof Map ? Object.fromEntries(event.metadata) : (event.metadata || {}), createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null })) });
  });

  router.get('/:accountId/admin-observability', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    const { limit } = parse(observabilityQuerySchema, req.query || {});

    const [account, openPositions, closedPositions, deals, orders, lifecycle] = await Promise.all([
      runtime.accountControlService.getById(accountId),
      runtime.tradingHistoryService.positions(accountId, { limit, status: 'OPEN' }),
      runtime.tradingHistoryService.positions(accountId, { limit, status: 'CLOSED' }),
      runtime.tradingHistoryService.deals(accountId, { limit }),
      runtime.tradingHistoryService.orders(accountId, { limit }),
      runtime.accountControlService.lifecycleModel
        .find({ tenantId: req.servicePrincipal.tenantId, accountId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean(),
    ]);

    res.json({
      account,
      openPositions,
      closedPositions,
      deals,
      orders,
      lifecycle: lifecycle.map(event => ({
        id: String(event._id),
        eventId: event.eventId,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        tradingEnabledBefore: event.tradingEnabledBefore,
        tradingEnabledAfter: event.tradingEnabledAfter,
        reason: event.reason,
        actorType: event.actorType,
        actorRef: event.actorRef || null,
        metadata: event.metadata instanceof Map ? Object.fromEntries(event.metadata) : (event.metadata || {}),
        createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null,
      })),
    });
  });

  router.patch('/:accountId/challenge', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    const patch = parse(challengeSyncSchema, req.body || {});
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    const account = await runtime.commandQueue.run(accountId, async () => {
      const doc = await runtime.accountControlService.accountModel.findOne({ _id: accountId, tenantId: req.servicePrincipal.tenantId });
      if (!doc) throw new AppError('Trading account was not found for this tenant', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
      if (patch.riskPolicy?.dailyLoss) { doc.riskPolicy.dailyLoss.limit = patch.riskPolicy.dailyLoss.limit; if (patch.riskPolicy.dailyLoss.reference) doc.riskPolicy.dailyLoss.reference = patch.riskPolicy.dailyLoss.reference; }
      if (patch.riskPolicy?.maxLoss) { doc.riskPolicy.maxLoss.limit = patch.riskPolicy.maxLoss.limit; if (patch.riskPolicy.maxLoss.reference) doc.riskPolicy.maxLoss.reference = patch.riskPolicy.maxLoss.reference; }
      for (const key of ['profitTarget','breachAction','maxOpenPositions','maxPositionsPerSymbol','maxPendingOrders','maxPendingOrdersPerSymbol','maxPositionVolume','maxSymbolVolume','maxTotalVolume','maxRiskPerTradePercent','maxAggregateRiskPercent','maxMarginUsagePercent','maxSingleOrderMarginPercentOfFree','maxSymbolMarginPercentOfPermitted','allowedSymbols']) if (patch.riskPolicy && patch.riskPolicy[key] !== undefined) doc.riskPolicy[key] = patch.riskPolicy[key];
      if (patch.dailyStartEquity !== undefined) doc.state.dailyStartEquity = patch.dailyStartEquity;
      if (patch.riskDayKey !== undefined) doc.riskDayKey = patch.riskDayKey;
      if (patch.riskTimezone !== undefined) doc.riskTimezone = patch.riskTimezone;
      const metadata = doc.metadata || new Map();
      const metadataPatch = { challengePhase: patch.phase, challengeStatus: patch.challengeStatus, challengeId: patch.challengeId, payoutStatus: patch.payoutStatus, riskPolicyVersion: patch.riskPolicyVersion };
      for (const [key, value] of Object.entries(metadataPatch)) if (value !== undefined) { if (value === null) metadata.delete(key); else metadata.set(key, String(value)); }
      doc.metadata = metadata;
      await doc.save();
      runtime.valuationEngine?.scheduleAccountRevalue?.(accountId, 'challenge-sync');
      return doc;
    });
    const serialized = serializeAccount(account);
    try { runtime.eventBus?.emit?.('trading.account.updated', serialized); } catch (_) { /* realtime snapshot will reconcile */ }
    res.json({ operation: 'CHALLENGE_SYNC', account: serialized });
  });

  router.post('/:accountId/pause', tenantCommand(runtime, 'pause', restrictSchema));
  router.post('/:accountId/stage', tenantCommand(runtime, 'stage', restrictSchema));
  router.post('/:accountId/activate', tenantCommand(runtime, 'activate', z.object({ reason: z.string().trim().min(1).max(256).optional() }).strict()));
  router.post('/:accountId/resume', tenantCommand(runtime, 'resume', z.object({ reason: z.string().trim().min(1).max(256).optional() }).strict()));
  router.post('/:accountId/disable', tenantCommand(runtime, 'disable', disableSchema));
  router.post('/:accountId/breach', tenantCommand(runtime, 'breach', breachSchema));
  router.post('/:accountId/flatten', tenantCommand(runtime, 'flatten', flattenSchema));
  router.post('/:accountId/close', async (req, res) => { const accountId = parseId(req.params.accountId); await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId); const options = parse(closeSchema, req.body || {}); res.json(await runtime.accountControlService.close(accountId, options)); });
  return router;
}

function tenantCommand(runtime, method, schema) { return async (req, res) => { const accountId = parseId(req.params.accountId); await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId); res.json(await runtime.accountControlService[method](accountId, parse(schema, req.body || {}))); }; }
async function assertTenantAccount(runtime, tenantId, accountId) { const account = await runtime.accountControlService.accountModel.findOne({ _id: accountId, tenantId }).select('_id').lean(); if (!account) throw new AppError('Trading account was not found for this tenant', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' }); }
function requireEnabled(runtime) { return (_req, _res, next) => runtime.enabled ? next() : next(new AppError('Trading API is disabled', { statusCode: 503, code: 'TRADING_API_DISABLED' })); }
function parseId(value) { const result = objectId.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function validationError(error) { return new AppError('Invalid account control command', { statusCode: 400, code: 'INVALID_ACCOUNT_CONTROL_COMMAND', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); }

module.exports = { createAccountControlRouter, provisionSchema, restrictSchema, disableSchema, breachSchema, closeSchema, flattenSchema, lifecycleQuerySchema, observabilityQuerySchema, challengeSyncSchema };
