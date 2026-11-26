'use strict';
const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { requireTraderSession, bearerToken } = require('../auth/auth.middleware');
const { AppError } = require('../../shared/errors/app-error');
const { AVAILABLE_READ_TOOLS } = require('./read-tool-registry');
const { assertPhaseOneRead, assertPhaseOneGrant } = require('./financial-safety-boundary');
const { aiSafeError, createConcurrencyGate } = require('./ai-http-security');
const accountId = z.string().regex(/^[a-f0-9]{24}$/);
const connectionId = z.uuid();
const createSchema = z.object({ accountId, toolIds: z.array(z.enum(AVAILABLE_READ_TOOLS)).min(1).max(AVAILABLE_READ_TOOLS.length) }).strict();
const revokeSchema = z.object({ accountId, connectionId }).strict();
const invokeSchema = z.object({ accountId, connectionId, toolId: z.string().min(1).max(80), args: z.record(z.string(), z.unknown()) }).strict();
function parse(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AppError('Invalid AI request', { code: 'AI_INVALID_REQUEST', statusCode: 400 });
  return parsed.data;
}
function createAiReadRouter({ authService, gateway, governance, quota }) {
  if (typeof governance?.run !== 'function') throw new Error('AI governance is required');
  if (typeof quota?.consume !== 'function') throw new Error('AI quota is required');
  const run = createConcurrencyGate(12);
  const revokeRun = createConcurrencyGate(2);
  const router = express.Router();
  router.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
  router.use(requireTraderSession(authService));
  router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false,
    skip: req => req.method === 'POST' && req.path === '/grants/revoke',
    keyGenerator: req => 'ai:' + req.traderPrincipal.sessionId }));
  router.post('/grants/revoke', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => 'ai-revoke:' + req.traderPrincipal.sessionId }), (_req,_res,next)=>next());
  // Audit known authenticated operations, including schema and boundary denials.
  // Authentication/rate-limit failures are handled by the existing HTTP layer.
  const audited = (operation, work, successStatus = 200) => async (req,res) => {
    const revoke = operation === 'GRANT_REVOKE';
    const result = await (revoke ? revokeRun : run)(async () => {
      if (!revoke) await quota.consume(req.traderPrincipal);
      return governance.run({
      principal: req.traderPrincipal, operation,
      requestedAccountId: req.params.accountId ?? req.body?.accountId,
      toolId: req.body?.toolId,
      }, () => work(req));
    });
    res.status(successStatus).json(result);
  };
  router.get('/tools', audited('DISCOVER', () => ({ tools: AVAILABLE_READ_TOOLS, channel: 'NATIVE', readOnly: true })));
  router.get('/grants/:accountId', audited('GRANT_GET', async req => ({ grant: await gateway.get(req.traderPrincipal, parse(accountId,req.params.accountId)) })));
  router.post('/grants', audited('GRANT_CREATE', async req => {
    const request = parse(createSchema,req.body);
    assertPhaseOneGrant(request.toolIds);
    return { grant: await gateway.create(req.traderPrincipal,request) };
  },201));
  router.post('/grants/revoke', audited('GRANT_REVOKE', req => gateway.revoke(req.traderPrincipal,parse(revokeSchema,req.body))));
  router.post('/invoke', audited('TOOL_INVOKE', async req => {
    const request = parse(invokeSchema,req.body);
    assertPhaseOneRead(request.toolId);
    return gateway.invoke(req.traderPrincipal,request,() => authService.authenticateSessionToken(bearerToken(req)));
  }));
  router.use(aiSafeError);
  return router;
}
module.exports = { createAiReadRouter };
