'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');

const SUPPORTED_ALGS = new Set(['RS256', 'ES256']);
const MAX_TOKEN_LENGTH = 16384;
const MAX_JWKS_LENGTH = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SupabaseTokenVerifier {
  constructor({ projectRef, fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = 300000 } = {}) {
    if (!/^[a-z0-9]{20}$/.test(String(projectRef || ''))) throw new Error('A valid Supabase project reference is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
    this.issuer = `https://${projectRef}.supabase.co/auth/v1`;
    this.jwksUrl = `${this.issuer}/.well-known/jwks.json`;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cacheMs = cacheMs;
    this.keys = new Map();
    this.keysExpiresAt = 0;
    this.refreshPromise = null;
  }

  async verify(token) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw invalidToken();
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(s => !s || !/^[A-Za-z0-9_-]+$/.test(s))) throw invalidToken();
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = parseJsonPart(encodedHeader);
    const payload = parseJsonPart(encodedPayload);
    if (!header || !payload || !SUPPORTED_ALGS.has(header.alg) || typeof header.kid !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(header.kid)) throw invalidToken();
    const key = await this.getKey(header.kid);
    if (!key || (key.alg && key.alg !== header.alg) || (key.use && key.use !== 'sig') ||
      (key.key_ops && !key.key_ops.includes('verify')) ||
      (header.alg === 'RS256' && key.kty !== 'RSA') ||
      (header.alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256'))) throw invalidToken();

    let verified = false;
    try {
      const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
      const signature = Buffer.from(encodedSignature, 'base64url');
      verified = crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`),
        header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, signature);
    } catch { throw invalidToken(); }
    if (!verified) throw invalidToken();

    const nowSeconds = Math.floor(this.now() / 1000);
    if (payload.iss !== this.issuer || payload.aud !== 'authenticated' || payload.role !== 'authenticated' ||
      payload.is_anonymous === true || !UUID.test(String(payload.sub || '')) ||
      !Number.isInteger(payload.exp) || payload.exp <= nowSeconds ||
      !Number.isInteger(payload.iat) || payload.iat > nowSeconds + 60 ||
      (payload.nbf != null && (!Number.isInteger(payload.nbf) || payload.nbf > nowSeconds + 60)) ||
      (payload.session_id != null && !UUID.test(String(payload.session_id)))) throw invalidToken();
    return Object.freeze({ issuer: this.issuer, subject: payload.sub, sessionId: payload.session_id || null });
  }

  async getKey(kid) {
    if (this.now() >= this.keysExpiresAt || !this.keys.has(kid)) await this.refreshKeys();
    return this.keys.get(kid) || null;
  }

  async refreshKeys() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      let response;
      try {
        response = await this.fetchImpl(this.jwksUrl, { signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('JWKS HTTP status');
        const body = await response.text();
        if (body.length > MAX_JWKS_LENGTH) throw new Error('JWKS too large');
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.keys) || parsed.keys.length > 20) throw new Error('Invalid JWKS');
        const keys = new Map();
        for (const key of parsed.keys) {
          if (key && typeof key.kid === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(key.kid)) keys.set(key.kid, key);
        }
        this.keys = keys;
        this.keysExpiresAt = this.now() + this.cacheMs;
      } catch {
        // Never fall back to unsigned validation or a provider-admin/service-role key.
        throw new AppError('Identity verification temporarily unavailable', { statusCode: 503, code: 'IDENTITY_JWKS_UNAVAILABLE' });
      }
    })();
    try { return await this.refreshPromise; } finally { this.refreshPromise = null; }
  }
}

function parseJsonPart(encoded) {
  try {
    if (encoded.length > 8192) return null;
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function invalidToken() { return new AppError('Invalid identity access token', { statusCode: 401, code: 'IDENTITY_TOKEN_INVALID' }); }

module.exports = { SupabaseTokenVerifier };
