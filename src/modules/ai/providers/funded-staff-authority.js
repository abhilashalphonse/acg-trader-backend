'use strict';
const {createHash}=require('node:crypto');
const {staffPreviewAllowed}=require('./staff-preview.routes');
const {TradingAccount}=require('../../accounts/trading-account.model');
const {AppError}=require('../../../shared/errors/app-error');
const deny=()=>new AppError('Staff AI authorization denied',{statusCode:403,code:'AI_FUNDED_STAFF_DENIED'});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
// No email or owner identifiers from request bodies. The configured Funded
// tenant authenticates its user and the existing session service resolves
// fresh account ownership. A separate majority read verifies the selected
// account remains enabled and directly owned by the authenticated owner.
function createFundedStaffAuthority({authService,env=process.env,now=Date.now,accountModel=TradingAccount}={}){
  if(typeof authService?.authenticateSessionToken!=='function')throw deny();
  async function resolve(token,accountId,connectionId){
    const principal=await authService.authenticateSessionToken(token);
    if(!staffPreviewAllowed(principal,accountId,env,now()))throw deny();
    const row=await accountModel.findOne({_id:accountId,tenantId:principal.tenantId,
      ownerExternalRef:principal.ownerExternalRef,status:'ACTIVE',federationEnabled:true})
      .select('_id tenantId ownerExternalRef accountType').read('primary').readConcern('majority').maxTimeMS(2000).lean();
    if(!row||String(row._id)!==accountId||String(row.tenantId)!==principal.tenantId||
      row.ownerExternalRef!==principal.ownerExternalRef||!['DEMO','CHALLENGE','FUNDED'].includes(row.accountType))throw deny();
    // A single actor budget across accounts and sessions for the approved
    // staff email; no linkage to Supabase user IDs or other tenants.
    const actorId=hash(['funded-staff-ai-v1',principal.tenantId,principal.fundedCustomerEmail.trim().toLowerCase()]).slice(0,24);
    return Object.freeze({tenantId:principal.tenantId,actorId,sessionId:principal.sessionId,accountId,connectionId});
  }
  return Object.freeze({resolve});
}
module.exports={createFundedStaffAuthority};
