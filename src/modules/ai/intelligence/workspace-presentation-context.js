'use strict';
// Provider-only projection, after scope validation and deterministic analysis.
// Keep exact OHLC, numeric levels, event ordering and raw millisecond values.
const utc=ms=>Number.isSafeInteger(ms)&&ms>=0&&ms<=8640000000000000?new Date(ms).toISOString():null;
const {compareDecimal}=require('../../../shared/decimal/decimal');
const price=v=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)&&Number.isFinite(Number(v))&&Number(v)>0?v:null;
const side=(reference,level)=>{try{const c=compareDecimal(reference,level);return c>0?'ABOVE':c<0?'BELOW':'AT';}catch{return 'UNKNOWN';}};
function addWorkspacePresentation(market){
  if(market?.schemaVersion!=='adaptive-market-v1'||!Array.isArray(market.frames))return;
  for(const frame of market.frames){
    // Last completed bar only, never active candle or an executable quote.
    const last=frame.closedCandles?.at(-1);
    const fact=frame.observations?.find(o=>o.type==='FACT'&&o.kind==='LAST_CLOSED_PRICE');
    const reference=price(last?.[4]??fact?.value??frame.advanced?.referencePrice);
    if(reference!==null&&frame.timeframe===market.selectedTimeframe){
      frame.closedPriceContext={price:reference,throughUtc:utc(frame.freshness?.latestClosedAtMs),basis:'LAST_VALIDATED_CLOSED_BAR'};
    }
    for(const o of frame.observations??[]){
      if(frame.timeframe!==market.selectedTimeframe)continue;
      if(o.type==='STRUCTURE_EVENT'){
        const at=utc(o.atMs);
        if(at){o.atUtc=at;
          if(reference!==null&&price(o.level)!==null)o.lastClosedPriceRelativeToLevel=side(reference,price(o.level));
        }
      }else if(o.type==='FVG_ZONE'){
        for(const [key,target] of [['formedAtMs','formedAtUtc'],['firstTouchAtMs','firstTouchAtUtc'],['invalidatedAtMs','invalidatedAtUtc']]){
          const at=utc(o[key]);if(at)o[target]=at;
        }
      }
    }
  }
}
// Deduplicate only exact repeated nonempty arrays from server-owned frame
// metadata. Preserve semantics via explicit references, never merge unequal
// arrays or remove frame-specific quality/coverage/freshness.
function compactRepeatedMetadata(market){
  if(!market?.contextSelection||!Array.isArray(market.frames))return;
  const slots=[];
  for(const frame of market.frames){
    slots.push([frame,'limitations']);
    if(frame.advanced)slots.push([frame.advanced,'limitations']);
    for(const o of frame.observations??[])if(o.type==='STRUCTURE_SUMMARY')slots.push([o,'limitations']);
  }
  const groups=new Map();
  for(const [obj,key] of slots){
    const value=obj[key];
    if(!Array.isArray(value)||!value.length||!value.every(x=>typeof x==='string'))continue;
    const encoded=JSON.stringify(value);
    if(!groups.has(encoded))groups.set(encoded,[]);
    groups.get(encoded).push([obj,key]);
  }
  const shared={};
  for(const [encoded,items] of groups){
    if(items.length<2)continue;
    const id='L'+(Object.keys(shared).length+1);
    const referenceKey='limitationsRef';
    // If a future schema already defines a reference field, leave it alone.
    if(items.some(([obj])=>Object.hasOwn(obj,referenceKey)))continue;
    const overhead=Buffer.byteLength(JSON.stringify({[id]:JSON.parse(encoded)}))+items.length*Buffer.byteLength(JSON.stringify({[referenceKey]:id}))+32;
    if(items.length*Buffer.byteLength(JSON.stringify({limitations:JSON.parse(encoded)}))<=overhead)continue;
    shared[id]=JSON.parse(encoded);
    for(const [obj,key] of items){delete obj[key];obj[referenceKey]=id;}
  }
  if(Object.keys(shared).length)market.sharedLimitations=shared;
}
module.exports={addWorkspacePresentation,compactRepeatedMetadata};
