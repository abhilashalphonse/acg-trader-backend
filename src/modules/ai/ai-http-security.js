'use strict';
const express = require('express');
const { AppError } = require('../../shared/errors/app-error');
const reject = (code,statusCode=400) => new AppError('Invalid AI request',{code,statusCode});
const forbidden = new Set(['__proto__','prototype','constructor']);
function validateInput(value,depth=0,budget={nodes:0},maxStringLength=512) {
  if (++budget.nodes>128 || depth>5) throw reject('AI_INPUT_TOO_COMPLEX');
  if (value===null || typeof value==='boolean') return;
  if (typeof value==='string') {
    if (value.length>maxStringLength) throw reject('AI_INPUT_TOO_COMPLEX');
    return;
  }
  if (typeof value==='number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length>16) throw reject('AI_INPUT_TOO_COMPLEX');
    for (const v of value) validateInput(v,depth+1,budget,maxStringLength);
    return;
  }
  if (typeof value!=='object' || Object.getPrototypeOf(value)!==Object.prototype) throw reject('AI_INVALID_INPUT');
  const keys=Object.keys(value);
  if (keys.length>16) throw reject('AI_INPUT_TOO_COMPLEX');
  for(const key of keys) {
    if (key.length>64 || forbidden.has(key) || key.startsWith('$') || key.includes('.')) throw reject('AI_INVALID_INPUT');
    validateInput(value[key],depth+1,budget,maxStringLength);
  }
}
function aiInputGuard(req,_res,next,maxStringLength=512) {
  try {
    if (req.body!==undefined) validateInput(req.body,0,{nodes:0},maxStringLength);
    // Only the administrative audit list accepts query parameters; route schema validates those.
    validateInput({...req.query});
    next();
  } catch(error){next(error);}
}
function aiJsonBoundary({maxStringLength=512}={}) {
  if(![512,4096].includes(maxStringLength))throw Error('Invalid AI string bound');
  const router=express.Router();
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !req.is('application/json')) return next(reject('AI_JSON_REQUIRED',415));
    next();
  });
  router.use(express.json({limit:'8kb',inflate:false,strict:true}));
  router.use((req,res,next)=>aiInputGuard(req,res,next,maxStringLength));
  router.use(aiSafeError);
  return router;
}
const safeCode = code => typeof code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code);
function aiSafeError(error,req,res,next) {
  if (res.headersSent) return next(error);
  const raw=Number(error.statusCode||error.status);
  const status=Number.isInteger(raw)&&raw>=400&&raw<=599?raw:500;
  const code=error instanceof AppError && safeCode(error.code) && status<500
    ? error.code : status===413?'AI_PAYLOAD_TOO_LARGE':status===415?'AI_UNSUPPORTED_MEDIA':status>=500?'AI_UNAVAILABLE':'AI_INVALID_REQUEST';
  // Isolated acceptance only: emit a bounded error code and source location,
  // never the message, payload, full stack or credential. Production is unchanged.
  if(process.env.NODE_ENV==='test'&&process.env.ACG_AI_ISOLATED_CI==='true'&&req.path==='/generate'&&status>=500){
    const frame=String(error.stack??'').split('\n').slice(1).find(v=>/\/src\/modules\/ai\//.test(v));
    const location=frame?.match(/\/src\/modules\/ai\/([A-Za-z0-9_./-]+:\d+:\d+)/)?.[1]??'unknown';
    console.log('AI_ISOLATED_GENERATE_FAILURE',safeCode(error.code)?error.code:error.name==='TypeError'?'TYPE_ERROR':'UNCLASSIFIED',location);
  }
  // Never log the raw error, body, URL or credential here.
  req.log?.[status>=500?'error':'warn']({statusCode:status,code},'AI request rejected');
  res.setHeader('Cache-Control','no-store');
  res.status(status).json({error:{code,message:status>=500?'AI service unavailable':'AI request rejected'}});
}
function createConcurrencyGate(max=12) {
  if (!Number.isSafeInteger(max)||max<1) throw new Error('Invalid AI concurrency limit');
  let active=0;
  return async function run(work) {
    if (active>=max) throw reject('AI_BUSY',429);
    active++;
    try{return await work();}finally{active--;}
  };
}
module.exports={validateInput,aiInputGuard,aiJsonBoundary,aiSafeError,createConcurrencyGate};
