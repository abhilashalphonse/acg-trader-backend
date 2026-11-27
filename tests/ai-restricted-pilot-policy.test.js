'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createRestrictedPilotPolicy,createPersonalDemoPilotAccountResolver}=require('../src/modules/ai/providers/restricted-pilot-policy');
const {compareBillingBucket}=require('../src/modules/ai/providers/provider-billing-reconciliation');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('restricted pilot checks exact member, demo grant, approval, rights, wire payload and expiry',async()=>{
  const scope={tenantId:'1'.repeat(24),actorId:'2'.repeat(24),accountId:'3'.repeat(24)};
  const fields={enabled:true,expiresAtMs:2000,members:[scope],instruments:[{symbol:'XAUUSD',timeframe:'1m'}]};
  const descriptorId='a'.repeat(64),policyVersion=hash(fields);
  let now=1000,approval=true,account=true,member=true,rights=true,wire=true;
  const resolver=createPersonalDemoPilotAccountResolver({store:{account:async s=>account&&s.accountId===scope.accountId?{_id:s.accountId}:null},now:()=>now});
  const pilot=createRestrictedPilotPolicy({policy:{...fields,descriptorId,policyVersion},now:()=>now,
    verifyApproval:async a=>approval&&a.descriptorId===descriptorId&&a.policyVersion===policyVersion,resolveAccount:resolver,
    resolveMembership:async()=>member,resolveDataRights:async()=>rights,validatePayload:async()=>wire});
  const workspace={symbol:'XAUUSD',timeframe:'1m',descriptorId,policyVersion};
  assert.equal(await pilot.marketEntitlement(scope,workspace,'GRANT'),true);
  assert.equal(await pilot.marketEntitlement({...scope,actorId:'4'.repeat(24)},workspace,'GRANT'),false);
  assert.equal(await pilot.marketEntitlement(scope,{...workspace,timeframe:'5m'},'DISPATCH'),false);
  assert.equal(await pilot.marketEntitlement(scope,workspace,'TRADE'),false);
  const payload={store:false,stream:false,n:1,service_tier:'default',messages:[{role:'system',content:'fixture'},{role:'user',content:'fixture'}]};
  const input={scope,workspace,descriptorId,policyVersion,payload,wireDigest:hash(payload)};
  assert.equal(await pilot.authorizeExport(input),true);
  assert.equal(await pilot.authorizeExport({...input,wireDigest:'f'.repeat(64)}),false);
  assert.equal(await pilot.authorizeExport({...input,payload:{...payload,tools:[]},wireDigest:hash({...payload,tools:[]})}),false);
  wire=false;assert.equal(await pilot.authorizeExport(input),false);wire=true;
  rights=false;assert.equal(await pilot.marketEntitlement(scope,workspace,'CLAIM'),false);rights=true;
  member=false;assert.equal(await pilot.marketEntitlement(scope,workspace,'DISCLOSE'),false);member=true;
  account=false;assert.equal(await pilot.marketEntitlement(scope,workspace,'CLAIM'),false);account=true;
  approval=false;assert.equal(await pilot.marketEntitlement(scope,workspace,'CLAIM'),false);approval=true;
  now=2000;assert.equal(await pilot.authorizeExport(input),false);
});
test('billing bucket matching never claims request attribution or mutates ledger',()=>{
  const local={projectId:'fixture',model:'fixture-model',startMs:1000,endMs:2000,requests:1,inputTokens:277,outputTokens:79,estimatedCostPicoUsd:67200000};
  const provider={projectId:local.projectId,model:local.model,startMs:1000,endMs:2000,requests:1,inputTokens:277,outputTokens:79,costPicoUsd:67200000,authenticated:true,complete:true};
  assert.equal(compareBillingBucket({local,provider}).state,'MATCHED_BUCKET');
  assert.equal(compareBillingBucket({local,provider}).requestAttributionVerified,false);
  assert.equal(compareBillingBucket({local,provider}).ledgerChanged,false);
  assert.equal(compareBillingBucket({local,provider:{...provider,outputTokens:0}}).state,'REVIEW_REQUIRED');
  assert.equal(compareBillingBucket({local,provider:{...provider,authenticated:false}}).state,'EVIDENCE_INCOMPLETE');
  assert.equal(compareBillingBucket({local,provider:{...provider,projectId:'other'}}).state,'EVIDENCE_INCOMPLETE');
});
