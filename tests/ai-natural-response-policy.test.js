'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const descriptor={modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048};
function build(question,quote){
  const market={schemaVersion:'adaptive-market-v1',symbol:'BTCUSD',selectedTimeframe:'5m',
    quote,frames:[{timeframe:'5m',availableClosedBars:1,closedCandles:[[1795824000000,60000,60229,59900,60186.64]],observations:[],freshness:{state:'LATEST_EXPECTED_UTC_BUCKET'}}]};
  const original=JSON.stringify(market);
  const body=buildWorkspaceBody(descriptor,{question,history:[],market,account:null});
  assert.equal(JSON.stringify(market),original);
  const policy=JSON.parse(body.messages[0].content).join(' ');
  const data=JSON.parse(body.messages[1].content);
  assert.deepEqual(data.market.quote,quote);
  assert.equal(data.market.frames[0].closedCandles[0][4],60186.64);
  assert.equal(body.max_completion_tokens,2048);
  return policy;
}
test('chart analysis policy does not require irrelevant quote diagnostics but retains source facts',()=>{
  const policy=build('Analyse the current BTCUSD market structure.',{status:'UNAVAILABLE',reason:'QUOTE_TIME_OR_STATE_UNVERIFIED',executable:false});
  assert.match(policy,/omit irrelevant quote warnings/);
  assert.match(policy,/use candle-based levels/);
  assert.match(policy,/Do not call a candle close the current executable price/);
  assert.doesNotMatch(policy,/If neither exists, identify the actual quote failure reason/);
});
test('price-dependent questions and material evidence gaps still require honest qualification',()=>{
  const policy=build('What is the current price of BTCUSD?',{status:'UNAVAILABLE',reason:'QUOTE_STALE',executable:false});
  assert.match(policy,/explicit current price, bid\/ask, spread/);
  assert.match(policy,/last validated candle price with its timeframe or timestamp/);
  assert.match(policy,/Never invent a quote or an open session/);
  assert.match(policy,/Mention gaps, stale chart evidence, incomplete bars or insufficient account\/calendar evidence when they materially change the conclusion/);
  assert.match(policy,/Never claim confirmation without evidence/);
  assert.match(policy,/Never invent missing specifications/);
});
test('verified and session-unverified observations are preserved without granting execution authority',()=>{
  for(const quote of [
    {status:'RECENT_PROVIDER_EVENT',bid:60199,ask:60200,providerTimestampMs:1795824000000,executable:false},
    {status:'UNAVAILABLE',reason:'SESSION_CLOSED_OR_UNKNOWN',observedQuote:{bid:60199,ask:60200,providerTimestampMs:1795824000000,executable:false}}
  ]){
    const policy=build('What is the current price?',quote);
    assert.match(policy,/timestamped observation, not an executable quote/);
    assert.match(policy,/qualify its unverified session/);
  }
});
