'use strict';
const express=require('express');
const {z}=require('zod');
const {requireTraderSession}=require('../../auth/auth.middleware');
const {aiSafeError}=require('../ai-http-security');
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const email=v=>typeof v==='string'&&v.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())?v.trim().toLowerCase():null;
// Preview only, not an inference entitlement. Trust only freshly authenticated
// Funded federation sessions from the configured tenant, never client email,
// account metadata or an arbitrary email claim in a browser request.
function staffPreviewAllowed(principal,accountId,env=process.env,now=Date.now()){
  const approved=email(env.ACG_AI_STAFF_PREVIEW_EMAIL);
  return env.ACG_AI_STAFF_PREVIEW_ENABLED==='true'&&id(env.ACG_AI_STAFF_PREVIEW_TENANT_ID)&&!!approved&&
    principal?.authMethod==='FEDERATED'&&principal.tenantId===env.ACG_AI_STAFF_PREVIEW_TENANT_ID&&
    email(principal.fundedCustomerEmail)===approved&&typeof principal.ownerExternalRef==='string'&&!!principal.ownerExternalRef.trim()&&
    id(principal.sessionId)&&id(accountId)&&Array.isArray(principal.accountIds)&&principal.accountIds.includes(accountId)&&
    [principal.expiresAt,principal.refreshExpiresAt,principal.idleExpiresAt].every(v=>Date.parse(v)>now);
}
function createStaffPreviewRouter({authService,env=process.env,runtimeAvailable=()=>false}){
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/capability',requireTraderSession(authService),(req,res)=>{
    const parsed=z.object({accountId:z.string().regex(/^[a-f0-9]{24}$/)}).strict().safeParse(req.query);
    const eligible=parsed.success&&staffPreviewAllowed(req.traderPrincipal,parsed.data.accountId,env);
    res.json({contractVersion:'staff-ai-preview-v1',previewEnabled:eligible===true,runtimeEnabled:eligible===true&&runtimeAvailable()===true});
  });
  router.use(aiSafeError);
  return router;
}
module.exports={createStaffPreviewRouter,staffPreviewAllowed};
