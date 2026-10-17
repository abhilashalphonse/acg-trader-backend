'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireServicePrincipal } = require('../auth/auth.middleware');

const idPattern = /^[0-9a-f]{24}$/i;
const paramsSchema = z.object({ accountId: z.string().regex(idPattern), userId: z.string().regex(idPattern) }).strict();
const payloadSchema = z.object({
  permissions: z.array(z.enum(['VIEW', 'TRADE', 'MANAGE'])).min(1).max(3)
    .refine(items => new Set(items).size === items.length, 'Duplicate permissions are not allowed'),
}).strict();

function createAccountGrantRouter({ authService, managementService }) {
  const router = express.Router();
  router.use(requireServicePrincipal(authService, 'accounts:write'));
  router.put('/accounts/:accountId/access/:userId', async (req, res) => {
    const params = parse(paramsSchema, req.params);
    const { permissions } = parse(payloadSchema, req.body);
    const result = await managementService.grant({
      ...params, permissions, tenantId: String(req.servicePrincipal.tenantId),
      clientId: req.servicePrincipal.clientId,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });
  router.delete('/accounts/:accountId/access/:userId', async (req, res) => {
    const params = parse(paramsSchema, req.params);
    const result = await managementService.revoke({
      ...params, tenantId: String(req.servicePrincipal.tenantId),
      clientId: req.servicePrincipal.clientId,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });
  return router;
}

function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new AppError('Invalid account grant request', { statusCode: 400, code: 'INVALID_ACCOUNT_GRANT_REQUEST' });
}

module.exports = { createAccountGrantRouter };
