'use strict';
const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { env } = require('../src/config/env');
const { PlatformEventOutbox } = require('../src/modules/integration/platform-event-outbox.model');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { buildTenantWebhookRoutes } = require('../src/modules/integration/tenant-webhook-routes');

// Operator-only replay: dry run by default; no cross-tenant replay or event
// payload changes; immutable fact events only. Consumers deduplicate event IDs.
async function main() {
  const tenantId = String(process.env.REPLAY_PLATFORM_TENANT_ID || '');
  const ids = [...new Set(String(process.env.REPLAY_PLATFORM_EVENT_IDS || '').split(',').map(x=>x.trim()).filter(Boolean))];
  const apply = process.env.REPLAY_PLATFORM_APPLY === 'true';
  if (!/^[0-9a-f]{24}$/.test(tenantId) || !ids.length || ids.length > 100) throw new Error('Explicit tenant and 1–100 event IDs required');
  const routes = buildTenantWebhookRoutes(env.platformEvents);
  if (!routes.has(tenantId)) throw new Error('Replay tenant is not configured');
  await connectDatabase();
  if (!await Tenant.exists({_id:tenantId,status:'ACTIVE'})) throw new Error('Replay tenant is not active');
  const run = async session => {
    const filter = { tenantId, eventId: mongoose.trusted({$in:ids}), status:'DEAD',
      eventType:mongoose.trusted({$in:['DEAL_CREATED','ACCOUNT_CONTROLLED']}) };
    const records = await PlatformEventOutbox.find(filter).session(session).lean();
    if (records.length !== ids.length) throw new Error('All requested events must be dead immutable facts for the specified tenant');
    if (apply) {
      const result = await PlatformEventOutbox.updateMany(filter, {$set:{status:'PENDING',attempts:0,nextAttemptAt:new Date(),lastAttemptAt:null,lastError:null,expiresAt:null}}, {session});
      if (result.modifiedCount !== ids.length) throw new Error('Replay state changed; transaction rolled back');
    }
    return records.length;
  };
  const count = await mongoose.connection.transaction(run);
  console.log(JSON.stringify({operation:apply?'REPLAY_SCHEDULED':'REPLAY_DRY_RUN',tenantId,count}));
}
main().catch(error=>{console.error('Platform replay refused:',error.message);process.exitCode=1;}).finally(()=>disconnectDatabase().catch(()=>{}));
