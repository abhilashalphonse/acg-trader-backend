'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PHASE_ONE_READS, assertPhaseOneRead, assertPhaseOneGrant, createScopedReadPort } = require('./financial-safety-boundary');
const { AVAILABLE_READ_TOOLS } = require('./read-tool-registry');

test('Phase 1 explicitly authorizes only implemented read capabilities', () => {
  assert.deepEqual([...AVAILABLE_READ_TOOLS].sort(), [...PHASE_ONE_READS].sort());
  assert.ok(Object.isFrozen(PHASE_ONE_READS));
  for (const id of PHASE_ONE_READS) assert.doesNotThrow(() => assertPhaseOneRead(id));
});
test('financial and administrative actions are denied regardless of naming', () => {
  for (const id of ['trade.execute','orders.market','orders.pending','orders.cancel','orders.amend',
    'positions.close','positions.closeAll','positions.reverse','positions.protection','positions.breakEven',
    'positions.trailing','account.deposit','account.withdraw','account.risk.write','account.grant.write',
    'agent.execute','broker.execute','trade.execute.read','market.quote.read','constructor','__proto__',
    'ACCOUNT.POSITIONS.READ','account.positions.read ','*',null,{},['account.positions.read']]) {
    assert.throws(() => assertPhaseOneRead(id), {code:'AI_FINANCIAL_BOUNDARY_DENIED'});
  }
  assert.throws(() => assertPhaseOneGrant(['account.positions.read','trade.execute']), {code:'AI_FINANCIAL_BOUNDARY_DENIED'});
  assert.throws(() => assertPhaseOneGrant([]), {code:'AI_INVALID_READ_AUTHORITY'});
});
test('tool port does not expose grant or trading methods and cannot change account scope', async () => {
  const calls=[];
  const store={
    positions:async(s,n)=>{calls.push([s,n]);return [];},
    orders:async(s,n)=>{calls.push([s,n]);return [];},
    createGrant(){assert.fail('no grant authority');},
    revokeGrant(){assert.fail('no grant authority');},
    execute(){assert.fail('no trading authority');},
  };
  const scope={tenantId:'tenant',accountId:'account',actorId:'actor',sessionId:'session'};
  const port=createScopedReadPort(store,scope);
  assert.deepEqual(Object.keys(port).sort(),['orders','positions']);
  assert.ok(Object.isFrozen(port));
  scope.accountId='other';
  await port.positions(51,{tenantId:'other',accountId:'other'});
  await port.orders(1);
  assert.deepEqual(calls,[[{tenantId:'tenant',accountId:'account'},51],[{tenantId:'tenant',accountId:'account'},1]]);
  assert.ok(Object.isFrozen(calls[0][0]));
  for(const n of [0,52,1.5,Infinity,'1',{}]) assert.throws(()=>port.positions(n),{code:'AI_INVALID_READ_LIMIT'});
  assert.equal(calls.length,2);
});
