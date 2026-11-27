'use strict';
// Explicit operator invocation only. Never import into server or CI workflow.
const fs=require('node:fs/promises');
const path=require('node:path');
const {runApprovedSmoke,APPROVAL}=require('../src/modules/ai/providers/openai-live-smoke');
async function main(){
  if(process.env.NODE_ENV!=='acg-ai-live-smoke'||process.env.CI==='true'||
    process.env.ACG_AI_OPENAI_SMOKE_APPROVAL!==APPROVAL)throw Object.assign(Error('Smoke disabled'),{code:'SMOKE_DISABLED'});
  const file=process.env.ACG_AI_OPENAI_SMOKE_RECEIPT;
  if(!file||!path.isAbsolute(file)||path.extname(file)!=='.jsonl')throw Object.assign(Error('Receipt required'),{code:'SMOKE_RECEIPT_REQUIRED'});
  const key=Buffer.from(process.env.ACG_AI_OPENAI_SMOKE_KEY||'','utf8');
  delete process.env.ACG_AI_OPENAI_SMOKE_KEY;
  let handle;
  async function append(value){await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}
  try{
    const result=await runApprovedSmoke({approval:process.env.ACG_AI_OPENAI_SMOKE_APPROVAL,key,
      claim:async v=>{
        // Refuse replay even after an interrupted run. Keep this path on a
        // durable operator-controlled volume. Never automatically delete it.
        handle=await fs.open(file,'wx',0o600);await append(v);
        const parent=await fs.open(path.dirname(file),'r');try{await parent.sync();}finally{await parent.close();}
      },finish:append});
    console.log(JSON.stringify(result));if(result.state!=='VERIFIED')process.exitCode=1;
  }finally{key.fill(0);await handle?.close();}
}
if(require.main===module)main().catch(e=>{
  // Never print an error stack, raw response, headers or key.
  console.error(JSON.stringify({state:'NOT_VERIFIED',code:typeof e?.code==='string'&&/^SMOKE_[A-Z_]+$/.test(e.code)?e.code:'SMOKE_ABORTED'}));
  process.exitCode=1;
});
