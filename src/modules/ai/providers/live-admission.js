'use strict';
const mongoose=require('mongoose');
const {createHash,randomUUID}=require('node:crypto');
const {LiveControl:C,LiveConsent:S,LiveBudget:B,LiveAttempt:A,LiveEvent:E,models}=require('./live-admission.model');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>integer(v)&&v>0;
const fail=code=>Object.assign(Error('Live AI admission unavailable'),{code});
const check=(x,code='LIVE_AI_INVALID')=>{if(!x)throw fail(code);};
const sum=(a,b)=>{const n=a+b;check(integer(n));return n;};
const cost=(i,o,ir,or)=>{check([i,o,ir,or].every(integer));return sum(i*ir,o*or);};
const keys=['tenantId','actorId','sessionId','accountId','connectionId'];
function scope(v){check(v&&keys.slice(0,4).every(k=>id(v[k]))&&uuid(v.connectionId));return Object.freeze(Object.fromEntries(keys.map(k=>[k,v[k]])));}
const scopeEqual=(a,b)=>keys.every(k=>a[k]===b[k]);
const consentId=s=>hash(['consent',...keys.map(k=>s[k])]);
const attemptId=(s,op)=>hash(['attempt',s.tenantId,s.actorId,s.accountId,op]);
const budgetIds=(s,d)=>[hash(['tenant',s.tenantId,d]),hash(['actor',s.tenantId,s.actorId,d])];
const read=q=>q.read('primary').readConcern('majority').maxTimeMS(2000).lean();
const within=(v,min,max)=>integer(v)&&v>=min&&v<=max;
const tx=async work=>{try{return await mongoose.connection.transaction(work,{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:2000});}
  catch(e){if(typeof e?.code==='string'&&/^LIVE_AI_[A-Z_]+$/.test(e.code))throw e;throw fail('LIVE_AI_STORE_UNCERTAIN');}};
const get=(M,key,session)=>M.findById(key).session(session).maxTimeMS(2000).lean();
async function patch(M,filter,set,session){const r=await M.updateOne(filter,{$set:set},{session,runValidators:true,maxTimeMS:2000});check(r.matchedCount===1,'LIVE_AI_CHANGED');}
async function event(session,s,kind,subject,revision,atMs){await E.create([{_id:randomUUID(),tenantId:s.tenantId,actorId:s.actorId,kind,subject,revision,atMs}],{session});}
// authorizeSession must reauthenticate and return the actual account/connection
// authority, not echo client input. Admin and reconciliation authorities are
// separate; pricing must come from an approved server-owned descriptor.
function createLiveAdmission({authorizeSession,authorizeMarket,authorizeAdmin,authorizeReconciliation,resolvePrice,now=Date.now}={}){
  check([authorizeSession,authorizeMarket,authorizeAdmin,authorizeReconciliation,resolvePrice,now].every(f=>typeof f==='function'));
  function clock(){const t=now();check(positive(t)&&t<8640000000000000);return t;}
  const day=t=>new Date(t).toISOString().slice(0,10);
  async function permitted(s,purpose){check(scopeEqual(s,scope(await authorizeSession(s,purpose))),'LIVE_AI_SCOPE_CHANGED');}
  async function market(s,g,purpose){check(await authorizeMarket(s,{descriptorId:g.descriptorId,policyVersion:g.policyVersion,symbol:g.symbol,timeframe:g.timeframe},purpose)===true,'LIVE_AI_MARKET_DENIED');}
  async function admin(a,purpose){check(id(a?.tenantId)&&id(a?.actorId)&&await authorizeAdmin({tenantId:a.tenantId,actorId:a.actorId},purpose)===true,'LIVE_AI_ADMIN_DENIED');}
  async function liveControl(s,session){const c=await get(C,s.tenantId,session);check(c?.enabled===true,'LIVE_AI_PAUSED');return c;}
  async function guard(s,c,g,t,session){check(g?.active===true&&scopeEqual(s,g)&&g.expiresAtMs>t&&g.controlRevision===c.revision,'LIVE_AI_CONSENT_REQUIRED');
    // Write both documents, not just snapshot reads: concurrent revocation
    // and kill-switch commits conflict with claim/dispatch transactions.
    await patch(C,{_id:c._id,revision:c.revision,fence:c.fence},{fence:sum(c.fence,1)},session);
    await patch(S,{_id:g._id,revision:g.revision,fence:g.fence},{fence:sum(g.fence,1)},session);
  }
  async function budgets(s,d,session){const ids=budgetIds(s,d),rows=[];
    for(let i=0;i<2;i++){const row=await get(B,ids[i],session);rows.push(row??{_id:ids[i],tenantId:s.tenantId,actorId:i?s.actorId:null,day:d,requests:0,reservedPicoUsd:0,settledPicoUsd:0});}return rows;}
  async function reserve(s,d,c,amount,session){
    const rows=await budgets(s,d,session);
    for(let i=0;i<rows.length;i++){const r=rows[i],max=i?c.actorDailyPicoUsd:c.tenantDailyPicoUsd,req=i?c.actorDailyRequests:c.tenantDailyRequests;
      const requests=sum(r.requests,1),reservedPicoUsd=sum(r.reservedPicoUsd,amount);
      check(requests<=req&&sum(reservedPicoUsd,r.settledPicoUsd)<=max,'LIVE_AI_BUDGET_LIMIT');
      if(r.requests===0)await B.create([{...r,requests,reservedPicoUsd}],{session});
      else await patch(B,{_id:r._id,requests:r.requests,reservedPicoUsd:r.reservedPicoUsd,settledPicoUsd:r.settledPicoUsd},{requests,reservedPicoUsd},session);
    }
  }
  async function release(a,actual,session){
    for(const key of budgetIds(a,a.day)){const r=await get(B,key,session);check(r&&r.reservedPicoUsd>=a.reservedPicoUsd,'LIVE_AI_LEDGER_INVALID');
      await patch(B,{_id:key,reservedPicoUsd:r.reservedPicoUsd,settledPicoUsd:r.settledPicoUsd},{reservedPicoUsd:r.reservedPicoUsd-a.reservedPicoUsd,settledPicoUsd:sum(r.settledPicoUsd,actual)},session);}
  }
  return Object.freeze({
    async provision(){for(const m of models){await m.createCollection();await m.createIndexes();}},
    async setControl(actor,{expectedRevision,enabled,tenantDailyPicoUsd,actorDailyPicoUsd,tenantDailyRequests,actorDailyRequests}){
      check(integer(expectedRevision)&&typeof enabled==='boolean'&&[tenantDailyPicoUsd,actorDailyPicoUsd,tenantDailyRequests,actorDailyRequests].every(positive)&&actorDailyPicoUsd<=tenantDailyPicoUsd&&actorDailyRequests<=tenantDailyRequests);
      await admin(actor,'CONTROL');
      return tx(async session=>{await admin(actor,'CONTROL');const c=await get(C,actor.tenantId,session);check((c?.revision??0)===expectedRevision,'LIVE_AI_CHANGED');
        const next={enabled,revision:sum(expectedRevision,1),fence:sum(c?.fence??0,1),tenantDailyPicoUsd,actorDailyPicoUsd,tenantDailyRequests,actorDailyRequests};
        if(c)await patch(C,{_id:actor.tenantId,revision:c.revision,fence:c.fence},next,session);else await C.create([{_id:actor.tenantId,...next}],{session});
        await event(session,actor,'CONTROL',actor.tenantId,next.revision,clock());return {enabled,revision:next.revision};});
    },
    async grant(s0,input){
      const s=scope(s0),{expectedRevision,explicitConsent,descriptorId,policyVersion,symbol,timeframe,expiresAtMs}=input;
      check(integer(expectedRevision)&&explicitConsent===true&&hex(descriptorId)&&hex(policyVersion)&&typeof symbol==='string'&&/^[A-Z0-9._-]{1,32}$/.test(symbol)&&['1m','5m','15m','30m','1h','4h','1d','1w'].includes(timeframe)&&positive(expiresAtMs));
      await permitted(s,'GRANT');
      return tx(async session=>{await permitted(s,'GRANT');await market(s,input,'GRANT');const t=clock();check(expiresAtMs>t&&expiresAtMs-t<=3600000);const c=await liveControl(s,session),key=consentId(s),g=await get(S,key,session);
        check((g?.revision??0)===expectedRevision,'LIVE_AI_CHANGED');await patch(C,{_id:c._id,revision:c.revision,fence:c.fence},{fence:sum(c.fence,1)},session);
        const next={...s,revision:sum(expectedRevision,1),fence:sum(g?.fence??0,1),controlRevision:c.revision,active:true,expiresAtMs,descriptorId,policyVersion,symbol,timeframe};
        if(g)await patch(S,{_id:key,revision:g.revision,fence:g.fence},next,session);else await S.create([{_id:key,...next}],{session});
        await event(session,s,'CONSENT',key,next.revision,t);return {consentId:key,revision:next.revision,expiresAtMs};});
    },
    async revoke(s0,expectedRevision){
      const s=scope(s0);check(positive(expectedRevision));await permitted(s,'REVOKE');
      return tx(async session=>{await permitted(s,'REVOKE');const key=consentId(s),g=await get(S,key,session);check(g&&scopeEqual(s,g)&&g.revision===expectedRevision,'LIVE_AI_CHANGED');
        const revision=sum(g.revision,1);await patch(S,{_id:key,revision:g.revision,fence:g.fence},{active:false,revision,fence:sum(g.fence,1)},session);
        await event(session,s,'REVOKE',key,revision,clock());return {revoked:true,revision};});
    },
    async claim(s0,input){
      const s=scope(s0),{operationId,descriptorId,policyVersion,symbol,timeframe,consentRevision,maxInputTokens,maxOutputTokens}=input;
      check(uuid(operationId)&&hex(descriptorId)&&hex(policyVersion)&&positive(consentRevision)&&within(maxInputTokens,1,32768)&&within(maxOutputTokens,1,4096));
      await permitted(s,'CLAIM');const price=await resolvePrice(descriptorId);
      check(price?.descriptorId===descriptorId&&price.approved===true&&positive(price.inputRatePicoUsd)&&positive(price.outputRatePicoUsd),'LIVE_AI_PRICE_UNAPPROVED');
      const amount=cost(maxInputTokens,maxOutputTokens,price.inputRatePicoUsd,price.outputRatePicoUsd);
      return tx(async session=>{await permitted(s,'CLAIM');const t=clock(),c=await liveControl(s,session),g=await get(S,consentId(s),session);
        check(g?.revision===consentRevision&&g.descriptorId===descriptorId&&g.policyVersion===policyVersion&&g.symbol===symbol&&g.timeframe===timeframe,'LIVE_AI_CONSENT_REQUIRED');
        await market(s,g,'CLAIM');const key=attemptId(s,operationId);check(!await get(A,key,session),'LIVE_AI_ALREADY_CLAIMED');
        await guard(s,c,g,t,session);await reserve(s,day(t),c,amount,session);
        await A.create([{_id:key,...s,operationId,consentId:g._id,consentRevision:g.revision,controlRevision:c.revision,descriptorId,policyVersion,day:day(t),
          reservedPicoUsd:amount,inputRatePicoUsd:price.inputRatePicoUsd,outputRatePicoUsd:price.outputRatePicoUsd,maxInputTokens,maxOutputTokens,
          state:'CLAIMED',createdAtMs:t,updatedAtMs:t}],{session});
        await event(session,s,'CLAIM',key,c.revision,t);return {attemptId:key,reservedPicoUsd:amount};});
    },
    async beginDispatch(s0,operationId){
      const s=scope(s0);check(uuid(operationId));await permitted(s,'DISPATCH');
      return tx(async session=>{await permitted(s,'DISPATCH');const t=clock(),key=attemptId(s,operationId),a=await get(A,key,session),c=await liveControl(s,session),g=await get(S,consentId(s),session);
        check(a&&scopeEqual(a,s)&&a.state==='CLAIMED'&&a.controlRevision===c.revision&&a.consentRevision===g?.revision&&a.day===day(t),'LIVE_AI_DISPATCH_DENIED');
        await market(s,g,'DISPATCH');await guard(s,c,g,t,session);await patch(A,{_id:key,state:'CLAIMED'},{state:'DISPATCHING',updatedAtMs:t},session);
        await event(session,s,'DISPATCH',key,c.revision,t);return {attemptId:key};});
    },
    async assertDisclosure(s0,operationId){
      const s=scope(s0);check(uuid(operationId));await permitted(s,'DISCLOSE');
      const a=await read(A.findById(attemptId(s,operationId))),c=await read(C.findById(s.tenantId)),g=await read(S.findById(consentId(s)));
      check(a&&scopeEqual(a,s)&&['DISPATCHING','SETTLED'].includes(a.state)&&c?.enabled===true&&c.revision===a.controlRevision&&g?.active===true&&g.revision===a.consentRevision&&g.expiresAtMs>clock()&&scopeEqual(g,s),'LIVE_AI_DISCLOSURE_DENIED');
      await market(s,g,'DISCLOSE');await permitted(s,'DISCLOSE');return true;
    },
    // Reconciliation runs independently of consent, session expiry and pause.
    // An authenticated, separately authorized billing worker supplies evidence.
    // Unknown usage stays reserved; never release a dispatch on timeout.
    async reconcile(actor,{attemptId:key,kind,evidenceId,inputTokens,outputTokens}){
      check(id(actor?.tenantId)&&id(actor?.actorId)&&hex(key)&&['UNKNOWN','SETTLE','NOT_SENT'].includes(kind)&&hex(evidenceId));
      check(await authorizeReconciliation(actor,key,kind,evidenceId)===true,'LIVE_AI_RECONCILE_DENIED');
      return tx(async session=>{check(await authorizeReconciliation(actor,key,kind,evidenceId)===true,'LIVE_AI_RECONCILE_DENIED');
        const a=await get(A,key,session);check(a?.tenantId===actor.tenantId,'LIVE_AI_RECONCILE_DENIED');
        const state=kind==='SETTLE'?'SETTLED':kind==='UNKNOWN'?'HELD_UNKNOWN':'NOT_SENT';
        if(a.state===state){check(a.evidenceId===evidenceId&&(kind!=='SETTLE'||a.inputTokens===inputTokens&&a.outputTokens===outputTokens),'LIVE_AI_CHANGED');return {state,actualPicoUsd:a.actualPicoUsd};}
        check(kind==='NOT_SENT'?a.state==='CLAIMED':kind==='UNKNOWN'?a.state==='DISPATCHING':['DISPATCHING','HELD_UNKNOWN'].includes(a.state),'LIVE_AI_RECONCILE_DENIED');
        let actual=null;const fields={state,evidenceId,updatedAtMs:clock()};
        if(kind==='SETTLE'){check(within(inputTokens,0,a.maxInputTokens)&&within(outputTokens,0,a.maxOutputTokens),'LIVE_AI_USAGE_UNVERIFIED');
          actual=cost(inputTokens,outputTokens,a.inputRatePicoUsd,a.outputRatePicoUsd);check(actual<=a.reservedPicoUsd,'LIVE_AI_USAGE_UNVERIFIED');
          Object.assign(fields,{inputTokens,outputTokens,actualPicoUsd:actual});await release(a,actual,session);}
        if(kind==='NOT_SENT'){actual=0;fields.actualPicoUsd=0;await release(a,0,session);}
        await patch(A,{_id:key,state:a.state},fields,session);await event(session,actor,kind,key,a.controlRevision,fields.updatedAtMs);return {state,actualPicoUsd:actual};});
    }
  });
}
module.exports={createLiveAdmission,cost};
