'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireServicePrincipal } = require('../auth/auth.middleware');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const decimalInput = z.union([z.string().min(1), z.number().finite()]).transform(value => String(value));
const metadataValue = z.union([z.string(), z.number(), z.boolean()]);

const mutationSchema = z.object({
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT']),
  amount: decimalInput,
  idempotencyKey: z.string().trim().min(1).max(128),
  referenceId: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(512),
  metadata: z.record(metadataValue).optional(),
}).strict();

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  before: z.string().datetime({ offset: true }).optional(),
}).strict();

function createAccountLedgerRouter(runtime, authService) {
  const router = express.Router({ mergeParams: true });
  router.use(requireEnabled(runtime));
  router.use(requireServicePrincipal(authService, 'accounts:write'));

  router.get('/', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    const query = parse(listSchema, req.query || {});
    const entries = await runtime.accountLedgerService.list(accountId, {
      tenantId: req.servicePrincipal.tenantId,
      limit: query.limit,
      before: query.before || null,
    });
    res.json({ entries });
  });

  router.post('/', async (req, res) => {
    const accountId = parseId(req.params.accountId);
    await assertTenantAccount(runtime, req.servicePrincipal.tenantId, accountId);
    const command = parse(mutationSchema, req.body || {});
    const result = await runtime.accountLedgerService.mutate(accountId, {
      ...command,
      tenantId: req.servicePrincipal.tenantId,
    });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  return router;
}

async function assertTenantAccount(runtime, tenantId, accountId) {
  const account = await runtime.accountControlService.accountModel
    .findOne({ _id: accountId, tenantId })
    .select('_id')
    .lean();
  if (!account) {
    throw new AppError('Trading account was not found for this tenant', {
      statusCode: 404,
      code: 'ACCOUNT_NOT_FOUND',
    });
  }
}

function requireEnabled(runtime) {
  return (_req, _res, next) => runtime.enabled
    ? next()
    : next(new AppError('Trading API is disabled', { statusCode: 503, code: 'TRADING_API_DISABLED' }));
}

function parseId(value) {
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
  return new AppError('Invalid account ledger command', {
    statusCode: 400,
    code: 'INVALID_LEDGER_COMMAND',
    details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

module.exports = { createAccountLedgerRouter, mutationSchema, listSchema };
