'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireServicePrincipal } = require('../auth/auth.middleware');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const decimalInput = z.union([z.string().min(1), z.number().finite()]).transform(value => String(value));
const nullableDecimal = z.union([z.string().min(1), z.number().finite(), z.null()]).optional().transform(value => value == null ? null : String(value));
const limitRule = z.object({ limit: decimalInput, reference: z.string().trim().min(1).max(64).optional() }).strict();
const riskPolicy = z.object({ dailyLoss: limitRule.optional(), maxLoss: limitRule.optional(), profitTarget: decimalInput.optional(), breachAction: z.enum(['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK']).optional(), maxOpenPositions: z.number().int().positive().nullable().optional(), maxTotalVolume: nullableDecimal, allowedSymbols: z.array(z.string().trim().min(1).max(32)).optional() }).strict().optional();
const metadataValue = z.union([z.string(), z.number(), z.boolean()]);
const provisionSchema = z.object({
  externalRef: z.string().trim().min(1).max(256),
  ownerExternalRef: z.string().trim().min(1).max(256),
  userId: objectId.nullable().optional(),
  accountCode: z.string().trim().min(1).max(64).optional(),
  accountType: z.enum(['DEMO', 'CHALLENGE', 'FUNDED']).optional().default('CHALLENGE'),
  currency: z.string().trim().min(3).max(8).optional().default('USD'),
  leverage: z.number().int().positive().max(10000).optional().default(100),
  initialBalance: decimalInput,
  riskPolicy,
  riskDayKey: z.string().trim().min(1).max(32).optional(),
  riskTimezone: z.string().trim().min(1).max(64).optional().default('UTC'),
  metadata: z.record(metadataValue).optional(),
}).strict();
const restrictSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), cancelPending: z.boolean().optional() }).strict();
const disableSchema = restrictSchema.extend({ liquidate: z.boolean().optional() }).strict();
const breachSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), action: z.enum(['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK']).nullable().optional() }).strict();
const closeSchema = z.object({ reason: z.string().trim().min(1).max(256).optional(), liquidate: z.boolean().optional() }).strict();

function createAccountControlRouter(runtime, authService) {
  const router = express.Router();
  router.use(requireEnabled(runtime));
  router.use(requireServicePrincipal(authService, 'accounts:write'));

  router.post('/provision', async (req, res) => {
    const result = await runtime.accountControlService.provision({ ...parse(provisionSchema, req.body), tenantId: req.servicePrincipal.tenantId });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });
  router.get('/:accountId', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    res.json({ account: await runtime.accountControlService.getById(accountId) });
  });
  router.post('/:accountId/pause', tenantCommand(runtime, 'pause', restrictSchema));
  router.post('/:accountId/resume', tenantCommand(runtime, 'resume', z.object({ reason: z.string().trim().min(1).max(256).optional() }).strict()));
  router.post('/:accountId/disable', tenantCommand(runtime, 'disable', disableSchema));
  router.post('/:accountId/breach', tenantCommand(runtime, 'breach', breachSchema));
  router.post('/:accountId/close', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    const options = parse(closeSchema, req.body || {});
    res.json(await runtime.accountControlService.close(accountId, options));
  });
  return router;
}

function tenantCommand(runtime, method, schema) {
  return async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    res.json(await runtime.accountControlService[method](accountId, parse(schema, req.body || {})));
  };
}
async function assertTenantAccount(runtime, tenantId, accountId) {
  const account = await runtime.accountControlService.accountModel.findOne({ _id: accountId, tenantId }).select('_id').lean();
  if (!account) throw new AppError('Trading account was not found for this tenant', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
}
function requireEnabled(runtime) { return (_req, _res, next) => runtime.enabled ? next() : next(new AppError('Trading API is disabled', { statusCode: 503, code: 'TRADING_API_DISABLED' })); }
function parseId(value) { const result = objectId.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function validationError(error) { return new AppError('Invalid account control command', { statusCode: 400, code: 'INVALID_ACCOUNT_CONTROL_COMMAND', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); }

module.exports = { createAccountControlRouter, provisionSchema, restrictSchema, disableSchema, breachSchema, closeSchema };
