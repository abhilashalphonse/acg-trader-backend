'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planChartActionSequence}=require('../src/modules/ai/intelligence/chart-action-sequence');
const all=Array.from({length:10},(_,i)=>({sourceId:'l'+i,kind:'LIQUIDITY_REFERENCE'})).concat(Array.from({length:10},(_,i)=>({sourceId:'f'+i,kind:'FVG_ZONE'})));
const registry={list:({limit})=>{assert.equal(limit,20);return all;}};
const ids=actions=>actions.map(a=>a.sourceId);
test('sequence honors explicit order, reserves capacity for both kinds, retains per-kind order',()=>{
 assert.deepEqual(ids(planChartActionSequence('LIQUIDITY_THEN_FVG',registry)),['l0','l1','l2','f0','f1','f2']);
 assert.deepEqual(ids(planChartActionSequence('FVG_THEN_LIQUIDITY',registry)),['f0','f1','f2','l0','l1','l2']);
 assert.deepEqual(ids(planChartActionSequence('LIQUIDITY',registry)),['l0','l1','l2','l3','l4','l5']);
});
test('unknown commands denied; empty candidate groups do not synthesize geometry',()=>{
 for(const command of ['TRADE','UNDO','__proto__',null])assert.throws(()=>planChartActionSequence(command,registry));
 assert.deepEqual(planChartActionSequence('FVG_THEN_LIQUIDITY',{list:()=>[]}),[]);
 assert.deepEqual(ids(planChartActionSequence('FVG_THEN_LIQUIDITY',{list:()=>all.slice(0,2)})),['l0','l1']);
});
