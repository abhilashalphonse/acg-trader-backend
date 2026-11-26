'use strict';
const {z}=require('zod');
const {freeze}=require('../intelligence/candle-evidence');
const {CONTRACT_VERSION}=require('./provider-contract');
const {meterOfflineUsage}=require('./compute-pricing');
const count=z.number().int().min(0).max(1000000000);
const money=z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
const policySchema=z.object({
  maxInputTokens:count.min(1),maxOutputTokens:count.min(1),maxRequestsPerUtcDay:count.min(1),
  maxTokensPerUtcDay:count.min(1),maxCostPicoUsdPerRequest:money.nullable(),maxCostPicoUsdPerUtcDay:money.nullable(),
}).strict();
const id=z.string().regex(/^[a-f0-9]{24}$/);
const scopeSchema=z.object({tenantId:id,actorId:id,sessionId:id,accountId:id}).strict();
const DAY=86400000;
function fail(code){throw Object.assign(Error('Compute budget unavailable'),{code});}
const add=(a,b)=>a+b;
const zero=()=>({requests:0,tokens:0,cost:0n,holds:0});
const owner=s=>[s.tenantId,s.actorId];
function parse(s,v){const p=s.safeParse(v);if(!p.success)fail('BUDGET_REQUEST_INVALID');return p.data;}
// Offline process-local budget reference. No claim of distributed or durable
// enforcement. Owner totals combine models/providers; funding modes separate.
function createOfflineBudget({policies,now=Date.now,maxBuckets=1024,maxLeases=4096}={}){
  if(!Number.isSafeInteger(maxBuckets)||maxBuckets<1||maxBuckets>8192||
    !Number.isSafeInteger(maxLeases)||maxLeases<1||maxLeases>16384)fail('BUDGET_CONFIG_INVALID');
  const config=parse(z.object({BYO_API:policySchema,ACG_CREDITS:policySchema}).strict(),policies);
  const buckets=new Map(),leases=new Map();
  let lastDay=-1;
  function day(){
    const t=now();if(!Number.isSafeInteger(t)||t<=0)fail('BUDGET_CLOCK_INVALID');
    const d=Math.floor(t/DAY);if(d<lastDay)fail('BUDGET_CLOCK_ROLLBACK');
    lastDay=d;return d;
  }
  function scopeKey(s,f,d){return JSON.stringify([...owner(s),f,d]);}
  function leaseOf(ticket){const l=leases.get(ticket);if(!l)fail('BUDGET_LEASE_INVALID');return l;}
  function release(l,tokens,cost,request){
    l.bucket.tokens-=l.tokens-tokens;l.bucket.cost-=l.cost-cost;
    l.bucket.requests-=1-request;l.bucket.holds--;
    leases.delete(l.ticket);
  }
  function prune(d){
    // Only finished days with no outstanding ambiguity may be removed.
    for(const [key,b] of buckets)if(b.day<d&&b.holds===0)buckets.delete(key);
  }
  return Object.freeze({
    reserve({scope,request:q,pricingSnapshot:s}={}){
      const identity=parse(scopeSchema,scope);
      if(q?.contractVersion!==CONTRACT_VERSION||q.executionMode!=='OFFLINE_TEST_ONLY'||
        !Object.hasOwn(config,q.fundingMode))fail('BUDGET_REQUEST_INVALID');
      const p=config[q.fundingMode],input=parse(count,q.budget?.inputTokenUpperBound),
        output=parse(count,q.budget?.maxOutputTokens),tokens=add(input,output);
      if(!input||!output||input>p.maxInputTokens||output>p.maxOutputTokens)fail('BUDGET_REQUEST_LIMIT');
      const priced=p.maxCostPicoUsdPerRequest!==null||p.maxCostPicoUsdPerUtcDay!==null;
      if(priced&&(!s||s.requestId!==q.requestId||s.fundingMode!==q.fundingMode||s.descriptorId!==q.descriptorId||
        !money.safeParse(s.upperBoundPicoUsd).success))fail('BUDGET_PRICE_REQUIRED');
      if(priced)try{meterOfflineUsage(q,s,{status:'UNKNOWN'});}catch{fail('BUDGET_PRICE_REQUIRED');}
      const cost=priced?BigInt(s.upperBoundPicoUsd):0n;
      if(p.maxCostPicoUsdPerRequest!==null&&cost>BigInt(p.maxCostPicoUsdPerRequest))fail('BUDGET_REQUEST_LIMIT');
      const d=day(),key=scopeKey(identity,q.fundingMode,d);prune(d);
      // Unresolved attempts from earlier UTC days remain charged to admission
      // as well, preventing midnight from erasing an uncertain liability.
      let carryTokens=0,carryCost=0n,carryRequests=0;
      for(const l of leases.values())if(l.owner===JSON.stringify(owner(identity))&&l.funding===q.fundingMode&&l.bucket.day<d){
        carryTokens+=l.tokens;carryCost+=l.cost;carryRequests++;
      }
      const b=buckets.get(key)??{...zero(),day:d};
      if(b.requests+carryRequests+1>p.maxRequestsPerUtcDay||b.tokens+carryTokens+tokens>p.maxTokensPerUtcDay||
        p.maxCostPicoUsdPerUtcDay!==null&&b.cost+carryCost+cost>BigInt(p.maxCostPicoUsdPerUtcDay))fail('BUDGET_DAILY_LIMIT');
      if((!buckets.has(key)&&buckets.size>=maxBuckets)||leases.size>=maxLeases)fail('BUDGET_CAPACITY');
      const ticket=Object.freeze({});
      b.requests++;b.tokens+=tokens;b.cost+=cost;b.holds++;buckets.set(key,b);
      leases.set(ticket,{ticket,bucket:b,tokens,cost,input,output,priced,requestId:q.requestId,
        snapshotId:s?.snapshotId??null,owner:JSON.stringify(owner(identity)),funding:q.fundingMode,attempted:false});
      return ticket;
    },
    markAttempt(ticket){const l=leaseOf(ticket);if(l.attempted)fail('BUDGET_ALREADY_ATTEMPTED');l.attempted=true;},
    releaseBeforeAttempt(ticket){const l=leaseOf(ticket);if(l.attempted)fail('BUDGET_ALREADY_ATTEMPTED');release(l,0,0n,0);},
    settle(ticket,{outcome,metering}={}){
      const l=leaseOf(ticket);if(!l.attempted)fail('BUDGET_NOT_ATTEMPTED');
      // A definitive result only. Ambiguous or over-bound outcomes retain
      // the full planning hold, including across UTC day rollover.
      const u=outcome?.usage;
      if(outcome?.requestId!==l.requestId||!['COMPLETED','REFUSED','INCOMPLETE','FAILED'].includes(outcome.status)||
        outcome.usageDisposition!=='UNSETTLED'||u?.status!=='PROVIDER_REPORTED'||
        !count.safeParse(u.inputTokens).success||!count.safeParse(u.outputTokens).success||
        u.inputTokens>l.input||u.outputTokens>l.output||u.totalTokens!==u.inputTokens+u.outputTokens)
        return freeze({status:'HELD_FOR_RECONCILIATION'});
      let cost=0n;
      if(l.priced){
        if(metering?.status!=='CALCULATED_OFFLINE'||metering.requestId!==l.requestId||metering.snapshotId!==l.snapshotId||
          !money.safeParse(metering.costPicoUsd).success||BigInt(metering.costPicoUsd)>l.cost)
          return freeze({status:'HELD_FOR_RECONCILIATION'});
        cost=BigInt(metering.costPicoUsd);
      }
      release(l,u.totalTokens,cost,1);
      return freeze({status:'ACCOUNTED_OFFLINE',tokens:u.totalTokens,costPicoUsd:l.priced?cost.toString():null});
    },
    usage(scope,fundingMode){
      const s=parse(scopeSchema,scope);if(!Object.hasOwn(config,fundingMode))fail('BUDGET_REQUEST_INVALID');
      const d=day(),b=buckets.get(scopeKey(s,fundingMode,d))??zero();
      let carryRequests=0,carryTokens=0,carryCost=0n;
      for(const l of leases.values())if(l.owner===JSON.stringify(owner(s))&&l.funding===fundingMode&&l.bucket.day<d){
        carryRequests++;carryTokens+=l.tokens;carryCost+=l.cost;
      }
      const priced=config[fundingMode].maxCostPicoUsdPerRequest!==null||config[fundingMode].maxCostPicoUsdPerUtcDay!==null;
      return freeze({utcDay:d,requests:b.requests,tokens:b.tokens,costPicoUsd:priced?b.cost.toString():null,
        outstandingHolds:b.holds,carriedHolds:carryRequests,carriedTokens:carryTokens,
        carriedCostPicoUsd:priced?carryCost.toString():null,offlineOnly:true});
    },
  });
}
module.exports={createOfflineBudget};
