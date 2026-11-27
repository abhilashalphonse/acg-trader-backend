'use strict';
const {isDeepStrictEqual}=require('node:util');
const {assertIsolated}=require('./providers/credit-ledger-store');
const {createTrustedContextAssembler}=require('./intelligence/trusted-context');
const {createResponseEngine}=require('./intelligence/response-engine');
const {freeze}=require('./intelligence/candle-evidence');
const {AppError}=require('../../shared/errors/app-error');
const deny=(code,statusCode=409)=>new AppError('Workspace report unavailable',{code,statusCode});
const SUPPORTED_FACTS=new Set(['LAST_CLOSED_PRICE','OBSERVED_RANGE_HIGH','OBSERVED_RANGE_LOW','SMA_20','MEAN_TRUE_RANGE_14','CONFIRMED_SWING_HIGH','CONFIRMED_SWING_LOW']);
// A deterministic report rehearsal, not a language model or semantic answer.
// No provider adapter, quote fetch, external export, order or credit mutation.
function createIsolatedWorkspaceAnalysis({source,now=Date.now}={}){
  assertIsolated();
  if(typeof source?.instrument!=='function'||typeof source?.candles!=='function')throw deny('AI_CHAT_CONFIG',503);
  function assertFresh(report){
    const at=now(),r=report?.response;
    if(!r||!Number.isSafeInteger(at)||at<r.verifiedAtMs||at>=r.expiresAtMs)throw deny('AI_RESPONSE_EXPIRED');
  }
  return Object.freeze({
    assertFresh,
    async analyze({scope,workspace,profile,question,authorize}){
      assertIsolated();
      if(!workspace||workspace.includeChartContext!==true||
        !['MARKET_OVERVIEW','STRUCTURE'].includes(profile)||typeof authorize!=='function')
        throw deny('AI_WORKSPACE_INVALID',400);
      const request=freeze({scope:Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,scope[k]])),
        symbol:workspace.symbol,timeframes:[workspace.timeframe],limit:64,sessionWindows:[]});
      const allowed=async r=>{
        assertIsolated();
        if(!isDeepStrictEqual(r,request))return false;
        await authorize();return true;
      };
      const assembler=createTrustedContextAssembler({source:{instrument:s=>source.instrument(s),
        candles:r=>source.candles(r),quote:()=>null},authorize:allowed,now});
      const engine=createResponseEngine({authorize:r=>r.profile===profile&&allowed(r.marketRequest),now});
      try{
        await authorize();
        const context=await assembler.assemble(request);
        const {ticket,prompt}=await engine.prepare({scope:request.scope,profile,question,context});
        const refs=prompt.payload.data.evidence.references;
        const observations=refs.filter(r=>r.type==='FACT'&&SUPPORTED_FACTS.has(r.data.kind)).slice(0,8)
          .map(r=>({referenceId:r.referenceId}));
        const structure=profile==='STRUCTURE'?refs.find(r=>r.type==='STRUCTURE_SUMMARY'):null;
        const interpretations=structure?[{referenceId:structure.referenceId,code:'BREAK_HISTORY'}]:[];
        const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',
          status:observations.length||interpretations.length?'ANSWER':'INSUFFICIENT_EVIDENCE',
          observations,interpretations,education:[]});
        const verified=await engine.verify({ticket,scope:request.scope,candidate});
        if(!verified.verified||!verified.response)throw deny('AI_WORKSPACE_UNVERIFIED');
        const response=verified.response;
        await authorize();
        if(now()>=response.expiresAtMs)throw deny('AI_RESPONSE_EXPIRED');
        return freeze({mode:'DETERMINISTIC_HISTORICAL_REPORT',semanticAnswer:false,
          offlineOnly:true,dispatchAllowed:false,creditDeducted:false,
          source:{provider:context.instrument.provider,scheduleVersion:context.instrument.scheduleVersion},
          response});
      }catch(e){
        if(e instanceof AppError)throw e;
        // Never expose raw data-source errors or prompt contents.
        throw deny('AI_WORKSPACE_UNAVAILABLE');
      }
    },
  });
}
module.exports={createIsolatedWorkspaceAnalysis};
