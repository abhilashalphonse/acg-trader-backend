'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SupabaseTokenVerifier } = require('../../src/modules/identity/supabase-token-verifier');

const projectRef = 'mwkwvchaqjqtyfgmialk';
const issuer = `https://${projectRef}.supabase.co/auth/v1`;
const subject = '12ee448f-a0fa-4f14-83a2-677dfe11c713';
const sessionId = 'c617a1b1-c36e-41c0-922e-0c57a70cb0b3';
const now = 1800000000000;
const time = Math.floor(now / 1000);

function makeFixture(algorithm = 'RS256') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync(algorithm === 'RS256' ? 'rsa' : 'ec',
    algorithm === 'RS256' ? { modulusLength: 2048 } : { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'signer_1', alg: algorithm, use: 'sig' };
  let calls = 0;
  const verifier = new SupabaseTokenVerifier({
    projectRef, now: () => now,
    fetchImpl: async url => {
      assert.equal(url, `${issuer}/.well-known/jwks.json`);
      calls++;
      return { ok: true, text: async () => JSON.stringify({ keys: [jwk] }) };
    },
  });
  function sign(overrides = {}, headerOverrides = {}) {
    const header = { alg: algorithm, kid: jwk.kid, typ: 'JWT', ...headerOverrides };
    const payload = { iss: issuer, sub: subject, aud: 'authenticated', role: 'authenticated',
      session_id: sessionId, iat: time - 20, exp: time + 600, ...overrides };
    const header64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payload64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const input = `${header64}.${payload64}`;
    const sig = crypto.sign('sha256', Buffer.from(input),
      algorithm === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : privateKey);
    return `${input}.${sig.toString('base64url')}`;
  }
  return { verifier, sign, calls: () => calls };
}

test('valid Supabase RSA session token resolves immutable provider subject', async () => {
  const fx = makeFixture();
  assert.deepEqual(await fx.verifier.verify(fx.sign()), { issuer, subject, sessionId });
  await fx.verifier.verify(fx.sign());
  assert.equal(fx.calls(), 1, 'JWKS is bounded and cached');
});

test('accepts asymmetric ES256 tokens', async () => {
  const fx = makeFixture('ES256');
  assert.equal((await fx.verifier.verify(fx.sign())).subject, subject);
});

test('rejects tampering, unknown issuer, audience, role, anonymous and expiry', async t => {
  const fx = makeFixture();
  const valid = fx.sign();
  const [h, p, s] = valid.split('.');
  const modified = Buffer.from(s, 'base64url');
  modified[0] ^= 1;
  const cases = [
    `${h}.${p}.${modified.toString('base64url')}`,
    fx.sign({ iss: 'https://acgfunded.supabase.co/auth/v1' }),
    fx.sign({ aud: 'service_role' }),
    fx.sign({ role: 'service_role' }),
    fx.sign({ is_anonymous: true }),
    fx.sign({ exp: time - 1 }),
    fx.sign({ iat: time + 600 }),
    fx.sign({ session_id: 'not-a-uuid' }),
    fx.sign({}, { alg: 'none' }),
    fx.sign({}, { kid: 'not-found' }),
  ];
  for (const token of cases) await t.test('invalid token rejected', async () => {
    await assert.rejects(fx.verifier.verify(token), error => error.code === 'IDENTITY_TOKEN_INVALID');
  });
});

test('fails closed when JWKS is unavailable', async () => {
  const fx = makeFixture();
  fx.verifier.fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(fx.verifier.verify(fx.sign()), error => error.code === 'IDENTITY_JWKS_UNAVAILABLE');
});

test('rejects malformed and oversized tokens', async () => {
  const fx = makeFixture();
  await assert.rejects(fx.verifier.verify('oops'), error => error.code === 'IDENTITY_TOKEN_INVALID');
  await assert.rejects(fx.verifier.verify('a'.repeat(16385)), error => error.code === 'IDENTITY_TOKEN_INVALID');
});
