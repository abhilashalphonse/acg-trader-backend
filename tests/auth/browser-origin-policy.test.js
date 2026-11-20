'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { approvedBrowserOrigin, rejectUntrustedAuthOrigin } = require('../../src/modules/auth/browser-origin-policy');

const configured = ['https://acgfunded.com', 'http://localhost:5173', '*'];

test('approved first-party origins stay usable for production login without relying on CORS wildcard', () => {
  assert.equal(approvedBrowserOrigin('https://acg-trader.web.app', configured, true), true);
  assert.equal(approvedBrowserOrigin('https://acg-trader.firebaseapp.com', configured, true), true);
  assert.equal(approvedBrowserOrigin('https://acg-trader-frontend-production.up.railway.app', configured, true), true);
  assert.equal(approvedBrowserOrigin('https://acgtrader.com', configured, true), true);
  assert.equal(approvedBrowserOrigin('https://acgfunded.com', configured, true), true);
});

test('credentialed production CORS never trusts arbitrary sites, lookalikes or malformed origins', () => {
  for (const origin of [
    'https://acg-trader.web.app.attacker.example',
    'https://acgtrader.com.evil.example',
    'http://acgtrader.com',
    'https://www.acgtrader.com',
    'https://acgtrader.com:4443',
    'https://evil.example',
    'https://acg-trader.web.app@evil.example',
    'https://acg-trader.web.app/path',
    'https://acg-trader.web.app:8443',
    'null',
    'http://acg-trader.web.app',
    'http://localhost:5173',
    'javascript:alert(1)',
  ]) {
    assert.equal(approvedBrowserOrigin(origin, configured, true), false, origin);
  }
});

test('development wildcard still permits local test origins when explicitly configured', () => {
  assert.equal(approvedBrowserOrigin('http://localhost:5173', configured, false), true);
  assert.equal(approvedBrowserOrigin('https://test.example', configured, false), true);
  assert.equal(approvedBrowserOrigin('null', configured, false), false);
});

function probe(method, origin) {
  const req = { method, headers: origin === undefined ? {} : { origin } };
  const response = { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; } };
  let allowed = false;
  rejectUntrustedAuthOrigin(req, response, () => { allowed = true; }, configured, true);
  return { allowed, response };
}

test('cross-origin login/refresh/logout POST cannot execute for a hostile origin', () => {
  const { allowed, response } = probe('POST', 'https://evil.example');
  assert.equal(allowed, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.error.code, 'UNTRUSTED_AUTH_ORIGIN');
});

test('approved browser logins, non-browser token clients, and read-only GETs keep working', () => {
  assert.equal(probe('POST', 'https://acg-trader.web.app').allowed, true);
  assert.equal(probe('POST', undefined).allowed, true);
  assert.equal(probe('GET', 'https://evil.example').allowed, true);
});
