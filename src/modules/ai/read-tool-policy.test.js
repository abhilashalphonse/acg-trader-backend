'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { READ_TOOLS, evaluateReadToolPolicy } = require('./read-tool-policy');

function fixture() {
  const principal = { tenantId: 't1', actorId: 'u1', connectionId: 'c1', accountId: 'a1', channel: 'NATIVE' };
  return { enabled: true, principal,
    grant: { ...principal, status: 'ACTIVE', notBeforeMs: 100, expiresAtMs: 300, toolIds: [...READ_TOOLS] },
    request: { accountId: 'a1', toolId: 'market.quote.read' }, nowMs: 200 };
}
const check = (change, code) => {
  const x = fixture(); change(x);
  assert.deepEqual(evaluateReadToolPolicy(x), { allowed: false, code });
};
test('disabled by default', () => assert.equal(evaluateReadToolPolicy().allowed, false));
test('only a matching active read grant is a candidate', () => {
  for (const toolId of READ_TOOLS) {
    const x = fixture(); x.request.toolId = toolId;
    assert.deepEqual(evaluateReadToolPolicy(x), { allowed: true, code: 'READ_CANDIDATE_ALLOWED' });
  }
});
test('strict enable flag', () => check(x => { x.enabled = 'true'; }, 'AI_DISABLED'));
test('invalid clocks fail closed', () => {
  for (const time of [NaN, Infinity, -1, '200', undefined]) check(x => { x.nowMs = time; }, 'INVALID_CLOCK');
});
test('missing trusted context', () => check(x => { x.grant = null; }, 'MISSING_CONTEXT'));
for (const key of ['tenantId','actorId','connectionId','accountId']) {
  test('reject mismatched ' + key, () => check(x => { x.grant[key] = 'other'; }, 'SCOPE_MISMATCH'));
}
test('reject different or unsupported channels', () => {
  check(x => { x.grant.channel = 'EXTERNAL'; }, 'CHANNEL_MISMATCH');
  check(x => { x.grant.channel = x.principal.channel = 'UNKNOWN'; }, 'CHANNEL_MISMATCH');
});
test('reject revoked, expired and not-yet-active grants', () => {
  check(x => { x.grant.status = 'REVOKED'; }, 'GRANT_INACTIVE');
  check(x => { x.nowMs = 300; }, 'GRANT_INACTIVE');
  check(x => { x.nowMs = 99; }, 'GRANT_INACTIVE');
  check(x => { x.grant.expiresAtMs = undefined; }, 'GRANT_INACTIVE');
});
test('reject cross-account requests', () => check(x => { x.request.accountId = 'a2'; }, 'ACCOUNT_MISMATCH'));
test('no write, unknown, wildcard or prototype tools', () => {
  for (const toolId of ['trade.execute','trade.close','chart.write','*','__proto__','constructor']) {
    check(x => { x.request.toolId = toolId; x.grant.toolIds.push(toolId); }, 'TOOL_NOT_AVAILABLE');
  }
});
test('deny missing scope and invalid grant catalog', () => {
  check(x => { x.grant.toolIds = []; }, 'TOOL_NOT_GRANTED');
  check(x => { x.grant.toolIds = '*'; }, 'TOOL_NOT_GRANTED');
  check(x => { x.grant.toolIds.push('trade.execute'); }, 'TOOL_NOT_GRANTED');
});
test('model input cannot substitute the trusted grant', () => {
  check(x => { x.grant.toolIds = []; x.request.toolIds = [...READ_TOOLS]; x.request.enabled = true; }, 'TOOL_NOT_GRANTED');
});
