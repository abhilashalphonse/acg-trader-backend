'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workspaceStage,workspaceFailureDiagnostic}=require('../src/modules/ai/ai-http-security');
test('workspace failure diagnostics retain deepest stage and only allow known error codes',async()=>{
  const e=Object.assign(Error('sensitive question or credentials'),{code:'UNKNOWN_PROVENANCE'});
  await assert.rejects(workspaceStage('ACCESS',()=>workspaceStage('MARKET_CONTEXT',()=>{throw e;})),x=>x===e);
  const d=workspaceFailureDiagnostic(e);
  assert.equal(d.aiFailureStage,'MARKET_CONTEXT');
  assert.equal(d.aiFailureCode,'UNKNOWN_PROVENANCE');
  assert.ok(!JSON.stringify(d).includes('sensitive'));
  const unknown=Object.assign(new TypeError('private message'),{code:'arbitrary-private-code'});
  await assert.rejects(workspaceStage('PROMPT_BUILD',()=>{throw unknown;}),x=>x===unknown);
  assert.equal(workspaceFailureDiagnostic(unknown).aiFailureCode,'TYPE_ERROR');
  assert.ok(!JSON.stringify(workspaceFailureDiagnostic(unknown)).includes('private'));
  assert.equal(workspaceFailureDiagnostic(Error('unrelated')),null);
  assert.equal(await workspaceStage('ACCESS',()=>42),42);
});
