'use strict';
// Isolated Railway runner only. Preserve the original authorization receipt
// across deployment failures. Never retry a claimed request.
const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT='/data',RECEIPT=ROOT+'/luna-single-authorized-20261127.jsonl';
const SERVICE='ed682eab-b46b-4ccd-af7e-1b27dec46b39',ENV='8362c789-033d-4543-9523-39f8a141436a',VOLUME='d78b7fdb-9bd7-4beb-87fc-d425bbe73031';
const emit=(state,extra={})=>console.log(JSON.stringify({state,...extra}));
async function main(){
  const env=process.env;
  const mountinfo=await fs.readFile('/proc/self/mountinfo','utf8').catch(()=> '');
  const checks={service:env.RAILWAY_SERVICE_ID===SERVICE,environment:env.RAILWAY_ENVIRONMENT_ID===ENV,
    volume:env.RAILWAY_VOLUME_ID===VOLUME,mountPath:env.RAILWAY_VOLUME_MOUNT_PATH===ROOT,
    actualMount:mountinfo.split('\n').some(line=>line.split(' ')[4]===ROOT),
    receipt:env.ACG_AI_OPENAI_SMOKE_RECEIPT===RECEIPT,
    approval:env.ACG_AI_OPENAI_SMOKE_APPROVAL==='ONE_SYNTHETIC_OPENAI_REQUEST',
    mode:env.NODE_ENV==='acg-ai-live-smoke'&&env.CI!=='true',
    keyPresent:typeof env.ACG_AI_OPENAI_SMOKE_KEY==='string'&&env.ACG_AI_OPENAI_SMOKE_KEY.length>=20};
  emit('STARTUP_PREFLIGHT',checks);
  if(!Object.values(checks).every(Boolean)){emit('STARTUP_BLOCKED');process.exitCode=1;return;}
  // Any existing file, including a partial/empty claim, blocks dispatch.
  try{
    const st=await fs.lstat(RECEIPT);
    emit('ORIGINAL_CLAIM_EXISTS',{regularFile:st.isFile(),nonempty:st.size>0});
    if(st.isFile()&&st.size>0&&st.size<=4096){
      const lines=(await fs.readFile(RECEIPT,'utf8')).trim().split('\n');
      const records=lines.map(x=>JSON.parse(x));
      const last=records.at(-1);
      if(last?.state==='VERIFIED'&&records.length===2&&records[0]?.state==='CLAIMED'&&records[0]?.attemptId===last.attemptId&&
        last.model==='gpt-6-luna'&&Number.isSafeInteger(last.inputTokens)&&Number.isSafeInteger(last.outputTokens)){
        emit('PREVIOUS_VERIFIED',{model:last.model,inputTokens:last.inputTokens,outputTokens:last.outputTokens});
        return;
      }
      emit('ORIGINAL_ATTEMPT_BLOCKED',{receiptState:['CLAIMED','HELD_UNKNOWN'].includes(last?.state)?last.state:'UNRECOGNIZED'});
    }
    process.exitCode=1;return;
  }catch(e){if(e?.code!=='ENOENT')throw Error('Receipt inspection failed');}
  emit('ORIGINAL_RECEIPT_ABSENT');
  // Prove exclusive creation and persistent write/flush on the original mount.
  // Only a newly created probe is removed; never touch the original receipt.
  const probe=ROOT+'/.exclusive-probe-'+randomUUID();
  let h,created=false,duplicateBlocked=false;
  try{
    h=await fs.open(probe,'wx',0o600);created=true;
    await h.writeFile('one-shot-probe\n');await h.sync();await h.close();h=null;
    try{const second=await fs.open(probe,'wx',0o600);await second.close();}
    catch(e){if(e?.code!=='EEXIST')throw e;duplicateBlocked=true;}
    if(!duplicateBlocked||(await fs.readFile(probe,'utf8'))!=='one-shot-probe\n')throw Error('Exclusive claim failed');
    const dir=await fs.open(ROOT,'r');try{await dir.sync();}finally{await dir.close();}
  }finally{await h?.close();if(created)await fs.unlink(probe);}
  emit('ONE_SHOT_GUARD_VERIFIED',{exclusiveCreate:true,originalReceiptUnchanged:true});
  // Same exact receipt path and original smoke CLI; the CLI atomically claims
  // it with wx/fsync before DNS or HTTPS. No new authorization or second path.
  const child=spawnSync(process.execPath,['scripts/ai-openai-live-smoke.js'],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:25000,maxBuffer:16384});
  // Only forward allowlisted fields, never raw child stdout/stderr.
  for(const line of (child.stdout||'').split('\n').concat((child.stderr||'').split('\n'))){
    try{
      const v=JSON.parse(line);
      if(!['VERIFIED','HELD_UNKNOWN','NOT_VERIFIED'].includes(v.state))continue;
      const safe={};
      if(v.model==='gpt-6-luna')safe.model=v.model;
      if(typeof v.code==='string'&&/^SMOKE_[A-Z_]+$/.test(v.code))safe.code=v.code;
      for(const k of ['inputTokens','outputTokens'])if(Number.isSafeInteger(v[k])&&v[k]>=0)safe[k]=v[k];
      if(v.verification==='REFERENCE_SELECTION_ONLY')safe.verification=v.verification;
      for(const k of ['customerDataExported','acgCreditsDeducted'])if(v[k]===false)safe[k]=false;
      emit(v.state,safe);
    }catch{}
  }
  try{const stat=await fs.lstat(RECEIPT);emit('RECEIPT_PRESERVED',{exists:true,nonempty:stat.size>0});}
  catch{emit('RECEIPT_NOT_CONFIRMED');}
  process.exitCode=child.status===0&&!child.error?0:1;
}
main().catch(()=>{emit('STARTUP_OR_RECEIPT_CHECK_FAILED');process.exitCode=1;});
