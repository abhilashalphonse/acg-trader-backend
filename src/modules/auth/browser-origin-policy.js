'use strict';

// Firebase Hosting is the first-party browser origin, while the Trader API
// runs separately on Railway. Never let a wildcard CORS configuration reflect
// untrusted credential-form origins in production.
const PRODUCTION_BROWSER_ORIGINS = Object.freeze([
  'https://acg-trader.web.app',
  'https://acg-trader.firebaseapp.com',
  'https://acg-trader-frontend-production.up.railway.app',
]);

function approvedBrowserOrigin(origin, configured = [], isProduction = false) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.origin !== origin || parsed.username || parsed.password ||
      (isProduction && parsed.protocol !== 'https:') ||
      !['http:', 'https:'].includes(parsed.protocol)) return false;
  const allowed = new Set([
    ...(isProduction ? PRODUCTION_BROWSER_ORIGINS : []),
    ...configured.filter(value => value !== '*' && typeof value === 'string'),
  ]);
  if (!isProduction && configured.includes('*')) return true;
  return allowed.has(origin);
}

function rejectUntrustedAuthOrigin(req, res, next, configured, isProduction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  // Nonbrowser internal clients do not send Origin. They still require a
  // trading access token, service credentials or the refresh intent header.
  if (origin === undefined) return next();
  if (!approvedBrowserOrigin(origin, configured, isProduction)) {
    return res.status(403).set('Cache-Control', 'no-store').json({
      error: { code: 'UNTRUSTED_AUTH_ORIGIN', message: 'Authentication request origin is not allowed' },
    });
  }
  return next();
}

module.exports = { approvedBrowserOrigin, rejectUntrustedAuthOrigin, PRODUCTION_BROWSER_ORIGINS };
