'use strict';

const { env } = require('../../config/env');
const { AuthService } = require('./auth.service');

function createAuthRuntime() {
  const authService = new AuthService({
    sessionTtlSeconds: env.auth.sessionTtlSeconds,
    accessTokenTtlSeconds: env.auth.accessTokenTtlSeconds,
    refreshSessionTtlSeconds: env.auth.refreshSessionTtlSeconds,
    idleTimeoutSeconds: env.auth.idleTimeoutSeconds,
    federationTicketTtlSeconds: env.auth.federationTicketTtlSeconds,
    maxFailedLogins: env.auth.maxFailedLogins,
    lockoutSeconds: env.auth.lockoutSeconds,
  });
  return { authService };
}

module.exports = { createAuthRuntime };
