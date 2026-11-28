'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {addWorkspacePresentation,compactRepeatedMetadata,compactNarrowRawHistory}=require('../src/modules/ai/intelligence/workspace-presentation-context');
const end=1795836600000;
function market(profile='BOS'){
 const limitations=['NO_EXECUTION_AUTHORITY','NO_ORDER_BOOK_OR_INSTITUTIONAL_FLOW_PROOF','NO_PREDICTIVE_VALIDATION','NO_INTRABAR_SEQUENCE'];
 return {schemaVersion:'adaptive-market-v1',selectedTimeframe:'5m',contextSelection:{profile},frames:['5m','1m','30m','4h'].map((timeframe,i)=>{
   const step=[300000,60000,1800000,14400000][i];
   return {timeframe,status:'HISTORICAL_ONLY',quality:{status:'RECENT_CLOSED_BAR',gaps:0,exclusions:{synthetic:0},contiguousCount:64},
     freshness:{state:'LATEST_EXPECTED_UTC_BUCKET',latestClosedAtMs:end},coverage:{outOfSessionBars:0},availableClosedBars:64,
     closedCandles:Array.from({length:i===0?48:16},(_,j)=>[end-(i===0?48-j:16-j)*step,59961.48,59962,59960,59961.48]),
     limitations:[...limitations],advanced:{methodVersion:'advanced-market-intelligence-v1',regime:{state:'RANGING'},dealingRange:{low:59834.38,high:60249.99},limitations:[...limitations]},
     observations:[{type:'STRUCTURE_SUMMARY',bias:'BEARISH',limitations:[...limitations]},
       {type:'STRUCTURE_EVENT',kind:'BOS',atMs:end-300000,level:'59941.16',close:'59913.71'},
       {type:'FVG_ZONE',lower:59952.19,upper:59957.38,formedAtMs:end-600000,firstTouchAtMs:null,invalidatedAtMs:end-300000}]};
 })};
}
test('UTC labels are exact, and a previously broken level can be above the latest completed close or below it',()=>{
 const m=market(),f=m.frames[0],old=structuredClone(f.observations),last=f.closedCandles.at(-1)[4];
 f.activeCandle={close:59000,complete:false};
 addWorkspacePresentation(m);
 assert.equal(f.closedPriceContext.price,last);
 assert.equal(f.closedPriceContext.basis,'LAST_VALIDATED_CLOSED_BAR');
 assert.equal(f.closedPriceContext.throughUtc,new Date(end).toISOString());
 const bos=f.observations[1],gap=f.observations[2];
 assert.equal(bos.atUtc,new Date(old[1].atMs).toISOString());
 assert.equal(bos.lastClosedPriceRelativeToLevel,'ABOVE');
 assert.equal(bos.level,old[1].level);assert.equal(bos.atMs,old[1].atMs);
 assert.equal(gap.formedAtUtc,new Date(old[2].formedAtMs).toISOString());
 assert.equal(gap.invalidatedAtUtc,new Date(old[2].invalidatedAtMs).toISOString());
 assert.equal(gap.firstTouchAtUtc,undefined);
 assert.equal(m.frames[1].observations[1].atUtc,undefined);
 assert.equal(m.frames[1].closedPriceContext,undefined);
});
test('repeated limitation metadata is compacted losslessly and distinct lists stay inline',()=>{
 const m=market();m.frames[1].limitations=['UNIQUE_FRAME_LIMITATION'];
 const before=structuredClone(m);
 compactRepeatedMetadata(m);
 assert.ok(Buffer.byteLength(JSON.stringify(m))<Buffer.byteLength(JSON.stringify(before)));
 for(const [i,f] of m.frames.entries()){
   for(const [a,b] of [[f,before.frames[i]],[f.advanced,before.frames[i].advanced],[f.observations[0],before.frames[i].observations[0]]]){
     assert.deepEqual(a.limitations??m.sharedLimitations[a.limitationsRef],b.limitations);
   }
 }
 assert.deepEqual(m.frames[1].limitations,['UNIQUE_FRAME_LIMITATION']);
});
test('narrow query keeps exact validated tails, all observations, and uncertainty',()=>{
 for(const profile of ['BOS','FVG','LIQUIDITY']){
   const m=market(profile);m.frames[3].quality.gaps=1;
   const before=structuredClone(m);
   compactNarrowRawHistory(m);
   assert.ok(Buffer.byteLength(JSON.stringify(m))<Buffer.byteLength(JSON.stringify(before)));
   for(const [i,f] of m.frames.entries()){
     const old=before.frames[i];if(i===3){assert.deepEqual(f,old);continue;}
     const limit=[24,8,4][i];
     assert.deepEqual(f.closedCandles,old.closedCandles.slice(-limit));
     assert.equal(f.omittedClosedBars,64-limit);
     assert.deepEqual(f.observations,old.observations);
     assert.deepEqual(f.advanced,old.advanced);
     assert.deepEqual(f.quality,old.quality);
     assert.equal(f.narrowRawHistoryProjection.derivedEvidenceUsesOriginalWindow,true);
   }
 }
 for(const profile of ['STRUCTURE','MARKET_OVERVIEW','FULL','SESSION']){
   const m=market(profile),before=structuredClone(m);compactNarrowRawHistory(m);assert.deepEqual(m,before);
 }
});
