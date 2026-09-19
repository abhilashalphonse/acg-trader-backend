'use strict';

const express = require('express');
const { z } = require('zod');
const { env } = require('../../config/env');
const { AppError } = require('../../shared/errors/app-error');
const { requireTraderSession } = require('./auth.middleware');

const REFRESH_COOKIE_NAME = 'acg_trader_refresh';

const loginSchema = z.object({
  tenant: z.string().trim().min(1).max(64),
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict();
const exchangeSchema = z.object({ ticket: z.string().trim().min(16).max(512) }).strict();

function createAuthRouter(authService) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const result = await authService.loginNative(parse(loginSchema, req.body));
    issueRefreshCookie(res, result.refreshToken);
    res.json(publicAuthResponse(result));
  });

  router.post('/federated/exchange', async (req, res) => {
    const result = await authService.exchangeFederationTicket(parse(exchangeSchema, req.body).ticket);
    issueRefreshCookie(res, result.refreshToken);
    res.json(publicAuthResponse(result));
  });

  router.post('/refresh', async (req, res) => {
    requireRefreshIntent(req);
    const refreshToken = readCookie(req, REFRESH_COOKIE_NAME);
    const legacyAccessToken = optionalBearerToken(req);
    const result = await authService.refreshSession({ refreshToken, legacyAccessToken });
    issueRefreshCookie(res, result.refreshToken);
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicAuthResponse(result));
  });

  router.get('/me', requireTraderSession(authService), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ principal: req.traderPrincipal });
  });

  router.post('/logout', async (req, res) => {
    requireRefreshIntent(req);
    await authService.revokeSession({
      accessToken: optionalBearerToken(req),
      refreshToken: readCookie(req, REFRESH_COOKIE_NAME),
    });
    clearRefreshCookie(res);
    res.status(204).end();
  });

  return router;
}

function publicAuthResponse(result) {
  const { refreshToken: _refreshToken, ...publicResult } = result;
  return publicResult;
}

function requireRefreshIntent(req) {
  if (req.headers['x-acg-refresh'] !== '1') {
    throw new AppError('Refresh request marker is required', { statusCode: 403, code: 'REFRESH_REQUEST_FORBIDDEN' });
  }
}

function optionalBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const entry of raw.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key !== name) continue;
    const value = entry.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

function issueRefreshCookie(res, refreshToken) {
  if (!refreshToken) return;
  res.append('Set-Cookie', refreshCookieHeader(refreshToken, env.auth.refreshSessionTtlSeconds));
}

function clearRefreshCookie(res) {
  res.append('Set-Cookie', refreshCookieHeader('', 0));
}

function refreshCookieHeader(value, maxAgeSeconds) {
  const secure = env.isProduction;
  const attributes = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/v1/auth',
    'HttpOnly',
    `Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`,
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) {
    attributes.push('Secure');
    // Partitioned keeps the refresh cookie usable with the current
    // Firebase-hosted frontend + Railway API split while isolating it
    // to the ACG Trader top-level site in supporting browsers.
    attributes.push('Partitioned');
  }
  return attributes.join('; ');
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Invalid authentication request', {
    statusCode: 400,
    code: 'INVALID_AUTH_REQUEST',
    details: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
  });
  return result.data;
}

module.exports = {
  createAuthRouter,
  readCookie,
  refreshCookieHeader,
  publicAuthResponse,
};
