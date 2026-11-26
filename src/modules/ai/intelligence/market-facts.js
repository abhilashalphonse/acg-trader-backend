'use strict';
const {createCandleEvidence,digest,freeze}=require('./candle-evidence');
const {addDecimal,subtractDecimal,divideDecimal,compareDecimal,normalizeDecimal}=require('../../../shared/decimal/decimal');
const METHOD='market-facts-v1';
const mean=values=>divideDecimal(values.reduce((sum,v)=>addDecimal(sum,v),'0'),values.length,{scale:12});
const maxDecimal=values=>values.reduce((a,b)=>compareDecimal(a,b)>=0?a:b);
const absDiff=(a,b)=>compareDecimal(a,b)>=0?subtractDecimal(a,b):subtractDecimal(b,a);

// A deterministic, historical description, not a forecast or executable quote.
function analyzeMarketCandles(input){
  const evidence=createCandleEvidence(input);
  const bars=evidence.bars.slice(evidence.quality.contiguousStart);
  const facts=[];
  function add(kind,value,from,to,details={}){
    const fact={kind,value,unit:'price',fromOpenTimeMs:bars[from].openTimeMs,
      throughCloseTimeMs:bars[to].closeTimeMs,details};
    facts.push({...fact,factId:digest([METHOD,evidence.evidenceId,fact])});
  }
  const n=bars.length;
  if(n){
    const last=bars[n-1];
    add('LAST_CLOSED_PRICE',normalizeDecimal(last.close),n-1,n-1);
    add('OBSERVED_RANGE_HIGH',normalizeDecimal(Math.max(...bars.map(b=>b.high))),0,n-1);
    add('OBSERVED_RANGE_LOW',normalizeDecimal(Math.min(...bars.map(b=>b.low))),0,n-1);
  }
  if(n>=20) add('SMA_20',mean(bars.slice(-20).map(b=>b.close)),n-20,n-1,{periods:20,roundingScale:12});
  if(n>=15){
    const ranges=[];
    for(let i=n-14;i<n;i++){
      const b=bars[i],previous=bars[i-1].close;
      ranges.push(maxDecimal([subtractDecimal(b.high,b.low),absDiff(b.high,previous),absDiff(b.low,previous)]));
    }
    add('MEAN_TRUE_RANGE_14',mean(ranges),n-15,n-1,{periods:14,method:'SIMPLE_MEAN_NOT_WILDER_ATR',roundingScale:12});
  }
  // Fixed two-left/two-right pivots. Confirmation occurs at the close of the
  // second right candle. Ties are not pivots. No lookahead past asOf.
  let lastHigh=-1,lastLow=-1;
  for(let i=2;i<n-2;i++){
    const neighbors=[bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
    if(neighbors.every(b=>bars[i].high>b.high))lastHigh=i;
    if(neighbors.every(b=>bars[i].low<b.low))lastLow=i;
  }
  if(lastHigh>=0)add('CONFIRMED_SWING_HIGH',normalizeDecimal(bars[lastHigh].high),lastHigh-2,lastHigh+2,
    {pivotOpenTimeMs:bars[lastHigh].openTimeMs,confirmationCloseTimeMs:bars[lastHigh+2].closeTimeMs,left:2,right:2});
  if(lastLow>=0)add('CONFIRMED_SWING_LOW',normalizeDecimal(bars[lastLow].low),lastLow-2,lastLow+2,
    {pivotOpenTimeMs:bars[lastLow].openTimeMs,confirmationCloseTimeMs:bars[lastLow+2].closeTimeMs,left:2,right:2});
  // Three consecutive closed bars: strict wick non-overlap. This is only
  // geometry, not proof of institutional flow, mitigation, or entry quality.
  let gap=null;
  for(let i=2;i<n;i++){
    const a=bars[i-2],c=bars[i];
    if(c.low>a.high)gap={i,direction:'BULLISH',lower:a.high,upper:c.low};
    else if(c.high<a.low)gap={i,direction:'BEARISH',lower:c.high,upper:a.low};
  }
  if(gap)add('LAST_THREE_BAR_GAP',subtractDecimal(gap.upper,gap.lower),gap.i-2,gap.i,
    {direction:gap.direction,lower:normalizeDecimal(gap.lower),upper:normalizeDecimal(gap.upper),mitigation:'NOT_EVALUATED'});
  return freeze({methodVersion:METHOD,evidence,analysisScope:'HISTORICAL_CLOSED_BARS_ONLY',
    limitations:['NO_LIVE_QUOTE','NO_EXECUTION_AUTHORITY','NO_PROVIDER_IDENTITY_PROOF','NO_SESSION_OR_COVERAGE_PROOF','NO_PREDICTIVE_VALIDATION'],
    facts});
}
module.exports={analyzeMarketCandles,METHOD};
