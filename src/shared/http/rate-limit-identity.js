'use strict';

const { BlockList, isIP } = require('node:net');
const { AppError } = require('../errors/app-error');

function normalizeIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (isIP(value) === 4) return { address: value, family: 'ipv4', key: value };
  if (value.includes('%')) return null;
  const canonical = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  const halves = canonical.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left).map(x => parseInt(x, 16));
  if (words.slice(0, 5).every(x => x === 0) && words[5] === 65535) {
    return normalizeIp([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
  }
  // A /56 prevents trivial rate-limit evasion by rotating IPv6 interface IDs.
  const prefix = [...words.slice(0, 3), words[3] & 0xff00].map(x => x.toString(16)).join(':');
  return { address: canonical, family: 'ipv6', key: prefix + '::/56' };
}

function createRailwayRateLimitIdentity(trustedCidrs) {
  if (!Array.isArray(trustedCidrs) || !trustedCidrs.length) {
    throw new Error('RATE_LIMIT_TRUSTED_PROXY_CIDRS_REQUIRED');
  }
  const peers = new BlockList();
  for (const cidr of trustedCidrs) {
    const parts = cidr.split('/');
    const ip = normalizeIp(parts[0]);
    const bits = ip?.family === 'ipv4' ? 32 : 128;
    const prefix = Number(parts[1]);
    if (!ip || parts.length !== 2 || !/^\d+$/.test(parts[1]) || prefix < 1 || prefix > bits) {
      throw new Error('INVALID_RATE_LIMIT_TRUSTED_PROXY_CIDR');
    }
    peers.addSubnet(ip.address, prefix, ip.family);
  }
  return req => {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (!peer) throw new AppError('Client identity unavailable', { statusCode: 503, code: 'CLIENT_IDENTITY_UNAVAILABLE' });
    if (!peers.check(peer.address, peer.family)) return 'direct:' + peer.key;
    const client = normalizeIp(req.headers['x-real-ip']);
    if (!client) throw new AppError('Trusted ingress client identity unavailable', {
      statusCode: 503, code: 'CLIENT_IDENTITY_UNAVAILABLE',
    });
    return 'ingress:' + client.key;
  };
}

module.exports = { createRailwayRateLimitIdentity };
