'use strict';

const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');

// Conservative first release: only ordinary public IPv4 HTTPS endpoints.
// Reject private, link-local, carrier-grade NAT, loopback, documentation,
// benchmarking, multicast and reserved destinations; no IPv6 or custom port.
function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 ||
    (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
    (a===172 && b>=16 && b<=31) || (a===192 && (b===168 ||
      (b===0 && (c===0 || c===2)) || (b===88 && c===99))) ||
    (a===198 && (b===18 || b===19 || (b===51 && c===100))) ||
    (a===203 && b===0 && c===113));
}

function validatePartnerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid partner webhook URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/,'');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !host.includes('.') || net.isIP(host) || host.startsWith('[') ||
      /(?:^|\.)(?:localhost|local|internal|onion|home\.arpa)$/.test(host)) {
    throw new Error('Partner webhook requires a public HTTPS DNS hostname on port 443');
  }
  return url;
}

// Resolve once per attempt, reject mixed public/private answers, and pin the
// validated address for this connection. TLS still verifies the original host.
// Never follow redirects. No socket pools or environment proxy configuration.
async function safePartnerFetch(value, options, { lookup = dns.lookup, request = https.request } = {}) {
  const url = validatePartnerUrl(value);
  const { signal, headers, body } = options;
  if (signal?.aborted) throw new Error('Partner webhook timed out');
  let abort;
  let resolved;
  try {
    const resolution = Promise.resolve().then(() => lookup(url.hostname, { family: 4, all: true }));
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new Error('Partner webhook timed out'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    resolved = await Promise.race([resolution, interrupted]);
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
  if (signal?.aborted) throw new Error('Partner webhook timed out');
  if (!Array.isArray(resolved) || !resolved.length || resolved.some(row => row.family !== 4 || !publicIPv4(row.address))) {
    throw new Error('Partner webhook DNS resolved to a prohibited address');
  }
  const pinned = resolved[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', headers, agent: false, family: 4, signal,
      lookup: (_host, opts, cb) => opts?.all
        ? cb(null, [pinned]) : cb(null, pinned.address, 4),
    }, response => {
      // Drain the response without storing untrusted body content.
      response.on('error', reject);
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode });
    });
    req.on('error', reject);
    req.end(body);
  });
}
module.exports = { publicIPv4, validatePartnerUrl, safePartnerFetch };
