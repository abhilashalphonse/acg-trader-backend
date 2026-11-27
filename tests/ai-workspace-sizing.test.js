'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseSizingQuestion,sizingEvidence}=require('../src/modules/ai/intelligence/workspace-sizing');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const question='Based on my current account balance and open margin, calculate the exact lot size for a 0.5% risk trade on XAUUSD with a 15-pip stop loss.';
const account={currency:'USD',leverage:100,state:{balance:'99939.78',equity:'99939.78',freeMargin:'99939.78'},riskPolicy:{},updatedAt:'2026-11-27T08:00:00Z'};
const market={symbol:'XAUUSD',instrument:{sizingSpecifications:{pipSize:'0.01',contractSize:'100',volumeStep:'0.01',minVolume:'0.01',maxVolume:'100',
  quoteCurrency:'USD',marginCurrency:'USD',pnlCurrency:'USD',defaultLeverage:50,marginRate:null,commissionPerLotPerSide:'0',commissionRate:'0'}},
  quote:{status:'RECENT_PROVIDER_EVENT',bid:3679.9,ask:3680,observedAtMs:1}};
test('exact requested balance risk and lot step, existing margin engine caps volume',()=>{
  const r=sizingEvidence({question,market,account});
  assert.equal(r.status,'HYPOTHETICAL_COST_AND_MARGIN_ESTIMATE');
  assert.equal(r.plannedRisk,'499.6989');assert.equal(r.stopDistance,'0.15');assert.equal(r.lossPerLot,'15');
  assert.equal(r.riskLimitedLots,'33.31');assert.equal(r.marginPerLot,'7360');
  assert.equal(r.estimatedLots,'13.56');assert.equal(r.estimatedRequiredMargin,'99801.6');
  assert.equal(r.estimatedInitialCollateral,'99937.2');assert.equal(r.executionAllowed,false);
});
test('missing, unverified, or wrong currency quote does not produce affordable lots',()=>{
  const r=sizingEvidence({question,market:{...market,quote:{status:'UNAVAILABLE',observedQuote:{bid:3679.9,ask:3680}}},account});
  assert.equal(r.status,'PRE_COST_ESTIMATE');assert.equal(r.estimatedLots,undefined);assert.equal(r.riskLimitedLots,'33.31');
  assert.equal(sizingEvidence({question,market,account:{...account,currency:'EUR'}}).status,'CROSS_CURRENCY_RISK_NOT_SUPPORTED');
  assert.equal(sizingEvidence({question,market,account:null}).status,'ACCOUNT_CONTEXT_UNAVAILABLE');
});
test('ambiguous, negative or unrelated sizing requests fail closed',()=>{
  assert.equal(parseSizingQuestion('How many lots for 0.5% and 15 pips?',market.symbol).status,'NEEDS_EXPLICIT_RISK_AND_STOP');
  assert.equal(parseSizingQuestion(question.replace('XAUUSD','EURUSD'),market.symbol).status,'NEEDS_SELECTED_SYMBOL');
  assert.equal(parseSizingQuestion(question.replace('0.5%','-0.5%'),market.symbol).status,'NEEDS_EXPLICIT_RISK_AND_STOP');
  assert.equal(parseSizingQuestion(question.replace('balance','balance and equity'),market.symbol).status,'NEEDS_RISK_BASIS');
  assert.equal(parseSizingQuestion('What is a fair value gap?',market.symbol),null);
});
test('existing request builder includes deterministic values without mutating source',()=>{
  const body=buildWorkspaceBody({modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048},{question,history:[],market,account});
  const data=JSON.parse(body.messages[1].content);
  assert.equal(data.market.sizingCalculation.estimatedLots,'13.56');
  assert.equal(market.sizingCalculation,undefined);
  assert.equal(body.max_completion_tokens,2048);
});
