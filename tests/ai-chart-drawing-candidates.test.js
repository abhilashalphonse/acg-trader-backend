'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDrawingCandidateRegistry,VERSION}=require('../src/modules/ai/intelligence/chart-drawing-candidates');
const through=1795836600000,nowMs=through+1000;
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const chartContextVersion='e'.repeat(64),actionId='aabbccdd-1122-4333-8444-556677889900';
function fixture(){
 return {schemaVersion:'adaptive-market-v1',symbol:'BTCUSD',selectedTimeframe:'5m',asOfMs:nowMs,frames:[{timeframe:'5m',status:'HISTORICAL_ONLY',quality:{status:'RECENT_CLOSED_BAR',gaps:0,exclusions:{synthetic:0}},coverage:{outOfSessionBars:0},freshness:{state:'LATEST_EXPECTED_UTC_BUCKET',latestClosedAtMs:through},observations:[
 {type:'LIQUIDITY_REFERENCE',id:'1'.repeat(64),side:'HIGH',level:'60020.15',pivotOpenTimeMs:through-1200000,confirmedAtMs:through-300000,swept:false,broken:false},
 {type:'FVG_ZONE',id:'2'.repeat(64),direction:'BULLISH',lower:'59900.1',upper:'59920.15',formedAtMs:through-600000,invalidatedAtMs:null,touchState:'UNTOUCHED'}]}]};
}
const registry=(market=fixture())=>createDrawingCandidateRegistry({market,scope,chartContextVersion,nowMs});
const ctx=(extra={})=>({scope,chartContextVersion,nowMs,complete:true,...extra});
const proposal=(ids)=>({contractVersion:VERSION,actionId,chartContextVersion,actions:ids.map(sourceId=>({action:'draw',sourceId}))});
test('detector decimal anchors resolve to chart seconds; summaries contain no geometry',()=>{
 const r=registry(),items=r.list();
 assert.equal(items.length,2);
 assert.ok(items.every(c=>!Object.hasOwn(c,'geometry')));
 assert.deepEqual(items,registry().list());
 const p=r.resolve(proposal(items.map(c=>c.sourceId)),ctx());
 assert.deepEqual(p.actions[0].geometry,{type:'hline',time:(through-1200000)/1000,price:60020.15});
 assert.deepEqual(p.actions[1].geometry,{type:'rectangle',fromTime:(through-600000)/1000,toTime:through/1000,lower:59900.1,upper:59920.15});
 assert.ok(Object.isFrozen(p.actions[0].geometry));
 assert.equal(p.actions[0].drawingKey,items[0].sourceId);
});
test('rejects forged IDs, coordinates, duplicate references, unknown actions and partial or cancelled results',()=>{
 const r=registry(),id=r.list()[0].sourceId,p=proposal([id]);
 for(const invalid of [proposal(['unknown']),proposal([id,id]),{...p,actions:[{action:'draw',sourceId:id,price:123}]},{...p,actions:[{action:'order',sourceId:id}]},{...p,actions:[]},{...p,actions:Array(9).fill(p.actions[0])},{...p,actionId:'bad'}])
   assert.throws(()=>r.resolve(invalid,ctx()),{code:'AI_DRAWING_CANDIDATE_DENIED'});
 for(const extra of [{complete:false},{signal:{aborted:true}},{scope:{...scope,actorId:'f'.repeat(24)}},{chartContextVersion:'f'.repeat(64)},{nowMs:nowMs+10000}])
   assert.throws(()=>r.resolve(p,ctx(extra)),{code:'AI_DRAWING_CANDIDATE_DENIED'});
});
test('rejects unsuitable snapshots and skips swept or invalidated evidence',()=>{
 const m=fixture();m.frames[0].observations[0].swept=true;m.frames[0].observations[1].invalidatedAtMs=through;
 assert.equal(registry(m).list().length,0);
 for(const mutate of [x=>x.frames[0].quality.gaps=1,x=>x.frames[0].quality.exclusions.synthetic=1,x=>x.frames[0].freshness.state='MISSING_RECENT_CLOSED_BUCKET',x=>x.frames[0].coverage.outOfSessionBars=1,x=>x.asOfMs=nowMs-10000]){
   const x=fixture();mutate(x);assert.throws(()=>registry(x),{code:'AI_DRAWING_CANDIDATE_DENIED'});
 }
});
test('same FVG source remains stable when a subsequent closed bar extends its right edge',()=>{
 const m=fixture(),r=registry(m),fvg=r.list().find(c=>c.kind==='FVG_ZONE');
 m.frames[0].freshness.latestClosedAtMs=through+300000;
 m.asOfMs=nowMs+300000;
 const next=createDrawingCandidateRegistry({market:m,scope,chartContextVersion,nowMs:m.asOfMs});
 assert.equal(next.list().find(c=>c.kind==='FVG_ZONE').sourceId,fvg.sourceId);
});

test('real structure detector output resolves without model-supplied geometry',()=>{
 const {analyzeStructure}=require('../src/modules/ai/intelligence/structure-liquidity');
 // Closed contiguous five-minute fixture: confirmed swing low and a
 // bullish three-bar imbalance that remains uninvalidated.
 const rows=[[102,104,100,103],[103,105,101,104],[104,105,95,101],[101,104,100,103],[103,106,102,105],[110,112,109,111],[111,113,110,112],[112,114,110,113]];
 const candles=rows.map(([open,high,low,close],i)=>({symbol:'BTCUSD',timeframe:'5m',openTimeMs:through-(rows.length-i)*300000,closeTimeMs:through-(rows.length-i-1)*300000,open,high,low,close,complete:true,synthetic:false,source:'LIVE',provider:'twelve-data'}));
 const structure=analyzeStructure({symbol:'BTCUSD',timeframe:'5m',asOfMs:nowMs,candles});
 const m=fixture();m.frames[0].quality=structure.quality;
 // Match the existing compactReference projection from prompt-compiler.
 const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>Object.hasOwn(o,k)).map(k=>[k,o[k]]));
 m.frames[0].observations=[
 ...structure.activeReferences.map(o=>({type:'LIQUIDITY_REFERENCE',...pick(o,['id','side','level','pivotOpenTimeMs','confirmedAtMs','swept','broken','sweptAtMs','brokenAtMs'])})),
 ...structure.zones.slice(-4).map(o=>({type:'FVG_ZONE',...pick(o,['id','direction','lower','upper','formedAtMs','firstTouchAtMs','deepest','touchState','invalidatedAtMs','invalidationType'])}))];
 const r=registry(m),items=r.list();
 const low=items.find(c=>c.kind==='LIQUIDITY_REFERENCE'&&c.evidence.side==='LOW');
 const gap=items.find(c=>c.kind==='FVG_ZONE'&&c.evidence.direction==='BULLISH');
 assert.ok(low);assert.ok(gap);
 const result=r.resolve(proposal([low.sourceId,gap.sourceId]),ctx());
 assert.equal(result.actions[0].geometry.price,95);
 const source=structure.zones.find(z=>z.id===gap.evidence.detectorId);
 assert.equal(result.actions[1].geometry.lower,Number(source.lower));
 assert.equal(result.actions[1].geometry.upper,Number(source.upper));
});

test('same action ID is replay-safe within a registry, conflicting reuse denied',()=>{
 const r=registry(),[a,b]=r.list(),p=proposal([a.sourceId]);
 const first=r.resolve(p,ctx());
 assert.equal(r.resolve(p,ctx()),first);
 assert.throws(()=>r.resolve(proposal([b.sourceId]),ctx()),{code:'AI_DRAWING_CANDIDATE_DENIED'});
 assert.throws(()=>r.resolve(p,ctx({signal:{aborted:true}})),{code:'AI_DRAWING_CANDIDATE_DENIED'});
});
