'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireTraderSession, bearerToken } = require('./auth.middleware');

const loginSchema = z.object({
  tenant: z.string().trim().min(1).max(64),
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict();
const exchangeSchema = z.object({ ticket: z.string().trim().min(16).max(512) }).strict();

function createAuthRouter(authService) {
  const router = express.Router();
  router.post('/login', async (req, res) => res.json(await authService.loginNative(parse(loginSchema, req.body))));
  router.post('/federated/exchange', async (req, res) => res.json(await authService.exchangeFederationTicket(parse(exchangeSchema, req.body).ticket)));
  router.get('/me', requireTraderSession(authService), (req, res) => res.json({ principal: req.traderPrincipal }));
  router.post('/logout', requireTraderSession(authService), async (req, res) => {
    await authService.revokeSession(bearerToken(req));
    res.status(204).end();
  });
  return router;
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Invalid authentication request', { statusCode: 400, code: 'INVALID_AUTH_REQUEST', details: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  return result.data;
}

module.exports = { createAuthRouter };
