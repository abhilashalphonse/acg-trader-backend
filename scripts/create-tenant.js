'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { AuthService } = require('../src/modules/auth/auth.service');

async function main() {
  await connectDatabase();
  const slug = requiredEnv('TENANT_SLUG').toLowerCase();
  const name = process.env.TENANT_NAME || slug;
  const clientId = process.env.TENANT_CLIENT_ID || `${slug}-backend`;
  const scopes = [...new Set(requiredEnv('TENANT_SCOPES').split(',').map(v => v.trim()).filter(Boolean))];
  const genericScopes = new Set(['accounts:provision','accounts:read','accounts:control','accounts:observe','risk:write','risk:read','risk:control','ledger:read','ledger:write','credentials:write','grants:write','federation:write','trades:read','reports:read','reports:reconcile']);
  if (!scopes.length || scopes.some(s => !genericScopes.has(s))) throw new Error('Explicit granular partner scopes required; legacy and wildcard keys are not issued by this command');

  let tenant = await Tenant.findOne({ slug });
  if (!tenant) tenant = await Tenant.create({ name, slug, authModes: ['PASSWORD', 'FEDERATED'] });

  if (tenant.status !== 'ACTIVE') throw new Error('Cannot issue keys to a disabled tenant');
  const auth = new AuthService();
  const service = await auth.createServiceApiKey({ tenantId: tenant._id, clientId, scopes, description: 'Prop firm backend integration' });
  console.log(JSON.stringify({ tenant: { id: String(tenant._id), slug: tenant.slug, name: tenant.name }, service }, null, 2));
}

function requiredEnv(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name} is required`); return value; }

main().then(disconnectDatabase).catch(async error => { console.error(error); await disconnectDatabase().catch(() => {}); process.exit(1); });
