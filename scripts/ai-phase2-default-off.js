'use strict';
const assert=require('node:assert/strict');
const {createApp}=require('../src/app');
const {AuthService}=require('../src/modules/auth/auth.service');
async function main(){
  if(process.env.NODE_ENV!=='test'||process.env.ACG_AI_ISOLATED_CI!=='true')throw Error('Isolated CI only');
  for(const enabled of [false,true]){
    process.env.ACG_AI_READ_GATEWAY_ENABLED=enabled?'true':'false';
    const app=createApp({marketRuntime:{enabled:false,health:()=>({enabled:false})},
      tradingRuntime:{enabled:true,health:()=>({enabled:true})},authRuntime:{authService:new AuthService()}});
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    try{
      const root='http://127.0.0.1:'+server.address().port;
      assert.equal((await fetch(root+'/health/live')).status,200);
      assert.equal((await fetch(root+'/v1/ai/read/tools')).status,enabled?401:404);
      assert.equal((await fetch(root+'/v1/internal/ai/control')).status,enabled?401:404);
      for(const route of ['/v1/ai/intelligence','/v1/ai/context','/v1/ai/response','/v1/ai/chat','/v1/ai/providers','/v1/ai/connections','/v1/ai/credentials','/v1/ai/credits','/v1/ai/credits/purchases','/v1/ai/payments/webhook','/v1/internal/ai/payments/reconcile']){
        assert.equal((await fetch(root+route,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
      }
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  console.log('PASS Phase 2 actual Express app: default-off Phase 1 routes and no public intelligence routes even with Phase 1 flag on');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
