'use strict';
const { AppError } = require('../../shared/errors/app-error');

// Independent, deliberately smaller than the candidate tool registry.
// Phase 1 has no financial execution authority, including risk-reducing writes.
// Adding a tool to the registry or an account grant cannot change this boundary.
// No configuration flag, request, model output or confirmation can enable writes.
const PHASE_ONE_READS = Object.freeze([
  'account.valuation.read',
  'account.positions.read',
  'account.orders.read',
]);
function assertPhaseOneRead(toolId) {
  if (typeof toolId !== 'string' || !PHASE_ONE_READS.includes(toolId)) {
    throw new AppError('Tool is outside the Phase 1 financial safety boundary', {
      statusCode: 403, code: 'AI_FINANCIAL_BOUNDARY_DENIED',
    });
  }
}
function assertPhaseOneGrant(toolIds) {
  if (!Array.isArray(toolIds) || toolIds.length === 0) {
    throw new AppError('Read authority is required', { statusCode: 400, code: 'AI_INVALID_READ_AUTHORITY' });
  }
  for (const toolId of toolIds) assertPhaseOneRead(toolId);
}

// Only scoped readers are handed to tool handlers. No grant management,
// runtime, execution service, HTTP client, token or caller-selected account.
function createScopedReadPort(store, scope) {
  const bound = Object.freeze({ tenantId: scope.tenantId, accountId: scope.accountId });
  const checkedLimit = limit => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 51) {
      throw new AppError('Invalid read limit', { statusCode: 400, code: 'AI_INVALID_READ_LIMIT' });
    }
    return limit;
  };
  return Object.freeze({
    positions: limit => store.positions(bound, checkedLimit(limit)),
    orders: limit => store.orders(bound, checkedLimit(limit)),
  });
}
module.exports = { PHASE_ONE_READS, assertPhaseOneRead, assertPhaseOneGrant, createScopedReadPort };
