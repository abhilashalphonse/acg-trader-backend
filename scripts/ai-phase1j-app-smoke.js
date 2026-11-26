'use strict';
const assert=require('node:assert/strict');
const {createApp}=require('../src/app');
const {AuthService}=require('../src/modules/auth/auth.service');
async function withApp(enabled,work){
  process.env.ACG_AI_READ_GATEWAY_ENABLED=enabled?'true':'false';
  const app=createApp({marketRuntime:{enabled:false,health:()=>({enabled:false})},
    tradingRuntime:{enabled:true,health:()=>({enabled:true})},authRuntime:{authService:new AuthService()}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {await work('http://127.0.0.1:'+server.address().port);}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
async function run(){
  await withApp(false,async root=>{
    assert.equal((await fetch(root+'/v1/ai/read/tools')).status,404);
    assert.equal((await fetch(root+'/v1/internal/ai/control')).status,404);
    assert.equal((await fetch(root+'/health/live')).status,200);
  });
  await withApp(true,async root=>{
    assert.equal((await fetch(root+'/v1/ai/read/tools')).status,401);
    assert.equal((await fetch(root+'/v1/internal/ai/control')).status,401);
    const send=(body,origin='http://localhost:5173')=>fetch(root+'/v1/ai/read/invoke',{method:'POST',headers:{'content-type':'application/json',origin},body});
    assert.equal((await send('{}','https://untrusted.invalid')).status,403);
    assert.equal((await send(JSON.stringify({x:'a'.repeat(9000)}))).status,413);
    assert.equal((await send('{"__proto__":{"x":1}}')).status,400);
    assert.equal((await fetch(root+'/health/live')).status,200);
  });
  console.log('PASS actual app mounting, default-off, authentication, origin and payload boundaries');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
