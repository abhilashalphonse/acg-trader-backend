'use strict';
const {createCandleEvidence,digest,freeze}=require('./candle-evidence');
const {normalizeDecimal}=require('../../../shared/decimal/decimal');
const METHOD='structure-liquidity-v1';
const LIMIT=32;
const price=v=>normalizeDecimal(v);
const tail=items=>items.slice(-LIMIT);
// Only the last uninterrupted provider segment is interpreted. No gap bridging,
// no intrabar order reconstruction, no future confirmation and no order-flow claim.
function analyzeStructure(input){
  const evidence=createCandleEvidence(input);
  const bars=evidence.bars.slice(evidence.quality.contiguousStart);
  const pivots=[],equalLevels=[],events=[],gaps=[];
  const latest={HIGH:null,LOW:null};
  let bias='UNESTABLISHED';
  const emit=(kind,bar,details)=>events.push({kind,atMs:bar.closeTimeMs,...details});
  for(let i=0;i<bars.length;i++){
    const bar=bars[i],prev=bars[i-1];
    // Use only references already confirmed before the current candle.
    for(const side of ['HIGH','LOW']){
      const ref=latest[side];
      if(!ref||ref.broken||!prev)continue;
      const level=ref.level,high=side==='HIGH';
      const crossed=high?prev.close<=level&&bar.close>level:prev.close>=level&&bar.close<level;
      if(crossed){
        const direction=high?'BULLISH':'BEARISH';
        const kind=bias==='UNESTABLISHED'?'INITIAL_BREAK':bias===direction?'BOS':'MSS_PROXY';
        emit(kind,bar,{direction,referenceId:ref.id,level:price(level),close:price(bar.close),
          referenceConfirmedAtMs:ref.confirmedAtMs,gapAtOpen:high?bar.open>level:bar.open<level});
        bias=direction;ref.broken=true;ref.brokenAtMs=bar.closeTimeMs;
      }else if(!ref.swept&&(high?bar.open<=level&&bar.high>level&&bar.close<level:bar.open>=level&&bar.low<level&&bar.close>level)){
        emit('LIQUIDITY_SWEEP_PROXY',bar,{side:high?'BUY_SIDE':'SELL_SIDE',referenceId:ref.id,level:price(level),
          extreme:price(high?bar.high:bar.low),close:price(bar.close),referenceConfirmedAtMs:ref.confirmedAtMs});
        ref.swept=true;ref.sweptAtMs=bar.closeTimeMs;
      }
    }
    // Track previously formed zones only. OHLC proves range intersection,
    // not the sequence of touches or that any liquidity/order was filled.
    for(const g of gaps){
      if(g.invalidatedAtMs!==null)continue;
      const bull=g.direction==='BULLISH';
      const intersects=bar.high>=g.lower&&bar.low<=g.upper;
      if(intersects){
        if(g.firstTouchAtMs===null)g.firstTouchAtMs=bar.closeTimeMs;
        const depth=bull?Math.max(g.lower,bar.low):Math.min(g.upper,bar.high);
        g.deepest=bull?Math.min(g.deepest,depth):Math.max(g.deepest,depth);
        g.touchState=bull?g.deepest<=g.lower?'DISTAL_TOUCHED':g.deepest<g.upper?'PARTIAL_DEPTH':'NEAR_EDGE_TOUCHED'
          :g.deepest>=g.upper?'DISTAL_TOUCHED':g.deepest>g.lower?'PARTIAL_DEPTH':'NEAR_EDGE_TOUCHED';
      }
      if(bull?bar.close<g.lower:bar.close>g.upper){
        g.invalidatedAtMs=bar.closeTimeMs;
        g.invalidationType=intersects?'CLOSE_BEYOND_DISTAL':'GAP_THROUGH_UNOBSERVED';
      }
    }
    if(i>=2){
      const a=bars[i-2];
      const direction=bar.low>a.high?'BULLISH':bar.high<a.low?'BEARISH':null;
      if(direction){
        const lower=direction==='BULLISH'?a.high:bar.high;
        const upper=direction==='BULLISH'?bar.low:a.low;
        gaps.push({id:digest([METHOD,evidence.symbol,evidence.timeframe,'FVG',a.openTimeMs,bar.closeTimeMs,lower,upper]),
          direction,lower,upper,formedAtMs:bar.closeTimeMs,firstTouchAtMs:null,
          deepest:direction==='BULLISH'?upper:lower,touchState:'UNTOUCHED',invalidatedAtMs:null,invalidationType:null});
      }
    }
    if(i>=4){
      const k=i-2,p=bars[k],neighbors=[bars[k-2],bars[k-1],bars[k+1],bars[k+2]];
      for(const side of ['HIGH','LOW']){
        const high=side==='HIGH',level=high?p.high:p.low;
        if(!neighbors.every(b=>high?level>b.high:level<b.low))continue;
        const ref={id:digest([METHOD,evidence.symbol,evidence.timeframe,side,p.openTimeMs,level]),
          side,level,pivotOpenTimeMs:p.openTimeMs,confirmedAtMs:bar.closeTimeMs,
          swept:false,broken:false,sweptAtMs:null,brokenAtMs:null};
        const prior=latest[side];
        if(prior&&prior.level===level)equalLevels.push({side:high?'BUY_SIDE':'SELL_SIDE',level:price(level),
          firstReferenceId:prior.id,secondReferenceId:ref.id,confirmedAtMs:bar.closeTimeMs});
        latest[side]=ref;pivots.push(ref);
      }
    }
  }
  const project=p=>({...p,level:price(p.level)});
  const snapshot={methodVersion:METHOD,evidenceId:evidence.evidenceId,symbol:evidence.symbol,timeframe:evidence.timeframe,
    asOfMs:evidence.asOfMs,latestClosedAtMs:evidence.quality.latestClosedAtMs,quality:evidence.quality,
    status:bars.length<5?'INSUFFICIENT_BARS':'OBSERVED_STRUCTURE',bias,
    activeReferences:Object.values(latest).filter(p=>p&&!p.broken).map(project),
    pivots:tail(pivots).map(project),equalLevels:tail(equalLevels),events:tail(events),
    zones:tail(gaps).map(g=>({...g,lower:price(g.lower),upper:price(g.upper),deepest:price(g.deepest)})),
    totals:{pivots:pivots.length,equalLevels:equalLevels.length,events:events.length,zones:gaps.length},
    limitations:['METHODOLOGY_DEPENDENT','NO_ORDER_BOOK_OR_INSTITUTIONAL_FLOW_PROOF','NO_INTRABAR_SEQUENCE','NO_DISPLACEMENT_FILTER','NO_PREDICTIVE_VALIDATION','NO_EXECUTION_AUTHORITY']};
  return freeze({...snapshot,structureId:digest(snapshot)});
}
module.exports={analyzeStructure,METHOD,LIMIT};
