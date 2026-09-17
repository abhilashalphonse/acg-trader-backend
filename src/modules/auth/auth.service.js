'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { AppError } = require('../../shared/errors/app-error');
const { Tenant } = require('../tenancy/tenant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { TraderCredential } = require('./trader-credential.model');
const { ServiceApiKey } = require('./service-api-key.model');
const { TraderSession } = require('./trader-session.model');
const { FederationTicket } = require('./federation-ticket.model');

const scryptAsync = promisify(crypto.scrypt);

class AuthService {
  constructor({
    tenantModel = Tenant,
    accountModel = TradingAccount,
    credentialModel = TraderCredential,
    serviceApiKeyModel = ServiceApiKey,
    sessionModel = TraderSession,
    federationTicketModel = FederationTicket,
    sessionTtlSeconds = 3600,
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
      accountIds: [account._id],
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

    const credential = existing || new this.credentialModel({ tenantId: account.tenantId, accountId: account._id });
    credential.login = resolvedLogin;
    credential.passwordSalt = salt;
    credential.passwordHash = hash;
    credential.passwordChangedAt = this.now();
    credential.mustChangePassword = Boolean(mustChangePassword);
    credential.status = 'ACTIVE';
    credential.failedAttempts = 0;
    credential.lockedUntil = null;
    await credential.save();

    if (existing) await this.sessionModel.updateMany({ credentialId: existing._id, revokedAt: null }, { $set: { revokedAt: this.now() } });

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

  async createFederationTicket({ tenantId, ownerExternalRef, accountIds, metadata = {} }) {
    const owner = requiredString(ownerExternalRef, 'ownerExternalRef');
    const ids = uniqueIds(accountIds);
    if (!ids.length) throw new AppError('At least one accountId is required', { statusCode: 400, code: 'ACCOUNT_GRANT_REQUIRED' });

    const accounts = await Promise.all(ids.map(id => this.accountModel.findOne({
      _id: id,
      tenantId: String(tenantId),
      ownerExternalRef: owner,
    }).select('_id').lean()));
    if (accounts.some(account => !account)) {
      throw new AppError('One or more accounts are not owned by this tenant user', { statusCode: 403, code: 'ACCOUNT_GRANT_FORBIDDEN' });
    }

    const ticket = randomToken(32);
    const expiresAt = new Date(this.now().getTime() + this.federationTicketTtlSeconds * 1000);
    await this.federationTicketModel.create({
      tenantId,
      tokenHash: hashToken(ticket),
      ownerExternalRef: owner,
      accountIds: ids,
      expiresAt,
      metadata,
    });
    return { ticket, expiresAt: expiresAt.toISOString() };
  }

  async exchangeFederationTicket(ticket) {
    const now = this.now();
    const tokenHash = hashToken(requiredString(ticket, 'ticket'));

    // Consume the ticket atomically. Only one concurrent exchange can match
    // consumedAt:null, which prevents replay from creating multiple sessions.
    const record = await this.federationTicketModel.findOneAndUpdate(
      {
        tokenHash,
        consumedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      { new: true },
    );

    if (!record) {
      throw new AppError('Federated login ticket is invalid or expired', { statusCode: 401, code: 'FEDERATION_TICKET_INVALID' });
    }

    const tenant = await this.tenantModel.findOne({ _id: record.tenantId, status: 'ACTIVE' });
    if (!tenant) throw new AppError('Tenant is not active', { statusCode: 403, code: 'TENANT_DISABLED' });
    this.#assertAuthMode(tenant, 'FEDERATED');

    return this.#createSession({
      tenantId: record.tenantId,
      authMethod: 'FEDERATED',
      ownerExternalRef: record.ownerExternalRef,
      accountIds: record.accountIds,
    });
  }

  async authenticateSessionToken(token) {
    const now = this.now();
    const session = await this.sessionModel.findOne({
      tokenHash: hashToken(requiredString(token, 'accessToken')),
      revokedAt: null,
    }).lean();
    if (!session || !session.expiresAt || session.expiresAt <= now) {
      throw new AppError('Trading session is invalid or expired', { statusCode: 401, code: 'TRADER_SESSION_INVALID' });
    }
    await this.sessionModel.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
    return {
      sessionId: String(session._id),
      tenantId: String(session.tenantId),
      ownerExternalRef: session.ownerExternalRef || null,
      accountIds: session.accountIds.map(String),
      authMethod: session.authMethod,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async revokeSession(token) {
    await this.sessionModel.updateOne({ tokenHash: hashToken(requiredString(token, 'accessToken')), revokedAt: null }, { $set: { revokedAt: this.now() } });
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

  async #createSession({ tenantId, authMethod, ownerExternalRef, accountIds, credentialId = null }) {
    const accessToken = `acg_ts_${randomToken(32)}`;
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlSeconds * 1000);
    const session = await this.sessionModel.create({
      tenantId,
      tokenHash: hashToken(accessToken),
      authMethod,
      ownerExternalRef,
      accountIds: uniqueIds(accountIds),
      credentialId,
      expiresAt,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      session: {
        id: String(session._id),
        tenantId: String(session.tenantId),
        ownerExternalRef: session.ownerExternalRef || null,
        accountIds: session.accountIds.map(String),
        authMethod: session.authMethod,
      },
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
function invalidCredentials() { return new AppError('Invalid trading login or password', { statusCode: 401, code: 'INVALID_TRADING_CREDENTIALS' }); }
function invalidServiceCredentials() { return new AppError('Invalid service credentials', { statusCode: 401, code: 'INVALID_SERVICE_CREDENTIALS' }); }

module.exports = { AuthService, hashPassword, verifyPassword, hashToken };
