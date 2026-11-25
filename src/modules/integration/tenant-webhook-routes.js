'use strict';
const { validatePartnerUrl } = require('./safe-partner-fetch');
const EVENT_TYPES = Object.freeze(['ACCOUNT_SNAPSHOT','DEAL_CREATED','ACCOUNT_CONTROLLED']);

// Operator-owned routes only. Never derive a destination from an account,
// a request payload, or a partner-controlled metadata field.
function buildTenantWebhookRoutes({ legacyTenantId, webhookUrl, webhookSecret, partnerRoutes = [], enabled }) {
  const routes = new Map();
  if (!enabled) return routes;
  if (!Array.isArray(partnerRoutes) || partnerRoutes.length > 15) throw new Error('Invalid partner webhook routes');
  function add(tenantId, url, secret, legacy, keyId = null, eventTypes = EVENT_TYPES) {
    if (typeof tenantId !== 'string' || !/^[0-9a-f]{24}$/.test(tenantId) || routes.has(tenantId)) throw new Error('Invalid or duplicate webhook tenant ID');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid partner webhook URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Partner webhook requires HTTPS without credentials or fragments');
    if (!legacy) validatePartnerUrl(parsed.href);
    if (typeof secret !== 'string' || secret.length < 16 || /^</.test(secret)) throw new Error('Invalid partner webhook signing secret');
    if (keyId != null && (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId))) throw new Error('Invalid webhook key ID');
    if (!Array.isArray(eventTypes) || !eventTypes.length || eventTypes.some(t => !EVENT_TYPES.includes(t)) || new Set(eventTypes).size !== eventTypes.length) throw new Error('Invalid webhook event subscriptions');
    for (const existing of routes.values()) {
      if (existing.url === parsed.href || existing.secret === secret) throw new Error('Partner webhook destinations and secrets must be distinct');
    }
    routes.set(tenantId, Object.freeze({ url: parsed.href, secret, legacy, keyId, eventTypes: Object.freeze([...eventTypes]) }));
  }
  if (legacyTenantId || webhookUrl || webhookSecret) add(legacyTenantId, webhookUrl, webhookSecret, true);
  for (const route of partnerRoutes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Invalid partner webhook route');
    add(route.tenantId, route.url, route.secret, false, route.keyId, route.eventTypes);
  }
  if (!routes.size) throw new Error('Enabled webhook relay requires at least one tenant route');
  return routes;
}

function parsePartnerRoutes(value) {
  if (!value) return [];
  try {
    const result = JSON.parse(value);
    if (!Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Error('Invalid PARTNER_WEBHOOK_ROUTES_JSON'); }
}
module.exports = { buildTenantWebhookRoutes, parsePartnerRoutes };
