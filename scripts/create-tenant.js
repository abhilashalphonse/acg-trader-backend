'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { AuthService } = require('../src/modules/auth/auth.service');

async function main() {
  await connectDatabase();
  const slug = requiredEnv('TENANT_SLUG').toLowerCase();
  const name = process.env.TENANT_NAME || slug;
  const clientId = process.env.TENANT_CLIENT_ID || `${slug}-backend`;
  const scopes = String(process.env.TENANT_SCOPES || 'accounts:write,federation:write').split(',').map(v => v.trim()).filter(Boolean);

  let tenant = await Tenant.findOne({ slug });
  if (!tenant) tenant = await Tenant.create({ name, slug, authModes: ['PASSWORD', 'FEDERATED'] });

  const auth = new AuthService();
  const service = await auth.createServiceApiKey({ tenantId: tenant._id, clientId, scopes, description: 'Prop firm backend integration' });
  console.log(JSON.stringify({ tenant: { id: String(tenant._id), slug: tenant.slug, name: tenant.name }, service }, null, 2));
}

function requiredEnv(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name} is required`); return value; }

main().then(disconnectDatabase).catch(async error => { console.error(error); await disconnectDatabase().catch(() => {}); process.exit(1); });
