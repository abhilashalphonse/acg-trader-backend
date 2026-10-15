'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { createRailwayRateLimitIdentity } = require('../../src/shared/http/rate-limit-identity');
const identity = createRailwayRateLimitIdentity(['192.0.2.10/32']);
const request = (peer, real, extra = {}) => ({
  socket: { remoteAddress: peer }, headers: { 'x-real-ip': real, ...extra },
});
test('trusted edge uses real client rather than intermediate XFF hop', () => {
  assert.equal(identity(request('::ffff:192.0.2.10', '198.51.100.1', {
    'x-forwarded-for': '198.51.100.1, 203.0.113.20',
  })), 'ingress:198.51.100.1');
});
test('untrusted private or direct callers cannot rotate identity using headers', () => {
  for (const peer of ['10.0.0.2', 'fd12::2', '203.0.113.2']) {
    assert.equal(identity(request(peer, '198.51.100.1')), identity(request(peer, '198.51.100.2')));
  }
});
test('trusted ingress requires exactly one valid IP', () => {
  for (const value of [undefined, '', 'bad', '198.51.100.1, 198.51.100.2', ['198.51.100.1'], '198.51.100.1:443']) {
    assert.throws(() => identity(request('192.0.2.10', value)), { code: 'CLIENT_IDENTITY_UNAVAILABLE' });
  }
});
test('IPv4-mapped IPv6 and alternate IPv6 spellings cannot evade buckets', () => {
  assert.equal(identity(request('192.0.2.10', '::ffff:c633:6401')), identity(request('192.0.2.10', '198.51.100.1')));
  assert.equal(identity(request('192.0.2.10', '2001:db8:1234:5600::1')), identity(request('192.0.2.10', '2001:0db8:1234:56ff::2')));
  assert.notEqual(identity(request('192.0.2.10', '2001:db8:1234:5700::1')), identity(request('192.0.2.10', '2001:db8:1234:5600::1')));
});
test('empty, malformed and trust-all proxy ranges fail startup', () => {
  for (const ranges of [[], ['0.0.0.0/0'], ['::/0'], ['192.0.2.1'], ['bad/32'], ['192.0.2.0/33']]) {
    assert.throws(() => createRailwayRateLimitIdentity(ranges));
  }
});
test('real HTTP limiter separates clients and refuses forged XFF bucket rotation', async t => {
  const app = express();
  app.use(rateLimit({
    windowMs: 60000, limit: 2, legacyHeaders: false,
    keyGenerator: createRailwayRateLimitIdentity(['127.0.0.1/32']),
  }));
  app.get('/', (_req, res) => res.sendStatus(200));
  app.use((err, _req, res, _next) => res.sendStatus(err.statusCode || 500));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const get = (client, forwarded) => fetch(url, { headers: { 'x-real-ip': client, 'x-forwarded-for': forwarded } });
  assert.equal((await get('198.51.100.1', '203.0.113.1')).status, 200);
  assert.equal((await get('198.51.100.1', '203.0.113.2')).status, 200);
  assert.equal((await get('198.51.100.1', '203.0.113.3')).status, 429);
  assert.equal((await get('198.51.100.2', '203.0.113.3')).status, 200);
  assert.equal((await get('invalid', '203.0.113.3')).status, 503);
});
