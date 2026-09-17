'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { requireServicePrincipal } = require('./auth.middleware');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a MongoDB ObjectId');
const credentialSchema = z.object({
  login: z.string().trim().min(1).max(64).optional(),
  password: z.string().min(12).max(256).optional(),
  mustChangePassword: z.boolean().optional().default(false),
  rotate: z.boolean().optional().default(false),
}).strict();
const ticketSchema = z.object({
  ownerExternalRef: z.string().trim().min(1).max(256),
  accountIds: z.array(objectId).min(1).max(100),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();

function createInternalAuthRouter(authService) {
  const router = express.Router();

  router.post('/accounts/:accountId/credentials', requireServicePrincipal(authService, 'accounts:write'), async (req, res) => {
    const result = await authService.createNativeCredential({
      tenantId: req.servicePrincipal.tenantId,
      accountId: parseId(req.params.accountId),
      ...parse(credentialSchema, req.body || {}),
    });
    res.status(201).json(result);
  });

  router.post('/federation/tickets', requireServicePrincipal(authService, 'federation:write'), async (req, res) => {
    const command = parse(ticketSchema, req.body);
    const result = await authService.createFederationTicket({ tenantId: req.servicePrincipal.tenantId, ...command });
    res.status(201).json(result);
  });

  return router;
}

function parseId(value) { const result = objectId.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw validationError(result.error); return result.data; }
function validationError(error) { return new AppError('Invalid internal auth command', { statusCode: 400, code: 'INVALID_INTERNAL_AUTH_COMMAND', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); }

module.exports = { createInternalAuthRouter };
