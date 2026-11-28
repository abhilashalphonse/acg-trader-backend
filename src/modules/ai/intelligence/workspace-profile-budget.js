'use strict';
const {compactWorkspaceWireEvidence}=require('./workspace-wire-compaction');
// Soft final-wire targets, independent of the approved provider token cap.
// Never force a small payload by removing necessary or uncertain evidence.
const targets=Object.freeze({STRUCTURE:22000,MARKET_OVERVIEW:22000,BOS:19000,FVG:19000,LIQUIDITY:21000,QUOTE:18000,SESSION:18000,CALENDAR:18000});
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function healthy(f){
  const q=f.quality,a=f.advanced;
  return f.status==='HISTORICAL_ONLY'&&q?.status==='RECENT_CLOSED_BAR'&&q.gaps===0&&q.exclusions?.synthetic===0&&
    Number.isSafeInteger(q.contiguousCount)&&q.contiguousCount>=24&&f.freshness?.state==='LATEST_EXPECTED_UTC_BUCKET'&&
    f.coverage?.outOfSessionBars===0&&a?.methodVersion==='advanced-market-intelligence-v1'&&a.regime&&a.dealingRange;
}
// Mutate only the already cloned provider projection. The hard-fit builder
// has already run. Measure the same compact final wire shape after each step.
function fitFocusedContext(data,body){
  const market=data.market,profile=market?.contextSelection?.profile,target=targets[profile];
  if(!target||market?.schemaVersion!=='adaptive-market-v1'||!Array.isArray(market.frames)||
    data.account!==null||market.sizingCalculation)return;
  const size=()=>{
    const copy=structuredClone(data);
    compactWorkspaceWireEvidence(copy.market);
    return bytes({...body,stream:true,stream_options:{include_usage:true},
      messages:[body.messages[0],{...body.messages[1],content:JSON.stringify(copy)}]});
  };
  if(size()<=target)return;
  const secondary=market.frames.filter(f=>f.timeframe!==market.selectedTimeframe&&healthy(f));
  // Non-primary displacement details are supplementary for explicit narrow
  // questions. Preserve the latest event, all core derived summaries and
  // all selected-frame events. Do not change stale/gapped frames.
  for(const f of secondary){
    if(size()<=target)break;
    const a=f.advanced,d=a.displacements;
    if(Array.isArray(d)&&d.length>1){
      a.displacements=d.slice(-1);
      a.omittedDisplacements=(a.omittedDisplacements??0)+d.length-1;
    }
  }
  // Liquidity queries need all retained liquidity records. For other
  // focused intents preserve both range boundaries and the first (ranked
  // nearest) internal reference of each side on supporting frames.
  if(profile!=='LIQUIDITY')for(const f of secondary){
    if(size()<=target)break;
    const a=f.advanced,levels=a.liquidity?.levels;
    if(!Array.isArray(levels)||levels.some(l=>!['EXTERNAL_RANGE_BOUNDARY','INTERNAL_CLUSTER','INTERNAL_SWING'].includes(l.kind)||!['BUY_SIDE','SELL_SIDE'].includes(l.side)))continue;
    const seen=new Set();
    const kept=levels.filter(l=>{
      if(l.kind==='EXTERNAL_RANGE_BOUNDARY')return true;
      if(seen.has(l.side))return false;
      seen.add(l.side);return true;
    });
    if(kept.length<levels.length){
      a.liquidity.levels=kept;
      a.omittedLiquidityLevels=(a.omittedLiquidityLevels??0)+levels.length-kept.length;
    }
  }
  // Do not cut history, task-critical observations, selected-frame evidence,
  // account data, quote/calendar state or raw candles just to hit a target.
  // A target miss is explicit telemetry, not a generation failure.
}
module.exports={fitFocusedContext,targets};
