'use strict';
const {z}=require('zod');
const {isDeepStrictEqual}=require('node:util');
const {assertIsolated}=require('./providers/credit-ledger-store');
const {AppError}=require('../../shared/errors/app-error');
const {freeze}=require('./intelligence/candle-evidence');
const TTL_MS=86400000,MAX_CONVERSATIONS=8,MAX_MESSAGES=16;
const deny=(code,statusCode=409)=>new AppError('AI conversation request rejected',{code,statusCode});
const uuid=z.uuid();
const selectionSchema=z.object({providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  descriptorId:z.string().regex(/^[a-f0-9]{64}$/),fundingMode:z.literal('BYO_API')}).strict();
const workspaceSchema=z.object({symbol:z.string().regex(/^[A-Z0-9._-]{1,32}$/),timeframe:z.enum(['1m','5m','15m','30m','1h','4h','1d','1w']),includeChartContext:z.literal(true)}).strict();
const schemas={
  create:z.object({conversationId:uuid,selection:selectionSchema,profile:z.enum(['EDUCATION','MARKET_OVERVIEW','STRUCTURE']),workspace:workspaceSchema.optional()}).strict(),
  list:z.object({}).strict(),
  history:z.object({conversationId:uuid,afterSequence:z.number().int().min(0).max(MAX_MESSAGES).default(0),
    limit:z.number().int().min(1).max(8).default(8)}).strict(),
  append:z.object({conversationId:uuid,messageId:uuid,text:z.string().min(1).max(4096)}).strict(),
  cancel:z.object({conversationId:uuid,messageId:uuid}).strict(),
  analyze:z.object({conversationId:uuid,messageId:uuid}).strict(),
  delete:z.object({conversationId:uuid}).strict(),
};
function parse(op,input){const p=schemas[op]?.safeParse(input);if(!p?.success)throw deny('AI_INVALID_REQUEST',400);return p.data;}
function safeText(q){
  return Buffer.byteLength(q,'utf8')<=4096&&q.trim()&&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q)&&
    !/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:sk-(?:proj-)?|AIza)[A-Za-z0-9_-]{16,}|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(q);
}
const summary=c=>({conversationId:c.conversationId,status:c.status,selection:c.selection,profile:c.profile,workspace:c.workspace??null,
  createdAtMs:c.createdAtMs,updatedAtMs:c.updatedAtMs,expiresAtMs:c.expiresAtMs,messageCount:c.messages.length});
const receipt=(c,m)=>({conversationId:c.conversationId,messageId:m.messageId,sequence:m.sequence,status:m.status,
  createdAtMs:m.createdAtMs,updatedAtMs:m.updatedAtMs,dispatchAllowed:false,creditDeducted:false});
function createIsolatedConversations({store,registry,workspaceAnalysis=null,now=Date.now}={}){
  assertIsolated();
  if(typeof store?.read!=='function'||typeof store?.mutate!=='function'||typeof registry?.resolveForOfflineTest!=='function')
    throw deny('AI_CHAT_CONFIG',503);
  function time(){const v=now();if(!Number.isSafeInteger(v)||v<=0||v>Number.MAX_SAFE_INTEGER-TTL_MS)throw deny('AI_CHAT_CLOCK',503);return v;}
  function live(bucket,at){return (bucket?.conversations||[]).filter(c=>c.expiresAtMs>at);}
  function find(cs,id,deleted=false){const c=cs.find(x=>x.conversationId===id);
    if(!c||(!deleted&&c.status!=='ACTIVE'))throw deny('AI_CHAT_NOT_FOUND',404);return c;}
  function model(s){let d;try{d=registry.resolveForOfflineTest(s);}catch{throw deny('AI_CHAT_MODEL_UNAVAILABLE');}
    if(d.descriptorId!==s.descriptorId)throw deny('AI_CHAT_MODEL_CHANGED');}
  async function execute(scope,op,input,permit){
    assertIsolated();const x=parse(op,input),at=time();
    if(typeof permit!=='function')throw deny('AI_CHAT_CONFIG',503);
    if(op==='analyze'){
      if((typeof workspaceAnalysis?.analyze!=='function'||typeof workspaceAnalysis?.assertFresh!=='function'))throw deny('AI_WORKSPACE_DISABLED',403);
      const bucket=await store.read(scope),c=find(live(bucket,at),x.conversationId);
      if(!c.workspace||c.profile==='EDUCATION')throw deny('AI_WORKSPACE_INVALID',400);
      const m=c.messages.find(v=>v.messageId===x.messageId);
      if(!m||m.status!=='STORED_OFFLINE')throw deny('AI_CHAT_NOT_FOUND',404);
      model(c.selection);
      const fence=async()=>{
        if(time()>=c.expiresAtMs)throw deny('AI_CHAT_EXPIRED');
        const fresh=await store.read(scope);
        if(fresh?.generation!==bucket.generation||fresh?.revision!==bucket.revision)throw deny('AI_CHAT_CHANGED');
      };
      const authorize=async()=>{await permit(c.selection,c.profile,c.workspace);await fence();};
      await authorize();
      const report=await workspaceAnalysis.analyze({scope,workspace:c.workspace,profile:c.profile,question:m.text,authorize});
      return {value:freeze({conversationId:c.conversationId,messageId:m.messageId,workspace:c.workspace,...report}),
        fence:async()=>{await fence();workspaceAnalysis.assertFresh(report);}};
    }
    if(op==='list'||op==='history'){
      const bucket=await store.read(scope),cs=live(bucket,at);
      let value,expiry=null;
      if(op==='list'){
        // Metadata only, omit unauthorized conversations; no text or IDs of denied items.
        const allowed=[];
        for(const c of cs.filter(v=>v.status==='ACTIVE')){
          try{await permit(c.selection,c.profile,c.workspace??null);allowed.push(c);}catch(e){if(e.code!=='AI_CHAT_PURPOSE_DENIED')throw e;}
        }
        expiry=allowed.length?Math.min(...allowed.map(c=>c.expiresAtMs)):null;
        value={conversations:allowed.sort((a,b)=>b.updatedAtMs-a.updatedAtMs||a.conversationId.localeCompare(b.conversationId)).map(summary)};
      }else{
        const c=find(cs,x.conversationId);await permit(c.selection,c.profile,c.workspace??null);expiry=c.expiresAtMs;
        const all=c.messages.filter(m=>m.sequence>x.afterSequence),page=all.slice(0,x.limit);
        value={conversation:summary(c),messages:page.map(m=>({...receipt(c,m),role:'USER',text:m.text})),
          nextAfterSequence:all.length>page.length?page.at(-1).sequence:null};
      }
      return {value:freeze(value),fence:async()=>{
        if(expiry!==null&&time()>=expiry)throw deny('AI_CHAT_EXPIRED',409);
        const fresh=await store.read(scope);
        if((fresh?.generation??null)!==(bucket?.generation??null)||(fresh?.revision??null)!==(bucket?.revision??null)||
          (fresh?.expiresAt?.getTime()??null)!==(bucket?.expiresAt?.getTime()??null))throw deny('AI_CHAT_CHANGED',409);
      }};
    }
    let authorizedConversation=null;
    if(op==='create'){
      if((x.profile==='EDUCATION')===Boolean(x.workspace))throw deny('AI_WORKSPACE_INVALID',400);
      if(x.workspace&&typeof workspaceAnalysis?.analyze!=='function')throw deny('AI_WORKSPACE_DISABLED',403);
      model(x.selection);await permit(x.selection,x.profile,x.workspace??null);
    }
    else if(op!=='delete'&&op!=='cancel'){
      const current=find(live(await store.read(scope),at),x.conversationId);
      model(current.selection);await permit(current.selection,current.profile,current.workspace??null);authorizedConversation=current;
    }
    // Cancel/delete are local safety actions (no text disclosure). They still
    // require the router's current authenticated grant and operation purpose.
    if(op==='append'&&!safeText(x.text))throw deny('AI_QUESTION_RESTRICTED',400);
    return {value:await store.mutate(scope,bucket=>{
      const nowMs=time(),cs=structuredClone(live(bucket,nowMs));
      if(op==='create'){
        const existing=cs.find(c=>c.conversationId===x.conversationId);
        if(existing){
          if(existing.status==='DELETED'||!isDeepStrictEqual(existing.selection,x.selection)||existing.profile!==x.profile||!isDeepStrictEqual(existing.workspace??null,x.workspace??null))
            throw deny('AI_CHAT_IDEMPOTENCY_CONFLICT');
          return {next:null,value:summary(existing)};
        }
        if(cs.length>=MAX_CONVERSATIONS)throw deny('AI_CHAT_CAPACITY',429);
        const c={conversationId:x.conversationId,status:'ACTIVE',selection:x.selection,profile:x.profile,workspace:x.workspace??null,
          createdAtMs:nowMs,updatedAtMs:nowMs,expiresAtMs:nowMs+TTL_MS,messages:[]};
        cs.push(c);return {next:cs,value:summary(c)};
      }
      const c=find(cs,x.conversationId,op==='delete');
      if(op==='delete'){
        if(c.status==='DELETED')return {next:null,value:{conversationId:c.conversationId,deleted:true}};
        c.status='DELETED';c.selection=null;c.profile=null;c.workspace=null;c.messages=[];c.updatedAtMs=nowMs;
        return {next:cs,value:{conversationId:c.conversationId,deleted:true}};
      }
      if(authorizedConversation&&(c.createdAtMs!==authorizedConversation.createdAtMs||c.expiresAtMs!==authorizedConversation.expiresAtMs||!isDeepStrictEqual(c.selection,authorizedConversation.selection)||!isDeepStrictEqual(c.workspace??null,authorizedConversation.workspace??null)))throw deny('AI_CHAT_CHANGED');
      const m=c.messages.find(m=>m.messageId===x.messageId);
      if(op==='cancel'){
        if(!m)throw deny('AI_CHAT_NOT_FOUND',404);
        if(m.status==='CANCELLED')return {next:null,value:receipt(c,m)};
        m.status='CANCELLED';m.updatedAtMs=nowMs;c.updatedAtMs=nowMs;
        return {next:cs,value:receipt(c,m)};
      }
      // Same ID + exact content is idempotent, even after cancellation.
      if(m){if(m.text!==x.text)throw deny('AI_CHAT_IDEMPOTENCY_CONFLICT');return {next:null,value:receipt(c,m)};}
      if(c.messages.length>=MAX_MESSAGES)throw deny('AI_CHAT_CAPACITY',429);
      const message={messageId:x.messageId,sequence:c.messages.length+1,text:x.text,status:'STORED_OFFLINE',
        createdAtMs:nowMs,updatedAtMs:nowMs};
      c.messages.push(message);c.updatedAtMs=nowMs;
      return {next:cs,value:receipt(c,message)};
    })};
  }
  return Object.freeze({execute});
}
module.exports={createIsolatedConversations,schemas,TTL_MS,MAX_CONVERSATIONS,MAX_MESSAGES};
