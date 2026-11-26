'use strict';
const {z}=require('zod');
const {isDeepStrictEqual}=require('node:util');
const {digest,freeze}=require('./candle-evidence');
const {getContextReplay,quoteEvidence}=require('./trusted-context');
const {analyzeMarketCandles}=require('./market-facts');
const {analyzeStructure}=require('./structure-liquidity');
const {analyzeSessionRange}=require('./session-range');
const {classifyCoverage}=require('./calendar-coverage');
const {summarizeTimeframeStructure}=require('./timeframe-structure');
const {compilePromptPackage,INTERPRETATION_CODES}=require('./prompt-compiler');
const MAX_RESPONSE_BYTES=16384;
const id=z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema=z.object({
  schemaVersion:z.literal('candidate-response-v2'),
  status:z.enum(['ANSWER','INSUFFICIENT_EVIDENCE','UNSUPPORTED']),
  observations:z.array(z.object({referenceId:id}).strict()).max(32),
  interpretations:z.array(z.object({referenceId:id,code:z.enum(Object.keys(INTERPRETATION_CODES))}).strict()).max(8),
  education:z.array(z.object({knowledgeId:id}).strict()).max(8),
}).strict();
const scopeKeys=['tenantId','actorId','sessionId','accountId'];
const exactScope=(a,b)=>scopeKeys.every(k=>typeof a?.[k]==='string'&&/^[a-f0-9]{24}$/.test(a[k])&&a[k]===b?.[k]);
const denied=code=>freeze({verified:false,code,response:null});
const unique=arr=>new Set(arr).size===arr.length;
const checkClock=(at,from,until)=>Number.isSafeInteger(at)&&at>=from&&at<until;
function recomputeContext(context,replay){
  const {symbol,asOfMs,completedAtMs}=context;
  const {instrument,request}=replay;
  if(!exactScope(context.scope,request.scope)||symbol!==request.symbol)throw Error('scope');
  const series=replay.series.map(({timeframe,candles})=>{
    const input={symbol,timeframe,asOfMs,candles};
    const analysis=analyzeMarketCandles(input);
    const coverage=classifyCoverage(analysis.evidence,instrument);
    const rejected=coverage.outOfSessionBars>0;
    return {timeframe,coverage,structure:rejected?null:analyzeStructure(input),
      sessions:rejected?[]:request.sessionWindows.filter(w=>w.timeframe===timeframe).map(w=>analyzeSessionRange(input,w)),
      analysis:rejected?null:analysis,status:rejected?'OUT_OF_SESSION_DATA_REJECTED':'HISTORICAL_ONLY'};
  });
  const quote=quoteEvidence(replay.quote,instrument,asOfMs);
  const finalQuote=quote.status==='RECENT_PROVIDER_EVENT'&&completedAtMs>=quote.validUntilMs
    ?{status:'UNAVAILABLE',reason:'QUOTE_EXPIRED_DURING_ASSEMBLY',executable:false}:quote;
  const crossTimeframe=summarizeTimeframeStructure({symbol,asOfMs,series});
  if(!isDeepStrictEqual(series,context.series)||!isDeepStrictEqual(finalQuote,context.quote)||
     !isDeepStrictEqual(crossTimeframe,context.crossTimeframe))throw Error('replay mismatch');
}
const interpretationText=freeze({
  BREAK_HISTORY:'This direction describes observed closed-candle break history, not a predicted trend.',
  SWEEP_OR_BREAK:'This event follows the provisional close-break or sweep rule; it is not proof of actual liquidity or displacement.',
  POTENTIAL_LIQUIDITY:'The confirmed swing is a potential reference, not evidence of resting orders.',
  EQUAL_LEVEL:'The equal swing prices are potential references, not verified order concentration.',
  ZONE_STATE:'Zone state describes observed OHLC geometry; it does not prove fills or mitigation.',
  WINDOW_RANGE:'This is an observed explicit-window range, subject to its coverage status.',
  FRAME_ALIGNMENT:'The comparison describes qualified historical breaks across timeframes, not a probability of future direction.'
});
// Tickets are process-local opaque objects; never accept serialized tickets
// or model-provided context. A future distributed implementation needs a
// server-owned authenticated store and request binding.
function createResponseEngine({authorize,now=Date.now}={}){
  if(typeof authorize!=='function')throw Error('Response authorization required');
  const pending=new WeakMap();
  async function allowed(request){try{return await authorize(request)===true;}catch{return false;}}
  return Object.freeze({
    async prepare({scope,profile,question,context=null}={}){
      const replay=context===null?null:getContextReplay(context);
      if(context!==null&&(!replay||!exactScope(scope,context.scope)))throw Error('Untrusted context');
      const request=freeze({scope:Object.fromEntries(scopeKeys.map(k=>[k,scope?.[k]])),profile,
        marketRequest:replay?.request??null});
      if(!exactScope(request.scope,scope)||!await allowed(request))throw Error('Response forbidden');
      const prompt=compilePromptPackage({scope:request.scope,profile,question,context,nowMs:now()});
      const ticket=Object.freeze({});
      pending.set(ticket,{request,context,replay,prompt,question});
      return {ticket,prompt};
    },
    async verify({ticket,scope,candidate}={}){
      if(!ticket||typeof ticket!=='object')return denied('UNKNOWN_TICKET');
      const state=pending.get(ticket);
      if(!state||!exactScope(scope,state.request.scope))return denied('UNKNOWN_OR_FOREIGN_TICKET');
      // Consume synchronously before any await. No duplicate response delivery.
      pending.delete(ticket);
      const {request,context,replay,prompt,question}=state;
      if(!checkClock(now(),prompt.compiledAtMs,prompt.expiresAtMs))return denied('RESPONSE_EXPIRED');
      if(!await allowed(request))return denied('RESPONSE_FORBIDDEN');
      if(typeof candidate!=='string'||Buffer.byteLength(candidate,'utf8')>MAX_RESPONSE_BYTES)return denied('INVALID_RESPONSE');
      let parsed;
      try{parsed=candidateSchema.safeParse(JSON.parse(candidate));}catch{return denied('INVALID_RESPONSE');}
      if(!parsed.success)return denied('INVALID_RESPONSE');
      const c=parsed.data;
      if(!unique(c.observations.map(v=>v.referenceId))||!unique(c.interpretations.map(v=>v.referenceId))||
         !unique(c.education.map(v=>v.knowledgeId)))return denied('DUPLICATE_REFERENCE');
      const marketCount=c.observations.length+c.interpretations.length;
      if((c.status==='ANSWER'&&marketCount+c.education.length===0)||
        (c.status!=='ANSWER'&&marketCount>0)||(c.status==='UNSUPPORTED'&&c.education.length>0))
        return denied('CONTRADICTORY_RESPONSE');
      let recomputed;
      try{
        if(context)recomputeContext(context,replay);
        recomputed=compilePromptPackage({scope:request.scope,profile:request.profile,question,context,nowMs:prompt.compiledAtMs});
        if(!isDeepStrictEqual(recomputed,prompt))return denied('EVIDENCE_REPLAY_MISMATCH');
      }catch{return denied('EVIDENCE_REPLAY_MISMATCH');}
      const evidence=recomputed.payload.data.evidence;
      const references=new Map((evidence?.references??[]).map(r=>[r.referenceId,r]));
      const knowledge=new Map(recomputed.payload.data.knowledge.entries.map(k=>[k.knowledgeId,k]));
      const observations=[],interpretations=[],education=[];
      for(const v of c.observations){
        const ref=references.get(v.referenceId);
        if(!ref)return denied('UNKNOWN_MARKET_REFERENCE');
        observations.push(ref);
      }
      for(const v of c.interpretations){
        const ref=references.get(v.referenceId);
        if(!ref||INTERPRETATION_CODES[v.code]!==ref.type)return denied('INTERPRETATION_MISMATCH');
        interpretations.push({code:v.code,reference:ref,text:interpretationText[v.code]});
      }
      for(const v of c.education){
        const item=knowledge.get(v.knowledgeId);
        if(!item)return denied('UNKNOWN_KNOWLEDGE_REFERENCE');
        education.push(item);
      }
      if(!await allowed(request))return denied('RESPONSE_FORBIDDEN');
      const verifiedAtMs=now();
      if(!checkClock(verifiedAtMs,prompt.compiledAtMs,prompt.expiresAtMs))return denied('RESPONSE_EXPIRED');
      const response={schemaVersion:'verified-response-v1',status:c.status,
        verification:'RECOMPUTED_REFERENCE_SELECTION_ONLY',symbol:evidence?.symbol??null,asOfMs:evidence?.asOfMs??null,
        verifiedAtMs,expiresAtMs:prompt.expiresAtMs,contextId:evidence?.contextId??null,
        packageId:prompt.packageId,observations,interpretations,education,
        frames:evidence?.frames??[],quoteStatus:evidence?.quoteStatus??'UNAVAILABLE',
        limitations:[...(evidence?.limitations??[]),'NO_EXECUTION_AUTHORITY','NO_PREDICTIVE_VALIDATION',
          'NO_SEMANTIC_RELEVANCE_OR_COMPLETENESS_PROOF','KNOWLEDGE_ENGINEERING_DRAFT','SERVER_RENDERED_SELECTION_ONLY']};
      return freeze({verified:true,response:{...response,responseId:digest(response)}});
    },
  });
}
module.exports={createResponseEngine,MAX_RESPONSE_BYTES};
