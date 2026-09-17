'use strict';

const { AppError } = require('../../shared/errors/app-error');

function requireTraderSession(authService) {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req);
      req.traderPrincipal = await authService.authenticateSessionToken(token);
      next();
    } catch (error) { next(error); }
  };
}

function requireServicePrincipal(authService, requiredScope = null) {
  return async (req, _res, next) => {
    try {
      const apiKey = bearerToken(req);
      const clientId = req.headers['x-acg-client-id'];
      if (typeof clientId !== 'string' || !clientId.trim()) throw new AppError('x-acg-client-id is required', { statusCode: 401, code: 'SERVICE_CLIENT_ID_REQUIRED' });
      req.servicePrincipal = await authService.authenticateServiceKey({ clientId, apiKey, requiredScope });
      next();
    } catch (error) { next(error); }
  };
}

function requireAccountGrant(principal, accountId) {
  const target = String(accountId);
  if (!principal?.accountIds?.includes(target)) {
    throw new AppError('Trading session does not grant access to this account', { statusCode: 403, code: 'ACCOUNT_ACCESS_FORBIDDEN' });
  }
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new AppError('Bearer token is required', { statusCode: 401, code: 'AUTH_TOKEN_REQUIRED' });
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new AppError('Bearer token is required', { statusCode: 401, code: 'AUTH_TOKEN_REQUIRED' });
  return match[1].trim();
}

module.exports = { requireTraderSession, requireServicePrincipal, requireAccountGrant, bearerToken };
