'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { timeAsync } = require('../../shared/observability/execution-timing');
const { promisify } = require('util');
const { AppError } = require('../../shared/errors/app-error');
const { Tenant } = require('../tenancy/tenant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { TraderCredential } = require('./trader-credential.model');
const { ServiceApiKey } = require('./service-api-key.model');
const { TraderSession } = require('./trader-session.model');
const { FederationTicket } = require('./federation-ticket.model');

const scryptAsync = promisify(crypto.scrypt);
const FEDERATED_ACCOUNT_STATUSES = Object.freeze(['ACTIVE', 'BREACHED']);

class AuthService {
  constructor({
    tenantModel = Tenant,
    accountModel = TradingAccount,
    credentialModel = TraderCredential,
    serviceApiKeyModel = ServiceApiKey,
    sessionModel = TraderSession,
    federationTicketModel = FederationTicket,
    sessionTtlSeconds = 3600,
    accessTokenTtlSeconds = 900,
    accessTokenGraceSeconds = 45,
    refreshSessionTtlSeconds = 30 * 24 * 60 * 60,
    idleTimeoutSeconds = 24 * 60 * 60,
    sessionTouchIntervalSeconds = 60,
    federationTicketTtlSeconds = 60,
    maxFailedLogins = 5,
    lockoutSeconds = 900,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      tenantModel,
      accountModel,
      credentialModel,
      serviceApiKeyModel,
      sessionModel,
      federationTicketModel,
      sessionTtlSeconds,
      accessTokenTtlSeconds,
      accessTokenGraceSeconds,
      refreshSessionTtlSeconds,
      idleTimeoutSeconds,
      sessionTouchIntervalSeconds,
      federationTicketTtlSeconds,
      maxFailedLogins,
      lockoutSeconds,
      now,
    });
  }

  async loginNative({ tenant, login, password }) {
    const tenantRecord = await this.#requireActiveTenantBySlug(tenant);
    this.#assertAuthMode(tenantRecord, 'PASSWORD');
    const credential = await this.credentialModel.findOne({ tenantId: tenantRecord._id, login: String(login || '').trim(), status: 'ACTIVE' });
    if (!credential) throw invalidCredentials();

    const now = this.now();
    if (credential.lockedUntil && credential.lockedUntil > now) {
      throw new AppError('Trading login is temporarily locked', { statusCode: 423, code: 'TRADING_LOGIN_LOCKED', details: { lockedUntil: credential.lockedUntil.toISOString() } });
    }

    const valid = await verifyPassword(String(password || ''), credential.passwordSalt, credential.passwordHash);
    if (!valid) {
      credential.failedAttempts += 1;
      if (credential.failedAttempts >= this.maxFailedLogins) {
        credential.failedAttempts = 0;
        credential.lockedUntil = new Date(now.getTime() + this.lockoutSeconds * 1000);
      }
      await credential.save();
      throw invalidCredentials();
    }

    const account = await this.accountModel.findOne({ _id: credential.accountId, tenantId: tenantRecord._id });
    if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

    credential.failedAttempts = 0;
    credential.lockedUntil = null;
    credential.lastLoginAt = now;
    await credential.save();

    return this.#createSession({
      tenantId: tenantRecord._id,
      authMethod: 'PASSWORD',
      ownerExternalRef: account.ownerExternalRef || null,
      ownerExternalRefs: account.ownerExternalRef ? [account.ownerExternalRef] : [],
      accountIds: [account._id],
      selectedAccountId: account._id,
      credentialId: credential._id,
    });
  }

  async createNativeCredential({ tenantId, accountId, login = null, password = null, mustChangePassword = false, rotate = false }) {
    const account = await this.accountModel.findOne({ _id: String(accountId), tenantId: String(tenantId) });
    if (!account) throw new AppError('Trading account was not found for this tenant', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

    const rawPassword = password || generatePassword();
    validatePassword(rawPassword);
    const resolvedLogin = String(login || generateLogin()).trim();
    const { salt, hash } = await hashPassword(rawPassword);
    const existing = await this.credentialModel.findOne({ tenantId: account.tenantId, accountId: account._id });

    if (existing && !rotate) {
      throw new AppError('Native trading credential already exists', { statusCode: 409, code: 'TRADING_CREDENTIAL_EXISTS' });
    }

    let credential = existing || new this.credentialModel({ tenantId: account.tenantId, accountId: account._id });
    credential.login = resolvedLogin;
    credential.passwordSalt = salt;
    credential.passwordHash = hash;
    credential.passwordChangedAt = this.now();
    credential.mustChangePassword = Boolean(mustChangePassword);
    credential.status = 'ACTIVE';
    credential.failedAttempts = 0;
    credential.lockedUntil = null;

    try {
      await credential.save();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const raced = await this.credentialModel.findOne({ tenantId: account.tenantId, accountId: account._id });
      if (!rotate || !raced) {
        throw new AppError('Native trading credential already exists', {
          statusCode: 409,
          code: 'TRADING_CREDENTIAL_EXISTS',
        });
      }
      credential = raced;
      credential.login = resolvedLogin;
      credential.passwordSalt = salt;
      credential.passwordHash = hash;
      credential.passwordChangedAt = this.now();
      credential.mustChangePassword = Boolean(mustChangePassword);
      credential.status = 'ACTIVE';
      credential.failedAttempts = 0;
      credential.lockedUntil = null;
      await credential.save();
    }

    if (existing || rotate) await this.sessionModel.updateMany({ credentialId: credential._id, revokedAt: null }, { $set: { revokedAt: this.now() } });

    return {
      credential: {
        id: String(credential._id),
        tenantId: String(credential.tenantId),
        accountId: String(credential.accountId),
        login: credential.login,
        mustChangePassword: credential.mustChangePassword,
      },
      temporaryPassword: rawPassword,
    };
  }

  async createFederationTicket({ tenantId, ownerExternalRef, ownerExternalRefs = [], accountIds, selectedAccountId = null, metadata = {} }) {
    const owner = requiredString(ownerExternalRef, 'ownerExternalRef');
    const owners = uniqueIds([owner, ...ownerExternalRefs]);
    const ids = uniqueIds(accountIds);
    if (!ids.length) throw new AppError('At least one accountId is required', { statusCode: 400, code: 'ACCOUNT_GRANT_REQUIRED' });

    const selected = selectedAccountId ? String(selectedAccountId) : ids[0];
    if (!ids.includes(selected)) {
      throw new AppError('selectedAccountId must be included in accountIds', { statusCode: 400, code: 'SELECTED_ACCOUNT_NOT_GRANTED' });
    }

    const accounts = await Promise.all(ids.map(id => this.accountModel.findOne({
      _id: id,
      tenantId: String(tenantId),
      ownerExternalRef: mongoose.trusted({ $in: owners }),
      status: mongoose.trusted({ $in: FEDERATED_ACCOUNT_STATUSES }),
      federationEnabled: mongoose.trusted({ $ne: false }),
    }).select('_id status tradingEnabled federationEnabled').lean()));
    if (accounts.some(account => !account)) {
      throw new AppError('One or more accounts are not owned by this tenant user', { statusCode: 403, code: 'ACCOUNT_GRANT_FORBIDDEN' });
    }

    const ticket = randomToken(32);
    const expiresAt = new Date(this.now().getTime() + this.federationTicketTtlSeconds * 1000);
    await this.federationTicketModel.create({
      tenantId,
      tokenHash: hashToken(ticket),
      ownerExternalRef: owner,
      ownerExternalRefs: owners,
      accountIds: ids,
      selectedAccountId: selected,
      expiresAt,
      metadata,
    });
    return { ticket, expiresAt: expiresAt.toISOString(), selectedAccountId: selected };
  }

  async exchangeFederationTicket(ticket) {
    const now = this.now();
    const tokenHash = hashToken(requiredString(ticket, 'ticket'));

    let record;
    try {
      // Consume the ticket atomically. Only one concurrent exchange can match
      // consumedAt:null, which prevents replay from creating multiple sessions.
      record = await this.federationTicketModel.findOneAndUpdate(
        {
          tokenHash,
          consumedAt: null,
          expiresAt: mongoose.trusted({ $gt: now }),
        },
        { $set: { consumedAt: now } },
        { new: true },
      );
    } catch (error) {
      throw new AppError(`Federation ticket lookup failed: ${error.message}`, {
        statusCode: 500,
        code: 'FEDERATION_TICKET_LOOKUP_FAILED',
      });
    }

    if (!record) {
      throw new AppError('Federated login ticket is invalid or expired', { statusCode: 401, code: 'FEDERATION_TICKET_INVALID' });
    }

    let tenant;
    try {
      tenant = await this.tenantModel.findOne({ _id: record.tenantId, status: 'ACTIVE' });
    } catch (error) {
      throw new AppError(`Federation tenant lookup failed: ${error.message}`, {
        statusCode: 500,
        code: 'FEDERATION_TENANT_LOOKUP_FAILED',
      });
    }

    if (!tenant) throw new AppError('Tenant is not active', { statusCode: 403, code: 'TENANT_DISABLED' });
    this.#assertAuthMode(tenant, 'FEDERATED');

    try {
      return await this.#createSession({
        tenantId: record.tenantId,
        authMethod: 'FEDERATED',
        ownerExternalRef: record.ownerExternalRef,
        ownerExternalRefs: record.ownerExternalRefs || [record.ownerExternalRef],
        accountIds: record.accountIds,
        selectedAccountId: record.selectedAccountId || record.accountIds?.[0] || null,
        metadata: record.metadata || {},
      });
    } catch (error) {
      try {
        await this.federationTicketModel.updateOne(
          { _id: record._id, consumedAt: now },
          { $set: { consumedAt: null } },
        );
      } catch {
        // The original session-creation error is more useful to operators.
      }
      throw new AppError('Federation session creation failed', {
        statusCode: 500,
        code: 'FEDERATION_SESSION_CREATE_FAILED',
      });
    }
  }

  async authenticateSessionToken(token, { timing = null } = {}) {
    const now = this.now();
    const tokenHash = hashToken(requiredString(token, 'accessToken'));
    const session = await timeAsync(timing, 'auth_lookup', () => this.sessionModel.findOne({
      revokedAt: null,
      $or: [
        { tokenHash },
        { previousTokenHash: tokenHash },
      ],
    }).lean());
    const usingCurrentToken = Boolean(session && session.tokenHash === tokenHash);
    const usingPreviousToken = Boolean(session && session.previousTokenHash === tokenHash);
    const accessExpiresAt = usingCurrentToken
      ? (session?.accessExpiresAt || session?.expiresAt || null)
      : usingPreviousToken
        ? (session?.previousAccessExpiresAt || null)
        : null;
    const idleExpiresAt = session?.idleExpiresAt || session?.expiresAt || null;
    if (
      !session
      || !accessExpiresAt
      || accessExpiresAt <= now
      || !session.expiresAt
      || session.expiresAt <= now
      || !idleExpiresAt
      || idleExpiresAt <= now
    ) {
      throw invalidTraderSession();
    }

    const lastSeenAt = session.lastSeenAt instanceof Date ? session.lastSeenAt : null;
    const touchIntervalMs = Math.max(1, Number(this.sessionTouchIntervalSeconds) || 60) * 1000;
    const shouldTouchSession = !lastSeenAt || (now.getTime() - lastSeenAt.getTime()) >= touchIntervalMs;
    let resolvedIdleExpiresAt = idleExpiresAt;

    if (shouldTouchSession) {
      const nextIdleExpiresAt = new Date(Math.min(
        session.expiresAt.getTime(),
        now.getTime() + this.idleTimeoutSeconds * 1000,
      ));
      await timeAsync(timing, 'auth_touch', () => this.sessionModel.updateOne(
        {
          _id: session._id,
          revokedAt: null,
          $or: [
            { tokenHash },
            { previousTokenHash: tokenHash },
          ],
        },
        { $set: { lastSeenAt: now, idleExpiresAt: nextIdleExpiresAt } },
      ));
      resolvedIdleExpiresAt = nextIdleExpiresAt;
    }

    return this.#sessionPrincipal(session, accessExpiresAt, resolvedIdleExpiresAt);
  }

  async refreshSession({ refreshToken = null, legacyAccessToken = null } = {}) {
    const now = this.now();

    if (refreshToken) {
      const refreshTokenHash = hashToken(requiredString(refreshToken, 'refreshToken'));
      const current = await this.sessionModel.findOne({ refreshTokenHash, revokedAt: null }).lean();
      if (
        !current
        || !current.expiresAt
        || current.expiresAt <= now
        || !current.idleExpiresAt
        || current.idleExpiresAt <= now
      ) {
        throw invalidTraderRefreshSession();
      }

      const credentials = this.#nextCredentials(current.expiresAt);
      const previousAccessExpiresAt = accessTokenGraceExpiry(current, now, this.accessTokenGraceSeconds);
      const updated = await this.sessionModel.findOneAndUpdate(
        { _id: current._id, refreshTokenHash, revokedAt: null },
        {
          $set: {
            previousTokenHash: previousAccessExpiresAt ? current.tokenHash : null,
            previousAccessExpiresAt,
            tokenHash: hashToken(credentials.accessToken),
            refreshTokenHash: hashToken(credentials.refreshToken),
            accessExpiresAt: credentials.accessExpiresAt,
            idleExpiresAt: credentials.idleExpiresAt,
            lastSeenAt: now,
          },
        },
        { new: true },
      );
      if (!updated) throw invalidTraderRefreshSession();
      return this.#authResponse(updated, credentials);
    }

    if (legacyAccessToken) {
      const legacyTokenHash = hashToken(requiredString(legacyAccessToken, 'legacyAccessToken'));
      const current = await this.sessionModel.findOne({
        tokenHash: legacyTokenHash,
        revokedAt: null,
        $or: [
          { refreshTokenHash: mongoose.trusted({ $exists: false }) },
          { refreshTokenHash: null },
        ],
      }).lean();
      if (!current || !current.expiresAt || current.expiresAt <= now) throw invalidTraderRefreshSession();

      const absoluteExpiresAt = new Date(now.getTime() + this.refreshSessionTtlSeconds * 1000);
      const credentials = this.#nextCredentials(absoluteExpiresAt);
      const previousAccessExpiresAt = accessTokenGraceExpiry(current, now, this.accessTokenGraceSeconds);
      const updated = await this.sessionModel.findOneAndUpdate(
        {
          _id: current._id,
          tokenHash: legacyTokenHash,
          revokedAt: null,
          $or: [
            { refreshTokenHash: mongoose.trusted({ $exists: false }) },
            { refreshTokenHash: null },
          ],
        },
        {
          $set: {
            previousTokenHash: previousAccessExpiresAt ? legacyTokenHash : null,
            previousAccessExpiresAt,
            tokenHash: hashToken(credentials.accessToken),
            refreshTokenHash: hashToken(credentials.refreshToken),
            accessExpiresAt: credentials.accessExpiresAt,
            idleExpiresAt: credentials.idleExpiresAt,
            expiresAt: absoluteExpiresAt,
            lastSeenAt: now,
          },
        },
        { new: true },
      );
      if (!updated) throw invalidTraderRefreshSession();
      return this.#authResponse(updated, credentials);
    }

    throw invalidTraderRefreshSession();
  }

  async listGrantedAccounts(principal) {
    const ids = uniqueIds(principal?.accountIds);
    if (!ids.length) return { accounts: [], selectedAccountId: null };

    const rows = await this.accountModel.find({
      _id: mongoose.trusted({ $in: ids }),
      tenantId: String(principal.tenantId),
    }).select('accountCode accountType currency leverage status tradingEnabled state riskPolicy riskDayKey metadata').lean();

    const byId = new Map(rows.map(row => [String(row._id), row]));
    return {
      accounts: ids.map(id => byId.get(id)).filter(Boolean).map(publicAccountGrant),
      selectedAccountId: ids.includes(String(principal?.selectedAccountId || ''))
        ? String(principal.selectedAccountId)
        : ids[0],
    };
  }

  async revokeSession({ accessToken = null, refreshToken = null } = {}) {
    const hashes = [];
    if (accessToken) {
      const tokenHash = hashToken(requiredString(accessToken, 'accessToken'));
      hashes.push({ tokenHash }, { previousTokenHash: tokenHash });
    }
    if (refreshToken) hashes.push({ refreshTokenHash: hashToken(requiredString(refreshToken, 'refreshToken')) });
    if (!hashes.length) return false;
    const result = await this.sessionModel.updateOne(
      { revokedAt: null, $or: hashes },
      { $set: { revokedAt: this.now() } },
    );
    return Number(result.modifiedCount || 0) > 0;
  }

  async authenticateServiceKey({ clientId, apiKey, requiredScope = null }) {
    const keyRecord = await this.serviceApiKeyModel.findOne({ clientId: requiredString(clientId, 'clientId'), status: 'ACTIVE' });
    if (!keyRecord || !safeHashEquals(keyRecord.keyHash, hashToken(requiredString(apiKey, 'apiKey')))) throw invalidServiceCredentials();
    if (keyRecord.expiresAt && keyRecord.expiresAt <= this.now()) throw invalidServiceCredentials();
    if (requiredScope && !keyRecord.scopes.includes(requiredScope) && !keyRecord.scopes.includes('*')) {
      throw new AppError('Service credential lacks required scope', { statusCode: 403, code: 'SERVICE_SCOPE_FORBIDDEN', details: { requiredScope } });
    }
    const tenant = await this.tenantModel.findOne({ _id: keyRecord.tenantId, status: 'ACTIVE' }).lean();
    if (!tenant) throw new AppError('Tenant is not active', { statusCode: 403, code: 'TENANT_DISABLED' });
    await this.serviceApiKeyModel.updateOne({ _id: keyRecord._id }, { $set: { lastUsedAt: this.now() } });
    return { tenantId: String(keyRecord.tenantId), clientId: keyRecord.clientId, scopes: [...keyRecord.scopes], tenantSlug: tenant.slug };
  }

  async createServiceApiKey({ tenantId, clientId, scopes = ['accounts:write', 'federation:write'], description = null }) {
    const apiKey = `acg_sk_${randomToken(32)}`;
    const record = await this.serviceApiKeyModel.create({ tenantId, clientId, keyHash: hashToken(apiKey), scopes, description });
    return { clientId: record.clientId, apiKey, scopes: [...record.scopes] };
  }

  async #createSession({ tenantId, authMethod, ownerExternalRef, ownerExternalRefs = [], accountIds, selectedAccountId = null, credentialId = null, metadata = {} }) {
    const now = this.now();
    const absoluteExpiresAt = new Date(now.getTime() + this.refreshSessionTtlSeconds * 1000);
    const credentials = this.#nextCredentials(absoluteExpiresAt);
    const ids = uniqueIds(accountIds);
    const session = await this.sessionModel.create({
      tenantId,
      tokenHash: hashToken(credentials.accessToken),
      refreshTokenHash: hashToken(credentials.refreshToken),
      authMethod,
      ownerExternalRef,
      ownerExternalRefs: uniqueIds([ownerExternalRef, ...ownerExternalRefs]),
      accountIds: ids,
      selectedAccountId: selectedAccountId ? String(selectedAccountId) : ids[0] || null,
      credentialId,
      metadata,
      accessExpiresAt: credentials.accessExpiresAt,
      idleExpiresAt: credentials.idleExpiresAt,
      expiresAt: absoluteExpiresAt,
      lastSeenAt: now,
    });
    return this.#authResponse(session, credentials);
  }

  async #resolveSessionContext(session) {
    const seedIds = uniqueIds(session?.accountIds);
    if (String(session?.authMethod || '').toUpperCase() !== 'FEDERATED') {
      const selected = seedIds.includes(String(session?.selectedAccountId || ''))
        ? String(session.selectedAccountId)
        : seedIds[0] || null;
      return { accountIds: seedIds, selectedAccountId: selected };
    }

    const ownerRefs = uniqueIds([session?.ownerExternalRef, ...(session?.ownerExternalRefs || [])]);
    const accessClauses = [];
    if (seedIds.length) accessClauses.push({ _id: mongoose.trusted({ $in: seedIds }) });
    if (ownerRefs.length) accessClauses.push({ ownerExternalRef: mongoose.trusted({ $in: ownerRefs }) });
    if (!accessClauses.length) return { accountIds: [], selectedAccountId: null };

    const rows = await this.accountModel.find({
      tenantId: String(session.tenantId),
      status: mongoose.trusted({ $in: FEDERATED_ACCOUNT_STATUSES }),
      federationEnabled: mongoose.trusted({ $ne: false }),
      $or: accessClauses,
    }).select('_id').lean();

    const accessible = new Set(rows.map(row => String(row._id)));
    const dynamicIds = rows.map(row => String(row._id));
    const accountIds = [
      ...seedIds.filter(id => accessible.has(id)),
      ...dynamicIds.filter(id => !seedIds.includes(id)),
    ];
    const preferred = String(session?.selectedAccountId || '');
    return {
      accountIds,
      selectedAccountId: accountIds.includes(preferred) ? preferred : accountIds[0] || null,
    };
  }

  async #sessionPrincipal(session, accessExpiresAt, idleExpiresAt = null) {
    const context = await this.#resolveSessionContext(session);
    return sessionPrincipal(session, accessExpiresAt, idleExpiresAt, context);
  }

  async #authResponse(session, credentials) {
    const principal = await this.#sessionPrincipal(session, credentials.accessExpiresAt, credentials.idleExpiresAt);
    return authResponse(session, credentials, principal);
  }

  #nextCredentials(absoluteExpiresAt) {
    const now = this.now();
    return {
      accessToken: `acg_ts_${randomToken(32)}`,
      refreshToken: `acg_tr_${randomToken(48)}`,
      accessExpiresAt: new Date(Math.min(
        absoluteExpiresAt.getTime(),
        now.getTime() + this.accessTokenTtlSeconds * 1000,
      )),
      idleExpiresAt: new Date(Math.min(
        absoluteExpiresAt.getTime(),
        now.getTime() + this.idleTimeoutSeconds * 1000,
      )),
    };
  }

  async #requireActiveTenantBySlug(value) {
    const slug = requiredString(value, 'tenant').toLowerCase();
    const tenant = await this.tenantModel.findOne({ slug, status: 'ACTIVE' });
    if (!tenant) throw new AppError('Tenant was not found or is disabled', { statusCode: 401, code: 'TENANT_NOT_AVAILABLE' });
    return tenant;
  }

  #assertAuthMode(tenant, mode) {
    if (!tenant.authModes?.includes(mode)) throw new AppError(`${mode} authentication is disabled for this tenant`, { statusCode: 403, code: 'AUTH_MODE_DISABLED' });
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: Buffer.from(derived).toString('hex') };
}
async function verifyPassword(password, salt, expectedHash) {
  const derived = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(expectedHash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new AppError('Trading password must be between 12 and 256 characters', { statusCode: 400, code: 'INVALID_TRADING_PASSWORD' });
}
function generatePassword() { return `${randomToken(12)}aA7!`; }
function generateLogin() { return String(crypto.randomInt(10000000, 99999999)); }
function randomToken(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function safeHashEquals(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function requiredString(value, field) { const text = String(value ?? '').trim(); if (!text) throw new AppError(`${field} is required`, { statusCode: 400, code: 'INVALID_AUTH_REQUEST' }); return text; }
function uniqueIds(values) { return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))]; }
function accessTokenGraceExpiry(session, now, graceSeconds) {
  const currentExpiry = session?.accessExpiresAt || session?.expiresAt || null;
  if (!currentExpiry || currentExpiry <= now) return null;
  const graceMs = Math.max(1, Number(graceSeconds) || 0) * 1000;
  const expiresAt = new Date(Math.min(currentExpiry.getTime(), now.getTime() + graceMs));
  return expiresAt > now ? expiresAt : null;
}
function sessionPrincipal(session, accessExpiresAt, idleExpiresAt = null, context = {}) {
  const accountIds = uniqueIds(context.accountIds ?? session.accountIds);
  const selectedAccountId = accountIds.includes(String(context.selectedAccountId ?? session.selectedAccountId ?? ''))
    ? String(context.selectedAccountId ?? session.selectedAccountId)
    : accountIds[0] || null;
  return {
    sessionId: String(session._id),
    tenantId: String(session.tenantId),
    ownerExternalRef: session.ownerExternalRef || null,
    accountIds,
    selectedAccountId,
    authMethod: session.authMethod,
    expiresAt: new Date(accessExpiresAt).toISOString(),
    refreshExpiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    idleExpiresAt: idleExpiresAt ? new Date(idleExpiresAt).toISOString() : session.idleExpiresAt ? new Date(session.idleExpiresAt).toISOString() : null,
  };
}

function authResponse(session, credentials, principal = null) {
  const resolved = principal || sessionPrincipal(session, credentials.accessExpiresAt, credentials.idleExpiresAt);
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    tokenType: 'Bearer',
    expiresAt: credentials.accessExpiresAt.toISOString(),
    refreshExpiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    session: {
      id: String(session._id),
      tenantId: String(session.tenantId),
      ownerExternalRef: session.ownerExternalRef || null,
      accountIds: resolved.accountIds,
      selectedAccountId: resolved.selectedAccountId,
      authMethod: session.authMethod,
    },
  };
}

function decimalString(value) {
  if (value == null) return null;
  return typeof value?.toString === 'function' ? value.toString() : String(value);
}

function publicAccountGrant(account) {
  const metadata = account?.metadata instanceof Map
    ? Object.fromEntries(account.metadata)
    : (account?.metadata || {});
  return {
    id: String(account._id),
    accountCode: account.accountCode || null,
    accountType: account.accountType || null,
    currency: account.currency || 'USD',
    leverage: Number(account.leverage || 0) || null,
    status: account.status || null,
    tradingEnabled: account.tradingEnabled === true,
    federationEnabled: account.federationEnabled !== false,
    initialBalance: decimalString(account?.state?.initialBalance),
    balance: decimalString(account?.state?.balance),
    equity: decimalString(account?.state?.equity),
    riskDayKey: account.riskDayKey || null,
    fundedAccountId: metadata.fundedAccountId || null,
    phase: metadata.phase || metadata.challengePhase || null,
    challengeType: metadata.challengeType || null,
  };
}

function invalidTraderSession() { return new AppError('Trading session is invalid or expired', { statusCode: 401, code: 'TRADER_SESSION_INVALID' }); }
function invalidTraderRefreshSession() { return new AppError('Trading session needs authentication', { statusCode: 401, code: 'TRADER_REFRESH_INVALID' }); }
function invalidCredentials() { return new AppError('Invalid trading login or password', { statusCode: 401, code: 'INVALID_TRADING_CREDENTIALS' }); }
function invalidServiceCredentials() { return new AppError('Invalid service credentials', { statusCode: 401, code: 'INVALID_SERVICE_CREDENTIALS' }); }

module.exports = { AuthService, hashPassword, verifyPassword, hashToken };
