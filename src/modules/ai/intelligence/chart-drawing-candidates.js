'use strict';
// Phase 8B.1: isolated source-anchored drawing contract. Call only with the
// authorized, uncompressed readAdaptiveMarket result from the server. Never
// hydrate this registry from request bodies, provider text or client candles.
// No chart mutations, provider calls, or financial capabilities are exposed.
const {createHash}=require('node:crypto');
const VERSION='chart-drawing-candidates-v1';
const MAX_CANDIDATES=20,DEFAULT_LIMIT=6,MAX_ACTIONS=8,TTL_MS=10000;
const frames=new Set(['1m','5m','15m','30m','1h','4h','1d','1w']);
const fields=['tenantId','actorId','sessionId','accountId'];
const plain=x=>x!==null&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
const keys=(x,k)=>plain(x)&&Object.keys(x).sort().join(',')===k;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scopeOk=s=>plain(s)&&fields.every(k=>typeof s[k]==='string'&&/^[a-f0-9]{24}$/.test(s[k]));
const price=x=>typeof x==='number'&&Number.isFinite(x)&&x>0&&x<=1e12;
const ms=x=>Number.isSafeInteger(x)&&x>=946684800000&&x<=4102444800000&&x%1000===0;
const clock=x=>Number.isSafeInteger(x)&&x>0;
const deny=()=>Object.assign(new Error('Drawing candidate unavailable'),{code:'AI_DRAWING_CANDIDATE_DENIED'});
const check=x=>{if(!x)throw deny();};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function createDrawingCandidateRegistry({market,scope,chartContextVersion,nowMs}={}){
  check(scopeOk(scope)&&clock(nowMs)&&typeof chartContextVersion==='string'&&/^[a-f0-9]{64}$/.test(chartContextVersion));
  check(market?.schemaVersion==='adaptive-market-v1'&&typeof market.symbol==='string'&&/^[A-Z0-9._-]{1,32}$/.test(market.symbol)&&frames.has(market.selectedTimeframe)&&clock(market.asOfMs)&&nowMs>=market.asOfMs&&nowMs<market.asOfMs+TTL_MS&&Array.isArray(market.frames));
  const selected=market.frames.filter(f=>f?.timeframe===market.selectedTimeframe);
  check(selected.length===1);
  const frame=selected[0], through=frame.freshness?.latestClosedAtMs;
  // Restrict the first increment to fresh, contiguous, non-synthetic
  // closed-bar evidence. Closed-market and partial coverage support can
  // be widened only with explicit session-aware acceptance tests.
  check(frame.status==='HISTORICAL_ONLY'&&frame.quality?.status==='RECENT_CLOSED_BAR'&&frame.quality.gaps===0&&frame.quality.exclusions?.synthetic===0&&frame.coverage?.outOfSessionBars===0&&frame.freshness.state==='LATEST_EXPECTED_UTC_BUCKET'&&ms(through)&&through<=market.asOfMs&&Array.isArray(frame.observations));
  const owner=Object.fromEntries(fields.map(k=>[k,scope[k]]));
  const symbol=market.symbol,timeframe=market.selectedTimeframe;
  const candidates=new Map();
  function add(kind,identity,at,geometry,evidence){
    const sourceId='draw_'+hash([VERSION,symbol,timeframe,kind,identity]).slice(0,32);
    const entry=freeze({sourceId,kind,symbol,timeframe,atMs:at,geometry,evidence});
    if(candidates.has(sourceId)){check(hash(candidates.get(sourceId))===hash(entry));return;}
    candidates.set(sourceId,entry);
  }
  for(const o of frame.observations){
    if(o?.type==='LIQUIDITY_REFERENCE'&&typeof o.id==='string'&&/^[a-f0-9]{64}$/.test(o.id)&&price(o.level)&&ms(o.pivotOpenTimeMs)&&ms(o.confirmedAtMs)&&o.pivotOpenTimeMs<o.confirmedAtMs&&o.confirmedAtMs<=through&&o.swept===false&&o.broken===false&&['HIGH','LOW','BUY_SIDE','SELL_SIDE'].includes(o.side)){
      add('LIQUIDITY_REFERENCE',[o.side,o.pivotOpenTimeMs,o.level],o.confirmedAtMs,{type:'hline',time:o.pivotOpenTimeMs/1000,price:o.level},{side:o.side,confirmedAtMs:o.confirmedAtMs,detectorId:o.id});
    }
    if(o?.type==='FVG_ZONE'&&typeof o.id==='string'&&/^[a-f0-9]{64}$/.test(o.id)&&['BULLISH','BEARISH'].includes(o.direction)&&price(o.lower)&&price(o.upper)&&o.lower<o.upper&&ms(o.formedAtMs)&&o.formedAtMs<through&&o.invalidatedAtMs===null){
      add('FVG_ZONE',[o.direction,o.formedAtMs,o.lower,o.upper],o.formedAtMs,{type:'rectangle',fromTime:o.formedAtMs/1000,toTime:through/1000,lower:o.lower,upper:o.upper},{direction:o.direction,detectorId:o.id});
    }
  }
  // Recency is a deterministic initial ordering, not a calibrated quality score.
  const ordered=[...candidates.values()].sort((a,b)=>b.atMs-a.atMs||a.sourceId.localeCompare(b.sourceId)).slice(0,MAX_CANDIDATES);
  const allowed=new Map(ordered.map(c=>[c.sourceId,c]));
  const expiresAtMs=market.asOfMs+TTL_MS;
  const context=freeze({symbol,timeframe,latestClosedAtMs:through,chartContextVersion,expiresAtMs});
  const bindingOk=(s,v,now)=>scopeOk(s)&&fields.every(k=>s[k]===owner[k])&&v===chartContextVersion&&clock(now)&&now>=nowMs&&now<expiresAtMs;
  return Object.freeze({
    context,
    // Only compact source references need to be supplied to the planner.
    list({limit=DEFAULT_LIMIT}={}){check(Number.isInteger(limit)&&limit>=1&&limit<=MAX_CANDIDATES);return freeze(ordered.slice(0,limit).map(c=>({sourceId:c.sourceId,kind:c.kind,timeframe:c.timeframe,atMs:c.atMs,evidence:c.evidence})));},
    // A fully parsed terminal response only; not a stream fragment or
    // untrusted chat text. The caller must supply authenticated request scope.
    resolve(proposal,{scope:requestScope,chartContextVersion:currentVersion,nowMs:at,signal,complete=false}={}){
      check(complete===true&&!signal?.aborted&&bindingOk(requestScope,currentVersion,at));
      check(keys(proposal,'actionId,actions,chartContextVersion,contractVersion')&&proposal.contractVersion===VERSION&&proposal.chartContextVersion===currentVersion&&typeof proposal.actionId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(proposal.actionId)&&Array.isArray(proposal.actions)&&proposal.actions.length>=1&&proposal.actions.length<=MAX_ACTIONS);
      const seen=new Set();
      const actions=proposal.actions.map(a=>{
        check(keys(a,'action,sourceId')&&a.action==='draw'&&typeof a.sourceId==='string'&&!seen.has(a.sourceId)&&allowed.has(a.sourceId));
        seen.add(a.sourceId);
        const c=allowed.get(a.sourceId);
        return {sourceId:c.sourceId,drawingKey:c.sourceId,sourceTimeframe:timeframe,geometry:c.geometry};
      });
      check(!signal?.aborted);
      return freeze({contractVersion:VERSION,actionId:proposal.actionId,context,actions});
    }
  });
}
module.exports={createDrawingCandidateRegistry,VERSION,MAX_CANDIDATES,DEFAULT_LIMIT,MAX_ACTIONS};
