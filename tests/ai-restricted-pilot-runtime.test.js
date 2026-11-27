'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRestrictedPilotRuntime,isRestrictedPilotRuntime}=require('../src/modules/ai/providers/restricted-pilot-runtime');
const {createRestrictedPilotRouter}=require('../src/modules/ai/providers/restricted-pilot.routes');
test('pilot remains unmounted without explicit release composition and rejects unbranded runtimes',()=>{
  assert.equal(createRestrictedPilotRuntime({env:{}}),null);
  assert.equal(createRestrictedPilotRuntime({env:{ACG_AI_LIVE_PROVIDER_ENABLED:'true'}}),null);
  assert.equal(createRestrictedPilotRuntime({env:{ACG_AI_RESTRICTED_PILOT_ENABLED:'true'}}),null);
  assert.throws(()=>createRestrictedPilotRuntime({env:{ACG_AI_LIVE_PROVIDER_ENABLED:'true',ACG_AI_RESTRICTED_PILOT_ENABLED:'true'}}));
  const fake={generate:async()=>({state:'VERIFIED'})};
  assert.equal(isRestrictedPilotRuntime(fake),false);
  assert.throws(()=>createRestrictedPilotRouter({runtime:fake,enabled:()=>true,quota:{consume(){}}}));
});
