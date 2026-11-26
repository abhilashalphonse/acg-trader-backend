'use strict';
const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { requireAccountGrant } = require('../auth/auth.middleware');
const { evaluateReadToolPolicy } = require('./read-tool-policy');
const { AVAILABLE_READ_TOOLS, resolveReadTool } = require('./read-tool-registry');
const objectId = v => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
const fail = (code, statusCode = 403) => new AppError('AI request denied', { code, statusCode });
const { assertPhaseOneRead, assertPhaseOneGrant, createScopedReadPort } = require('./financial-safety-boundary');
const MAX_GRANT_MS = 60 * 60 * 1000;
function scopeFor(principal, accountId, nowMs, requireGrant = true) {
  if (principal?.authMethod !== 'SUPABASE' || ![principal.tenantId,principal.userId,principal.sessionId,accountId].every(objectId) ||
      !Number.isSafeInteger(nowMs) || !(Date.parse(principal.expiresAt) > nowMs) ||
      !(Date.parse(principal.refreshExpiresAt) > nowMs) || !(Date.parse(principal.idleExpiresAt) > nowMs)) throw fail('AI_IDENTITY_UNAVAILABLE');
  if (requireGrant) requireAccountGrant(principal, accountId);
  return { tenantId: principal.tenantId, actorId: principal.userId, sessionId: principal.sessionId, accountId, channel: 'NATIVE' };
}
function grantKey(s) {
  return crypto.createHash('sha256').update(JSON.stringify([s.tenantId,s.actorId,s.sessionId,s.accountId])).digest('hex');
}
function safeGrant(g) { return { connectionId: g.connectionId, accountId: g.accountId, toolIds: g.toolIds,
  status: g.status, expiresAtMs: g.expiresAtMs }; }

function createAiReadGateway({ store, enabled, now = Date.now }) {
  function assertEnabled() { if (enabled() !== true) throw fail('AI_DISABLED', 503); }
  async function liveScope(principal, accountId) {
    assertEnabled();
    const scope = scopeFor(principal, accountId, now());
    const account = await store.account(scope, now());
    if (!account) throw fail('AI_ACCOUNT_FORBIDDEN');
    return { scope, account };
  }
  function checkGrant(scope, grant, request) {
    if (!grant || grant.sessionId !== scope.sessionId || grant.connectionId !== request.connectionId || grant.revokedAt) throw fail('AI_GRANT_INACTIVE');
    const decision = evaluateReadToolPolicy({ enabled: enabled(), principal: { ...scope, connectionId: request.connectionId },
      grant, request, nowMs: now() });
    if (!decision.allowed) throw fail(decision.code);
  }
  async function assertDisclosure(principal,request) {
    assertPhaseOneRead(request?.toolId);
    const { scope }=await liveScope(principal,request.accountId);
    const grant=await store.getGrant(grantKey(scope));
    checkGrant(scope,grant,request);
    assertPhaseOneGrant(grant.toolIds);
  }
  return Object.freeze({
    assertDisclosure,
    async create(principal, { accountId, toolIds }) {
      const { scope } = await liveScope(principal, accountId);
      if (!Array.isArray(toolIds) || !toolIds.length || new Set(toolIds).size !== toolIds.length ||
          !toolIds.every(t => AVAILABLE_READ_TOOLS.includes(t))) throw fail('AI_TOOL_NOT_AVAILABLE', 400);
      assertPhaseOneGrant(toolIds);
      const start = now();
      const expiresAtMs = Math.min(start + MAX_GRANT_MS, Date.parse(principal.refreshExpiresAt));
      if (expiresAtMs <= start) throw fail('AI_IDENTITY_UNAVAILABLE');
      const doc = { _id: grantKey(scope), ...scope, connectionId: crypto.randomUUID(), toolIds,
        notBeforeMs: start, expiresAtMs, status: 'ACTIVE', revokedAt: null };
      // One immutable authority generation per authenticated session/account.
      // Revoked/expired grants cannot be silently recreated using the same session.
      if (!await store.createGrant(doc)) throw fail('AI_GRANT_ALREADY_EXISTS', 409);
      return safeGrant(doc);
    },
    async get(principal, accountId) {
      const { scope } = await liveScope(principal, accountId);
      const grant = await store.getGrant(grantKey(scope));
      return grant ? safeGrant(grant) : null;
    },
    async revoke(principal, { accountId, connectionId }) {
      assertEnabled();
      // Revocation remains possible even after underlying account access is removed.
      const scope = scopeFor(principal, accountId, now(), false);
      return { revoked: await store.revokeGrant(grantKey(scope), connectionId) };
    },
    async invoke(principal, request, reauthenticate) {
      assertEnabled();
      assertPhaseOneRead(request?.toolId);
      const { scope, account } = await liveScope(principal, request.accountId);
      const key = grantKey(scope);
      const grant = await store.getGrant(key);
      checkGrant(scope, grant, request);
      assertPhaseOneGrant(grant.toolIds);
      const tool = resolveReadTool(request.toolId, request.args);
      const result = await tool.run({ account, args: tool.args, reads: createScopedReadPort(store, scope) });
      // Re-resolve session, current account access and grant before disclosure.
      // Already disclosed data cannot be recalled; a final in-flight race is possible.
      const fresh = await reauthenticate();
      const { scope: freshScope } = await liveScope(fresh, request.accountId);
      if (grantKey(freshScope) !== key) throw fail('AI_SCOPE_CHANGED');
      const freshGrant = await store.getGrant(key);
      checkGrant(freshScope, freshGrant, request);
      assertPhaseOneGrant(freshGrant.toolIds);
      return { toolId: request.toolId, accountId: scope.accountId, retrievedAt: new Date(now()).toISOString(), result };
    },
  });
}
module.exports = { createAiReadGateway, scopeFor, grantKey };
