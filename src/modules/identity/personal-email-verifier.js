'use strict';
const { AppError } = require('../../shared/errors/app-error');

// A signed authenticated JWT alone doesn't prove that an email was verified.
// Supabase Auth /user is the provider-authoritative confirmation source.
async function verifyProviderEmail(token, { identityService, projectRef, publishableKey,
  fetchImpl = globalThis.fetch } = {}) {
  if (!identityService || !/^[a-z0-9]{20}$/.test(String(projectRef || '')) ||
      !String(publishableKey || '').startsWith('sb_publishable_')) {
    throw new AppError('Personal authentication is not configured', {
      statusCode: 503, code: 'PERSONAL_AUTH_UNAVAILABLE',
    });
  }
  const verified = await identityService.verifier.verify(token);
  let response;
  try {
    response = await fetchImpl(`https://${projectRef}.supabase.co/auth/v1/user`, {
      headers: {
        Accept: 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    throw new AppError('Identity confirmation is temporarily unavailable', {
      statusCode: 503, code: 'IDENTITY_CONFIRMATION_UNAVAILABLE',
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError('Your sign-in session is no longer valid', {
      statusCode: 401, code: 'IDENTITY_TOKEN_INVALID',
    });
  }
  if (!response.ok) throw new AppError('Identity confirmation is temporarily unavailable', {
    statusCode: 503, code: 'IDENTITY_CONFIRMATION_UNAVAILABLE',
  });
  let user;
  try { user = await response.json(); } catch { user = null; }
  if (!user || user.id !== verified.subject) {
    throw new AppError('Identity confirmation mismatch', { statusCode: 401, code: 'IDENTITY_TOKEN_INVALID' });
  }
  if (!user.email || !user.email_confirmed_at) {
    throw new AppError('Verify your email before using a personal demo', {
      statusCode: 403, code: 'EMAIL_VERIFICATION_REQUIRED',
    });
  }
  return verified;
}
module.exports = { verifyProviderEmail };
