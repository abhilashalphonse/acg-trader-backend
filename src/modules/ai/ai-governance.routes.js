'use strict';
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { requireServicePrincipal } = require('../auth/auth.middleware');
const { AppError } = require('../../shared/errors/app-error');
const { rateLimit } = require('express-rate-limit');
const patch = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),
  enabled: z.boolean(),
  reason: z.enum(['PILOT_APPROVAL','INCIDENT_RESPONSE','MAINTENANCE','SECURITY_REVIEW','OPERATOR_SUSPENSION']),
}).strict();
const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Invalid AI governance request', { statusCode:400, code:'AI_INVALID_REQUEST' });
  return result.data;
}
function exactScope(scope) {
  return (req,_res,next) => {
    const p=req.servicePrincipal;
    if (!p?.scopes?.includes(scope) || typeof p.tenantId!=='string' || !/^[a-f0-9]{24}$/.test(p.tenantId)) {
      return next(new AppError('AI governance scope required',{statusCode:403,code:'AI_GOVERNANCE_FORBIDDEN'}));
    }
    next();
  };
}
function createAiGovernanceRouter({ authService, store }) {
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const auth=scope=>[requireServicePrincipal(authService,scope),exactScope(scope),
    rateLimit({windowMs:60000,limit:30,standardHeaders:true,legacyHeaders:false,
      keyGenerator:req=>'ai-governance:'+req.servicePrincipal.tenantId+':'+req.servicePrincipal.clientId})];
  router.get('/control',...auth('ai:governance:read'),async(req,res)=>{
    const c=await store.control(req.servicePrincipal.tenantId);
    res.json({enabled:c.enabled===true,revision:c.revision});
  });
  router.patch('/control',...auth('ai:governance:write'),async(req,res)=>{
    const body=parse(patch,req.body);
    const p=req.servicePrincipal;
    const actorId=crypto.createHash('sha256').update(p.clientId).digest('hex');
    res.json(await store.updateControl({...body,tenantId:p.tenantId,actorId}));
  });
  router.get('/audit',...auth('ai:audit:read'),async(req,res)=>{
    const {limit}=parse(query,req.query);
    const rows=await store.list(req.servicePrincipal.tenantId,limit);
    res.json({events:rows.map(r=>({
      id:r._id,tenantId:r.tenantId,actorId:r.actorId,sessionId:r.sessionId,
      requestedAccountId:r.requestedAccountId,operation:r.operation,toolId:r.toolId,
      stage:r.stage,reason:r.reason,revision:r.revision,enabled:r.enabled,occurredAt:r.occurredAt,
    }))});
  });
  return router;
}
module.exports={createAiGovernanceRouter};
