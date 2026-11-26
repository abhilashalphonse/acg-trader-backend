'use strict';

// Stage 1A: pure, fail-closed policy for read-only tool candidates.
// This is NOT authentication, a runtime gateway, or execution authorization.
// principal and grant MUST come from trusted server-side identity/storage;
// request contains untrusted model input. No tool is dispatched here.
const READ_TOOLS = Object.freeze([
  'market.quote.read',
  'market.candles.read',
  'account.valuation.read',
  'account.positions.read',
  'account.orders.read',
  'account.policy.read',
]);
const CHANNELS = Object.freeze(['NATIVE', 'EXTERNAL', 'AGENT']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const identifier = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim();
const integerTime = v => Number.isSafeInteger(v) && v >= 0;
const deny = code => ({ allowed: false, code });

function evaluateReadToolPolicy({ enabled, principal, grant, request, nowMs } = {}) {
  if (enabled !== true) return deny('AI_DISABLED');
  if (!integerTime(nowMs)) return deny('INVALID_CLOCK');
  if (!principal || !grant || !request) return deny('MISSING_CONTEXT');
  const bindings = ['tenantId', 'actorId', 'connectionId', 'accountId'];
  for (const key of bindings) {
    if (!own(principal, key) || !own(grant, key) ||
        !identifier(principal[key]) || principal[key] !== grant[key]) {
      return deny('SCOPE_MISMATCH');
    }
  }
  if (!CHANNELS.includes(principal.channel) || principal.channel !== grant.channel) {
    return deny('CHANNEL_MISMATCH');
  }
  if (grant.status !== 'ACTIVE' || !integerTime(grant.notBeforeMs) ||
      !integerTime(grant.expiresAtMs) || grant.notBeforeMs >= grant.expiresAtMs ||
      nowMs < grant.notBeforeMs || nowMs >= grant.expiresAtMs) {
    return deny('GRANT_INACTIVE');
  }
  if (!own(request, 'accountId') || request.accountId !== principal.accountId) {
    return deny('ACCOUNT_MISMATCH');
  }
  if (!own(request, 'toolId') || !READ_TOOLS.includes(request.toolId)) {
    return deny('TOOL_NOT_AVAILABLE');
  }
  if (!Array.isArray(grant.toolIds) ||
      !grant.toolIds.every(id => READ_TOOLS.includes(id)) ||
      !grant.toolIds.includes(request.toolId)) {
    return deny('TOOL_NOT_GRANTED');
  }
  // A positive result means only that this policy permits the read candidate.
  // A future dispatcher MUST separately authenticate, resolve current account
  // grants, validate tool arguments, enforce data entitlements and audit.
  return { allowed: true, code: 'READ_CANDIDATE_ALLOWED' };
}

module.exports = { READ_TOOLS, evaluateReadToolPolicy };
