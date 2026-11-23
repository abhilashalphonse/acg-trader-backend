'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {definitionSchema,publicRule}=require('../src/modules/alerts/alert.routes');
const {evaluateAlert}=require('../src/modules/alerts/alert-evaluator');
test('per-alert sound is validated, defaults on for legacy rules and is exposed to the terminal',()=>{
  const input={symbol:'EURUSD',condition:{type:'crosses',level:'1.1'}};
  assert.equal(definitionSchema.parse(input).soundEnabled,true);
  assert.equal(definitionSchema.parse({...input,soundEnabled:false}).soundEnabled,false);
  assert.equal(definitionSchema.safeParse({...input,soundEnabled:'false'}).success,false);
  assert.equal(publicRule({_id:'rule',status:'PAUSED'}).soundEnabled,true);
  assert.equal(publicRule({_id:'rule',status:'PAUSED',soundEnabled:false}).soundEnabled,false);
});
test('muting the sound preserves the trigger and records its notification setting',()=>{
  for(const soundEnabled of [false,true,undefined]){
    const rule={_id:'rule',version:1,symbol:'EURUSD',streamId:'twelve-data:EURUSD',tickSize:'0.00001',priceSource:'last',frequency:'once',condition:{type:'crosses_above',level:'1.1'},soundEnabled};
    const event=(n,value)=>({eventId:'twelve-data:EURUSD#1:'+n,streamId:rule.streamId,kind:'quote',marketTimeMs:1000+n,receivedAtMs:1000+n,prices:{last:value}});
    const baseline=evaluateAlert(rule,null,event(1,'1.09'));
    const result=evaluateAlert(rule,baseline.state,event(2,'1.11'));
    assert.ok(result.trigger);
    assert.equal(result.trigger.soundEnabled,soundEnabled!==false);
  }
});
