'use strict';
const {freeze}=require('./candle-evidence');
const METHOD='advanced-market-intelligence-v1';
// Descriptive heuristics, not calibrated forecasts. All patterns use closed,
// validated bars from the latest uninterrupted provider segment.
const POLICY=Object.freeze({regimeBars:20,rangeBars:48,baselineBars:14,minDisplacementBody:1.5,minDisplacementRange:1.25,
  minBodyFraction:.65,minCloseLocation:.75,trendEfficiency:.55,rangeEfficiency:.30,rangeWidthInTR:4,clusterToleranceTR:.10});
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const rounded=n=>Number.isFinite(n)?Number(n.toPrecision(12)):null;
const tr=(b,p)=>Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close));
const distance=(a,b)=>Math.abs(a-b);
const availablePrice=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e12;
function closeEfficiency(bars){
  let path=0;
  for(let i=1;i<bars.length;i++)path+=distance(bars[i].close,bars[i-1].close);
  const move=bars.at(-1).close-bars[0].close;
  return {move,efficiency:path===0?0:Math.min(1,Math.abs(move)/path)};
}
function marketRegime(bars){
  const window=bars.slice(-POLICY.regimeBars);
  if(window.length<POLICY.regimeBars)return {state:'INSUFFICIENT_BARS',bars:window.length};
  const {move,efficiency}=closeEfficiency(window);
  const trueRange=mean(window.slice(1).map((b,i)=>tr(b,window[i])));
  const high=Math.max(...window.map(b=>b.high)),low=Math.min(...window.map(b=>b.low));
  const widthTR=trueRange>0?(high-low)/trueRange:null;
  const moveTR=trueRange>0?Math.abs(move)/trueRange:null;
  let state='MIXED_TRANSITION';
  if(high===low)state='FLAT_OBSERVED';
  else if(efficiency>=POLICY.trendEfficiency&&moveTR>=2)state=move>0?'TRENDING_UP':'TRENDING_DOWN';
  else if(efficiency<=POLICY.rangeEfficiency)state=widthTR<=POLICY.rangeWidthInTR?'COMPRESSION':'RANGING';
  return {state,bars:window.length,fromMs:window[0].openTimeMs,throughMs:window.at(-1).closeTimeMs,
    efficiency:rounded(efficiency),meanTrueRange:rounded(trueRange),widthInTR:rounded(widthTR),netMoveInTR:rounded(moveTR)};
}
function dealingRange(bars,referencePrice){
  const window=bars.slice(-POLICY.rangeBars);
  if(window.length<10)return null;
  const high=Math.max(...window.map(b=>b.high)),low=Math.min(...window.map(b=>b.low));
  const width=high-low;
  if(width<=0)return {method:'ROLLING_OBSERVED_EXTREMES',bars:window.length,high,low,location:'FLAT_RANGE'};
  const position=(referencePrice-low)/width;
  return {method:'ROLLING_OBSERVED_EXTREMES',bars:window.length,fromMs:window[0].openTimeMs,throughMs:window.at(-1).closeTimeMs,
    high,low,highAtMs:window.findLast(b=>b.high===high).openTimeMs,lowAtMs:window.findLast(b=>b.low===low).openTimeMs,
    equilibrium:rounded(low+width/2),width:rounded(width),referencePrice,
    positionPct:rounded(position*100),location:position<0?'BELOW_RANGE':position>1?'ABOVE_RANGE':
      Math.abs(position-.5)<1e-9?'EQUILIBRIUM':position<.5?'DISCOUNT':'PREMIUM',
    region:position<0||position>1?'OUTSIDE_RANGE':position>=.3&&position<=.7?'MIDDLE_40_PERCENT':position<.3?'LOWER_REGION':'UPPER_REGION'};
}
function displacementEvents(bars){
  const out=[];
  for(let i=POLICY.baselineBars+1;i<bars.length;i++){
    const b=bars[i],history=bars.slice(i-POLICY.baselineBars,i);
    const typicalBody=mean(history.map(p=>distance(p.close,p.open)));
    const typicalTR=mean(history.map((p,j)=>tr(p,bars[i-POLICY.baselineBars+j-1])));
    const body=distance(b.close,b.open),range=b.high-b.low;
    if(typicalTR<=0||typicalBody<=0||range<=0||b.close===b.open)continue;
    const direction=b.close>b.open?'BULLISH':'BEARISH';
    const location=direction==='BULLISH'?(b.close-b.low)/range:(b.high-b.close)/range;
    if(body<typicalBody*POLICY.minDisplacementBody||range<typicalTR*POLICY.minDisplacementRange||
      body/range<POLICY.minBodyFraction||location<POLICY.minCloseLocation)continue;
    out.push({direction,atMs:b.closeTimeMs,open:b.open,close:b.close,high:b.high,low:b.low,
      bodyMultiple:rounded(body/typicalBody),rangeMultiple:rounded(range/typicalTR),bodyFraction:rounded(body/range),
      closeLocation:rounded(location),baselineThroughMs:history.at(-1).closeTimeMs});
  }
  return out.slice(-3);
}
function levelState(bars,side,level,confirmedAtMs){
  let sweptAtMs=null,brokenAtMs=null;
  for(const b of bars){
    if(b.openTimeMs<confirmedAtMs)continue;
    const high=side==='BUY_SIDE';
    if(high?b.close>level:b.close<level){brokenAtMs=b.closeTimeMs;break;}
    if(sweptAtMs===null&&(high?b.open<=level&&b.high>level&&b.close<level:b.open>=level&&b.low<level&&b.close>level))
      sweptAtMs=b.closeTimeMs;
  }
  return {state:brokenAtMs?'CLOSE_BROKEN':sweptAtMs?'WICK_REJECTION_OBSERVED':'UNBREACHED_SINCE_CONFIRMATION',sweptAtMs,brokenAtMs};
}
function mapLiquidity(bars,structure,range,referencePrice,meanTR,tickSize){
  if(!range||range.location==='FLAT_RANGE')return null;
  const tolerance=Math.max(availablePrice(tickSize)?tickSize:0,(meanTR||0)*POLICY.clusterToleranceTR);
  const pivots=(structure?.pivots||[]).filter(p=>Number.isFinite(Number(p.level))&&Number(p.level)>0&&
    p.confirmedAtMs<=bars.at(-1).closeTimeMs&&p.pivotOpenTimeMs>=range.fromMs);
  const levels=[];
  for(const side of ['BUY_SIDE','SELL_SIDE']){
    const high=side==='BUY_SIDE',edge=high?range.high:range.low;
    const atMs=high?range.highAtMs:range.lowAtMs;
    // Rolling extrema are retrospective boundaries, not pre-existing stop pools.
    levels.push({side,kind:'EXTERNAL_RANGE_BOUNDARY',level:edge,observedAtMs:atMs,location:'BOUNDARY',
      state:'OBSERVED_EXTREMUM',distance:rounded(edge-referencePrice)});
    const candidates=pivots.filter(p=>p.side===(high?'HIGH':'LOW')).sort((a,b)=>a.confirmedAtMs-b.confirmedAtMs);
    const clusters=[];
    for(const p of candidates){
      const level=Number(p.level);
      if(level<=range.low||level>=range.high)continue;
      const existing=clusters.find(c=>Math.max(c.max,level)-Math.min(c.min,level)<=tolerance);
      if(existing){existing.min=Math.min(existing.min,level);existing.max=Math.max(existing.max,level);existing.members.push(p);}
      else clusters.push({min:level,max:level,members:[p]});
    }
    const ranked=clusters.map(c=>{
      const p=c.members.at(-1),level=high?c.max:c.min;
      return {side,kind:c.members.length>1?'INTERNAL_CLUSTER':'INTERNAL_SWING',level,
        lower:c.min,upper:c.max,touches:c.members.length,confirmedAtMs:p.confirmedAtMs,location:'INSIDE_OBSERVED_RANGE',
        ...levelState(bars,side,level,p.confirmedAtMs),distance:rounded(level-referencePrice)};
    }).filter(p=>p.state!=='CLOSE_BROKEN').sort((a,b)=>Math.abs(a.distance)-Math.abs(b.distance)||b.touches-a.touches);
    levels.push(...ranked.slice(0,3));
  }
  return {definition:'PRICE_STRUCTURE_PROXY_NOT_OBSERVED_ORDERS',tolerance:rounded(tolerance),levels};
}
function analyzeAdvancedMarket({evidence,structure,tickSize=null}={}){
  if(!evidence||evidence.schemaVersion!=='candle-evidence-v1'||!Array.isArray(evidence.bars)||
    !Number.isSafeInteger(evidence.quality?.contiguousStart)||evidence.quality.contiguousStart<0||
    evidence.quality.contiguousStart>evidence.bars.length||structure&&structure.evidenceId!==evidence.evidenceId)
    throw Error('Advanced market evidence mismatch');
  const bars=evidence.bars.slice(evidence.quality.contiguousStart);
  const price=bars.at(-1)?.close??null;
  const regime=marketRegime(bars),range=dealingRange(bars,price);
  const volatility=regime.meanTrueRange??null;
  return freeze({methodVersion:METHOD,asOfMs:evidence.asOfMs,throughMs:bars.at(-1)?.closeTimeMs??null,
    source:'VALIDATED_CONTIGUOUS_CLOSED_BARS',bars:bars.length,referencePrice:price,regime,dealingRange:range,
    liquidity:mapLiquidity(bars,structure,range,price,volatility,tickSize),displacements:displacementEvents(bars),
    limitations:['HEURISTIC_NOT_PREDICTION','NO_ORDER_BOOK_OR_STOP_ORDER_PROOF','NO_INTRABAR_SEQUENCE','NO_ENTRY_OR_EXECUTION_SIGNAL']});
}
// Keep historical calculations immutable; position the latest observed terminal
// quote against the same range separately. Never label a synthetic quote as
// executable or use it to confirm a closed candle pattern.
function quoteRangeLocation(advanced,quote){
  const r=advanced?.dealingRange;
  if(!r||r.width<=0||!r.width||quote?.status!=='RECENT_PROVIDER_EVENT'||!availablePrice(quote.bid)||!availablePrice(quote.ask)||quote.ask<quote.bid)return null;
  const mid=(quote.bid+quote.ask)/2;
  const p=(mid-r.low)/(r.high-r.low);
  return {reference:'TERMINAL_BID_ASK_MID',price:rounded(mid),asOfMs:quote.observedAtMs,
    syntheticSpread:quote.isSyntheticSpread,positionPct:rounded(p*100),
    location:p<0?'BELOW_RANGE':p>1?'ABOVE_RANGE':Math.abs(p-.5)<1e-9?'EQUILIBRIUM':p<.5?'DISCOUNT':'PREMIUM',
    region:p<0||p>1?'OUTSIDE_RANGE':p>=.3&&p<=.7?'MIDDLE_40_PERCENT':p<.3?'LOWER_REGION':'UPPER_REGION'};
}
module.exports={analyzeAdvancedMarket,quoteRangeLocation,POLICY};
