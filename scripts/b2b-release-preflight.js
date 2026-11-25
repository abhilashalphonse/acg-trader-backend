'use strict';

// READ-ONLY release preflight. Run in an authorized shell with the real
// backend environment (or a restored production backup). Never log URIs,
// service key hashes, user records, event payloads or credentials.
require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  if (process.env.B2B_PREFLIGHT !== '1') throw new Error('Explicit B2B_PREFLIGHT=1 required');
  const slug=String(process.env.B2B_PREFLIGHT_LEGACY_SLUG||'').trim().toLowerCase();
  const clientId=String(process.env.B2B_PREFLIGHT_LEGACY_CLIENT_ID||'').trim();
  const expectedDb=String(process.env.B2B_PREFLIGHT_DATABASE||'').trim();
  if (!slug || !clientId || !expectedDb) throw new Error('Verified legacy slug, connector client ID and expected database are required');
  const railway=/^(1|true|yes|on)$/i.test(process.env.ACG_MONGO_RAILWAY_CUTOVER||'');
  const uri=railway?process.env.RAILWAY_MONGODB_URI:process.env.MONGODB_URI;
  if (!uri) throw new Error('Selected application MongoDB connection is missing');
  await mongoose.connect(uri,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000,maxPoolSize:2});
  const db=mongoose.connection.db;
  if(db.databaseName!==expectedDb)throw new Error('Connected database does not match explicit expected name');
  const tenant=await db.collection('tenants').findOne({slug,status:'ACTIVE'},{projection:{_id:1},maxTimeMS:10000});
  const key=await db.collection('serviceapikeys').findOne({clientId,status:'ACTIVE'},{projection:{tenantId:1,expiresAt:1},maxTimeMS:10000});
  if(!tenant||!key||String(tenant._id)!==String(key.tenantId)||(key.expiresAt&&new Date(key.expiresAt)<=new Date()))throw new Error('Legacy connector and tenant binding do not agree');
  const tenantId=tenant._id;
  const hello=await db.admin().command({hello:1});
  const outbox=db.collection('platformeventoutboxes');
  const [accounts,wrongMetadata,wrongOutbox,pending,dead,indexes]=await Promise.all([
    db.collection('tradingaccounts').countDocuments({tenantId,'metadata.fundedAccountId':{$exists:true,$nin:[null,'']}},{maxTimeMS:10000}),
    db.collection('tradingaccounts').countDocuments({tenantId:{$ne:tenantId},'metadata.fundedAccountId':{$exists:true,$nin:[null,'']}},{maxTimeMS:10000}),
    outbox.countDocuments({tenantId:{$ne:tenantId}},{maxTimeMS:10000}),
    outbox.countDocuments({tenantId,status:'PENDING'},{maxTimeMS:10000}),
    outbox.countDocuments({tenantId,status:'DEAD'},{maxTimeMS:10000}),
    outbox.indexes()
  ]);
  const mismatches={};
  for(const name of ['orders','positions','deals','accountledgers','idempotencyrecords','platformeventoutboxes']){
    const rows=await db.collection(name).aggregate([
      {$lookup:{from:'tradingaccounts',localField:'accountId',foreignField:'_id',as:'owner'}},
      {$match:{$expr:{$or:[{$ne:[{$size:'$owner'},1]},{$ne:['$tenantId',{$arrayElemAt:['$owner.tenantId',0]}]}]}}},
      {$count:'count'}
    ],{maxTimeMS:10000,allowDiskUse:false}).toArray();
    mismatches[name]=rows[0]?.count||0;
  }
  const clean=accounts>0 && wrongMetadata===0 && wrongOutbox===0 && Object.values(mismatches).every(x=>x===0) && Boolean(hello.setName);
  console.log(JSON.stringify({result:clean?'PASS_BINDING_AND_EXISTING_DATA':'REVIEW_REQUIRED',
    database:expectedDb,configuredTarget:railway?'railway':'legacy',replicaSet:Boolean(hello.setName),
    replicaMembers:hello.hosts?.length??null,legacyTenantId:String(tenantId),legacyMappedAccounts:accounts,
    foreignFundedMetadata:wrongMetadata,foreignOutboxRows:wrongOutbox,pending,dead,tenantRecordMismatches:mismatches,
    candidateOutboxIndex:indexes.some(i=>i.key.tenantId===1&&i.key.status===1&&i.key.nextAttemptAt===1)}));
  if(!clean)process.exitCode=1;
}
main().catch(()=>{console.error('B2B read-only preflight failed; inspect connection and explicit binding inputs in authorized shell');process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
