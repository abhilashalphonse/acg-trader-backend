'use strict';
const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { PHASE_ONE_READS } = require('./financial-safety-boundary');
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : null;
const unavailable = () => new AppError('AI governance is unavailable', { statusCode: 503, code: 'AI_GOVERNANCE_UNAVAILABLE' });
const paused = () => new AppError('AI access is suspended', { statusCode: 403, code: 'AI_GOVERNANCE_PAUSED' });
const operations = new Set(['DISCOVER','GRANT_GET','GRANT_CREATE','GRANT_REVOKE','TOOL_INVOKE']);
const reasons = new Set(['AI_DISABLED','AI_IDENTITY_UNAVAILABLE','AI_ACCOUNT_FORBIDDEN','ACCOUNT_ACCESS_FORBIDDEN',
  'AI_GRANT_INACTIVE','AI_TOOL_NOT_AVAILABLE','AI_GRANT_ALREADY_EXISTS','AI_SCOPE_CHANGED','AI_INVALID_REQUEST',
  'AI_INVALID_TOOL_ARGUMENTS','AI_FINANCIAL_BOUNDARY_DENIED','AI_INVALID_READ_AUTHORITY','AI_INVALID_READ_LIMIT',
  'GRANT_INACTIVE','SCOPE_MISMATCH','CHANNEL_MISMATCH','ACCOUNT_MISMATCH','TOOL_NOT_GRANTED','TOOL_NOT_AVAILABLE',
  'AI_GOVERNANCE_PAUSED','AI_GOVERNANCE_CHANGED','AI_GOVERNANCE_UNAVAILABLE','AUTH_TOKEN_REQUIRED']);
function safeReason(error) {
  return reasons.has(error?.code) ? error.code : 'UNCLASSIFIED_ERROR';
}
function createAiGovernance({ store, logger, now = Date.now }) {
  async function control(tenantId) {
    try {
      const result = await store.control(tenantId);
      if (!result || typeof result.enabled !== 'boolean' || !Number.isSafeInteger(result.revision) ||
          result.revision < 0 || (result.enabled && result.revision === 0)) throw unavailable();
      return result;
    } catch { throw unavailable(); }
  }
  async function assertCurrent(tenantId, revision = null) {
    const value = await control(tenantId);
    if (!value.enabled) throw paused();
    if (revision !== null && revision !== value.revision) throw new AppError('AI governance changed during request', {
      statusCode: 409, code: 'AI_GOVERNANCE_CHANGED',
    });
    return value.revision;
  }
  async function record(event) {
    try { await store.append(event); }
    catch {
      logger?.error?.({ operation: event.operation, stage: event.stage }, 'AI audit append unavailable');
      throw unavailable();
    }
  }
  return Object.freeze({
    async run({ principal, operation, requestedAccountId, toolId }, work) {
      const tenantId = id(principal?.tenantId);
      if (!tenantId || !operations.has(operation)) throw unavailable();
      const trace = crypto.randomUUID();
      const base = { tenantId, actorId: id(principal.userId), sessionId: id(principal.sessionId),
        requestedAccountId: id(requestedAccountId), operation, toolId: PHASE_ONE_READS.includes(toolId) ? toolId : null };
      const event = (suffix, stage, extra = {}) => ({ ...base, _id: trace + ':' + suffix, stage,
        occurredAt: new Date(now()), ...extra });
      // Revocation is a safety operation: permit it even during pause or audit failure.
      // Do not permit any reads or permission creation on this exception.
      const revocation = operation === 'GRANT_REVOKE';
      async function append(e) {
        try { await record(e); } catch (error) { if (!revocation) throw error; }
      }
      await append(event('start','ATTEMPT'));
      let value, revision = null;
      try {
        if (!revocation) revision = await assertCurrent(tenantId);
        value = await work();
        if (!revocation) await assertCurrent(tenantId, revision);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        await append(event('end',status >= 400 && status < 500 ? 'DENIED' : 'FAILED',{ reason:safeReason(error), revision }));
        throw error;
      }
      await append(event('end','ALLOWED',{ revision }));
      // An ALLOWED event records the completed operation, not delivery to the client.
      if (!revocation) {
        try { await assertCurrent(tenantId, revision); }
        catch (error) {
          await record(event('suppressed','SUPPRESSED',{ reason:safeReason(error), revision }));
          throw error;
        }
      }
      return value;
    },
  });
}
module.exports = { createAiGovernance };
