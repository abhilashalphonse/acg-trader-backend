'use strict';
const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { requireTraderSession, bearerToken } = require('../auth/auth.middleware');
const { AppError } = require('../../shared/errors/app-error');
const { AVAILABLE_READ_TOOLS } = require('./read-tool-registry');
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
function createAiReadRouter({ authService, gateway }) {
  const router = express.Router();
  router.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
  router.use(requireTraderSession(authService));
  router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => 'ai:' + req.traderPrincipal.sessionId }));
  router.get('/tools', (_req,res) => res.json({ tools: AVAILABLE_READ_TOOLS, channel: 'NATIVE', readOnly: true }));
  router.get('/grants/:accountId', async(req,res) => res.json({ grant: await gateway.get(req.traderPrincipal, parse(accountId,req.params.accountId)) }));
  router.post('/grants', async(req,res) => res.status(201).json({ grant: await gateway.create(req.traderPrincipal,parse(createSchema,req.body)) }));
  router.post('/grants/revoke', async(req,res) => res.json(await gateway.revoke(req.traderPrincipal,parse(revokeSchema,req.body))));
  router.post('/invoke', async(req,res) => res.json(await gateway.invoke(req.traderPrincipal,parse(invokeSchema,req.body),
    () => authService.authenticateSessionToken(bearerToken(req)))));
  return router;
}
module.exports = { createAiReadRouter };
