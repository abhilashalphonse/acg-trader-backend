'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compactWorkspaceWireEvidence}=require('../src/modules/ai/intelligence/workspace-wire-compaction');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const byte=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function fixture(){
 const hash='a'.repeat(64);
 const levels=Array.from({length:3},(_,i)=>({side:'BUY_SIDE',kind:'INTERNAL_SWING',level:String(59941+i)+'.123456789',confirmedAtMs:1795836600000+i,brokenAtMs:null,state:'UNBREACHED_SINCE_CONFIRMATION'}));
 const displacements=Array.from({length:3},(_,i)=>({direction:'BULLISH',atMs:1795836600000+i,open:59941.12345678,close:59961.12345678,baselineThroughMs:1795836600000,bodyMultiple:1.51,rangeMultiple:1.25}));
 return {schemaVersion:'adaptive-market-v1',selectedTimeframe:'5m',contextSelection:{profile:'STRUCTURE'},frames:['5m','1m','30m','4h'].map(timeframe=>({timeframe,coverage:{scheduleHash:hash,calendarVerified:true},quality:{gaps:0},advanced:{regime:{state:'RANGING'},liquidity:{definition:'PRICE_STRUCTURE_PROXY_NOT_OBSERVED_ORDERS',levels:structuredClone(levels)},displacements:structuredClone(displacements)}}))};
}
const unpack=(obj,key)=>obj[key]??obj[key+'Rows'].map(row=>Object.fromEntries(obj[key+'Columns'].map((k,i)=>[k,row[i]])));
test('packed analytical records and repeated coverage identity reconstruct exactly',()=>{
 const m=fixture(),old=structuredClone(m);
 compactWorkspaceWireEvidence(m);
 assert.ok(byte(m)<byte(old));
 for(const [i,f] of m.frames.entries()){
  const original=old.frames[i];
  assert.deepEqual(unpack(f.advanced,'displacements'),original.advanced.displacements);
  assert.deepEqual(unpack(f.advanced.liquidity,'levels'),original.advanced.liquidity.levels);
  assert.deepEqual(f.advanced.regime,original.advanced.regime);
  assert.equal(m.sharedScheduleHashes[f.coverage.scheduleHashRef],original.coverage.scheduleHash);
  assert.equal(f.coverage.calendarVerified,original.coverage.calendarVerified);
  assert.deepEqual(f.quality,original.quality);
 }
});
test('mixed record keys and nonfocused requests retain original records',()=>{
 const m=fixture();m.frames[0].advanced.liquidity.levels[0].sweptAtMs=null;
 const levels=structuredClone(m.frames[0].advanced.liquidity.levels);
 compactWorkspaceWireEvidence(m);
 assert.deepEqual(m.frames[0].advanced.liquidity.levels,levels);
 const full=fixture();full.contextSelection.profile='FULL';const copy=structuredClone(full);
 compactWorkspaceWireEvidence(full);assert.deepEqual(full,copy);
});
test('consolidated policy is materially smaller and keeps safety, output and evidence requirements',()=>{
 const body=buildWorkspaceBody({modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048},{question:'Explain BOS',history:[],account:null,market:null});
 const policy=JSON.parse(body.messages[0].content);
 assert.equal(policy.length,10);
 assert.ok(Buffer.byteLength(body.messages[0].content)<5000);
 const text=policy.join(' ');
 for(const re of [/read-only/,/untrusted data/,/no guarantees or trade execution/i,/Never invent a quote/,/deterministic sizingCalculation/,/Do not claim complete account risk/,/Never claim confirmation/,/epoch milliseconds/,/limited|partial evidence/,/scheduleHashRef/,/displacementsColumns\/displacementsRows/])assert.match(text,re);
});
