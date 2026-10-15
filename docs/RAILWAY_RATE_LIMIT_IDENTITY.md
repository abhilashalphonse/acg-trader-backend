# Railway rate-limit identity: activation requires verified ingress

Issue #74 remains open until production activation and verification.

## Finding
Live production request samples on 2026-10-15 contained two X-Forwarded-For
addresses. The rightmost was an intermediate proxy; X-Real-IP identified
the client. Enabling the existing one-hop TRUST_PROXY switch would therefore
select the wrong address in those samples.

Railway's staff guidance states that the hop count is not fixed, public ingress
overwrites X-Real-IP, private networking bypasses sanitization, and proxy CIDRs
are not published:
https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86
https://docs.railway.com/networking/public-networking/specs-and-limits

## Proposed implementation
Default express mode is unchanged. Opt-in RATE_LIMIT_IDENTITY=railway-real-ip
uses a validated X-Real-IP only when the actual socket peer matches the explicit
RATE_LIMIT_TRUSTED_PROXY_CIDRS allowlist. Other peers use their socket IP,
ignoring all forwarded headers. Both API and login limiters use the same
resolver. IPv4-mapped identities normalize and IPv6 clients group at /56.
A matching proxy with a missing/invalid client IP gets 503, not an unlimited
or attacker-selected bucket. Empty lists, invalid CIDRs and /0 fail startup.
No changes to trading, financial state, limit thresholds or Express trust proxy.

## Deployment gate
Do not infer a permanent CIDR from an observed Railway peer. There is no
Railway-published stable range. Do not enable this mode until the operator can
establish that the allowlisted socket sources are exclusively sanitizing ingress,
not private callers. If that boundary cannot be established, leave mode disabled
and obtain a supported boundary from Railway or use an authenticated ingress
proxy. Headers such as Host, X-Railway-Edge and X-Railway-Request-ID are not
proof of ingress provenance.

An unrecognized new ingress peer falls back to socket identity; it cannot
spoof a client through headers, but may share a rate bucket. Monitor that
operational risk after ingress changes. Do not broaden the allowlist to suppress it
without checking source isolation.

After separate production approval:
1. Verify the source boundary and supply the reviewed explicit CIDRs securely
   through Railway configuration, together with RATE_LIMIT_IDENTITY=railway-real-ip.
2. Leave TRUST_PROXY unchanged; the rate-limit resolver does not depend on it.
3. Verify two independent clients have separate buckets, spoofed XFF/X-Real-IP
   are overwritten at ingress, and private callers cannot select public identity.
4. Verify both general and authentication limits; avoid exhausting customer
   production buckets. Use an isolated ingress rehearsal for 429 threshold tests.
5. Inspect sanitized logs for absent ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and
   unexpected CLIENT_IDENTITY_UNAVAILABLE errors.
6. Confirm production health and financial invariants remain unchanged.

Local HTTP tests prove resolver and limiter behavior, not Railway network
isolation. This draft alone does not close issue #74.
