'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const { requireServicePrincipal } = require('../auth/auth.middleware');
const { AppError } = require('../../shared/errors/app-error');
const { Deal } = require('../trading/deal.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { serializeDeal } = require('../trading/trading.serializer');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const reconcileSchema = z.object({
  accountIds: z.array(objectId).max(500).optional(),
}).strict();
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
}).strict();
const tradeListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  cursor: objectId.optional(),
  accountId: objectId.optional(),
  symbol: z.string().trim().min(1).max(32).optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  type: z.string().trim().min(1).max(32).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).strict();

function createOperationsRouter(runtime, authService) {
  const router = express.Router();
  router.use(requireEnabled(runtime));
  router.use(requireServicePrincipal(authService, 'accounts:write'));

  router.get('/health', (_req, res) => {
    res.json({
      trading: runtime.health(),
      reconciliation: runtime.reconciliationService.health(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/recovery', (_req, res) => {
    res.json({ recovery: runtime.reconciliationService.health().recovery });
  });

  router.get('/trades', async (req, res) => {
    const query = parse(tradeListSchema, req.query || {});
    const filter = { tenantId: req.servicePrincipal.tenantId };
    if (query.accountId) filter.accountId = query.accountId;
    if (query.symbol) filter.symbol = String(query.symbol).toUpperCase();
    if (query.side) filter.side = query.side;
    if (query.type) filter.type = String(query.type).toUpperCase();
    if (query.cursor) filter._id = mongoose.trusted({ $lt: query.cursor });
    if (query.from || query.to) {
      const range = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      filter.executedAt = mongoose.trusted(range);
    }

    const docs = await Deal.find(filter).sort({ _id: -1 }).limit(query.limit + 1).lean();
    const hasMore = docs.length > query.limit;
    const slice = hasMore ? docs.slice(0, query.limit) : docs;
    const accountIds = [...new Set(slice.map(item => String(item.accountId)))];
    const accounts = accountIds.length
      ? await TradingAccount.find({ tenantId: req.servicePrincipal.tenantId, _id: mongoose.trusted({ $in: accountIds }) })
        .select('_id accountCode externalRef ownerExternalRef accountType status')
        .lean()
      : [];
    const accountMap = new Map(accounts.map(item => [String(item._id), item]));

    res.json({
      items: slice.map(item => {
        const deal = serializeDeal(item);
        const account = accountMap.get(String(item.accountId));
        return {
          ...deal,
          account: account ? {
            id: String(account._id),
            accountCode: account.accountCode,
            externalRef: account.externalRef,
            ownerExternalRef: account.ownerExternalRef,
            accountType: account.accountType,
            status: account.status,
          } : null,
        };
      }),
      page: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && slice.length ? String(slice[slice.length - 1]._id) : null,
      },
    });
  });

  router.post('/reconcile', async (req, res) => {
    const body = parse(reconcileSchema, req.body || {});
    const report = await runtime.reconciliationService.run({
      tenantId: req.servicePrincipal.tenantId,
      accountIds: body.accountIds || null,
      scope: 'MANUAL',
      requestedBy: req.servicePrincipal.clientId,
    });
    res.status(report.issueCount ? 409 : 200).json({ report: serializeReport(report) });
  });

  router.get('/reconciliation', async (req, res) => {
    const { limit } = parse(listSchema, req.query || {});
    const reports = await runtime.reconciliationService.listReports({ tenantId: req.servicePrincipal.tenantId, limit });
    res.json({ reports: reports.map(serializeReport) });
  });

  return router;
}

function serializeReport(report) {
  return {
    id: report._id ? String(report._id) : null,
    reportId: report.reportId,
    scope: report.scope,
    tenantId: report.tenantId ? String(report.tenantId) : null,
    requestedBy: report.requestedBy || null,
    status: report.status,
    checkedAccounts: Number(report.checkedAccounts || 0),
    issueCount: Number(report.issueCount || 0),
    issues: (report.issues || []).map(item => ({
      code: item.code,
      severity: item.severity,
      accountId: item.accountId ? String(item.accountId) : null,
      message: item.message,
      details: item.details || {},
    })),
    recovery: report.recovery || null,
    startedAt: report.startedAt ? new Date(report.startedAt).toISOString() : null,
    completedAt: report.completedAt ? new Date(report.completedAt).toISOString() : null,
    createdAt: report.createdAt ? new Date(report.createdAt).toISOString() : null,
  };
}
function requireEnabled(runtime) {
  return (_req, _res, next) => runtime.enabled ? next() : next(new AppError('Trading API is disabled', { statusCode: 503, code: 'TRADING_API_DISABLED' }));
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Invalid operations request', {
    statusCode: 400,
    code: 'INVALID_OPERATIONS_REQUEST',
    details: result.error.issues.map(item => ({ path: item.path.join('.'), message: item.message })),
  });
  return result.data;
}

module.exports = { createOperationsRouter, serializeReport };
