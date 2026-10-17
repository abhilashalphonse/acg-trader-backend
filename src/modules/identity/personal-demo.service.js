'use strict';

// Standalone ACG Trader owns this product. "Tenant" is ONLY an internal
// namespace demanded by the existing TradingAccount/ledger schema.
// It cannot be selected by a user, broker, partner key, or browser payload.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { Tenant } = require('../tenancy/tenant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountAccessGrant } = require('../identity/account-access-grant.model');
const { AccountLedger } = require('../trading/account-ledger.model');
const { AccountControlService } = require('../trading/account-control.service');

const INTERNAL_SLUG = 'acg-trader-personal';
const INTERNAL_OWNER = 'ACG_TRADER_PERSONAL_V1';
const DEMO_BALANCE = '100000';
const DEMO_PRODUCT = 'DEFAULT_DEMO_V1';

function personalDenied() {
  return new AppError('Standalone ACG Trader account is unavailable', {
    statusCode: 403, code: 'PERSONAL_DEMO_UNAVAILABLE',
  });
}

class PersonalDemoService {
  constructor({
    tenantModel = Tenant,
    accountModel = TradingAccount,
    grantModel = AccountAccessGrant,
    ledgerModel = AccountLedger,
    accountControlService = new AccountControlService(),
    now = () => new Date(),
  } = {}) {
    Object.assign(this, { tenantModel, accountModel, grantModel, ledgerModel, accountControlService, now });
  }

  async #firstPartyNamespace() {
    let tenant;
    try {
      tenant = await this.tenantModel.findOneAndUpdate({ slug: INTERNAL_SLUG }, {
        $setOnInsert: {
          name: 'ACG Trader Personal (internal)',
          slug: INTERNAL_SLUG,
          status: 'ACTIVE',
          authModes: ['SUPABASE'],
          features: { personalOwner: INTERNAL_OWNER },
          metadata: { namespace: 'INTERNAL_ONLY', product: DEMO_PRODUCT },
        },
      }, { upsert: true, new: true, runValidators: true }).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      tenant = await this.tenantModel.findOne({ slug: INTERNAL_SLUG }).lean();
    }
    // Fail closed if the reserved slug is already held by a partner,
    // disabled, or configured for native or federated tenant credentials.
    if (!tenant || tenant.status !== 'ACTIVE' || tenant.features?.personalOwner !== INTERNAL_OWNER ||
      tenant.metadata?.namespace !== 'INTERNAL_ONLY' ||
      !Array.isArray(tenant.authModes) || tenant.authModes.length !== 1 || tenant.authModes[0] !== 'SUPABASE') {
      throw personalDenied();
    }
    return tenant;
  }

  async ensureDemo({ userId, loginIdentityId }) {
    if (![userId, loginIdentityId].every(mongoose.isValidObjectId)) throw personalDenied();
    const tenant = await this.#firstPartyNamespace();
    const tenantId = String(tenant._id);
    const id = String(userId);
    // The idempotency key never depends on email, device, retry count or an
    // OAuth provider display name; the identity was resolved by signed subject.
    const externalRef = `acg-personal-demo-v1:${id}`;
    const accountCode = `ACGD${crypto.createHash('sha256').update(id).digest('hex').slice(0,12).toUpperCase()}`;
    const result = await this.accountControlService.provision({
      tenantId, userId: id, ownerExternalRef: null,
      externalRef, accountCode,
      accountType: 'DEMO', currency: 'USD', initialBalance: DEMO_BALANCE,
      // The existing execution engine applies the instrument's more
      // restrictive leverage ceiling, e.g. the 2x crypto catalog rule.
      leverage: 2,
      activate: true, riskTimezone: 'UTC',
      metadata: { product: DEMO_PRODUCT, ownership: INTERNAL_OWNER },
    });
    const account = await this.accountModel.findOne({ tenantId, externalRef }).lean();
    if (!account || String(account.userId) !== id ||
      account.accountType !== 'DEMO' || account.currency !== 'USD' ||
      account.metadata?.product !== DEMO_PRODUCT ||
      account.metadata?.ownership !== INTERNAL_OWNER) throw personalDenied();

    // Provision() atomically writes account+opening ledger+lifecycle. The grant
    // is a separate recoverable step: retry heals a failed first attempt, but
    // NEVER reactivates an explicitly revoked grant.
    const ledger = await this.ledgerModel.findOne({
      tenantId, accountId: account._id,
      idempotencyKey: `provision:${externalRef}`,
    }).lean();
    if (!ledger || String(ledger.amount) !== DEMO_BALANCE ||
      String(ledger.balanceBefore) !== '0' || String(ledger.balanceAfter) !== DEMO_BALANCE ||
      ledger.type !== 'DEPOSIT') {
      throw new AppError('Personal demo opening ledger is missing or inconsistent', {
        statusCode: 503, code: 'PERSONAL_DEMO_LEDGER_UNAVAILABLE',
      });
    }

    let grant;
    try {
      grant = await this.grantModel.findOneAndUpdate({ tenantId, accountId: account._id, userId: id }, {
        $setOnInsert: {
          tenantId, accountId: account._id, userId: id,
          permissions: ['VIEW', 'TRADE'], source: 'PERSONAL',
          status: 'ACTIVE', revokedAt: null, expiresAt: null,
        },
      }, { upsert: true, new: true, runValidators: true }).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      grant = await this.grantModel.findOne({ tenantId, accountId: account._id, userId: id }).lean();
    }
    if (!grant || grant.source !== 'PERSONAL' || grant.status !== 'ACTIVE' ||
      grant.revokedAt || (grant.expiresAt && new Date(grant.expiresAt) <= this.now()) ||
      !grant.permissions?.includes('TRADE')) throw personalDenied();

    return {
      tenantId,
      accountId: String(account._id),
      userId: id,
      loginIdentityId: String(loginIdentityId),
      account: {
        id: String(account._id),
        accountType: 'DEMO',
        currency: 'USD',
        initialBalance: DEMO_BALANCE,
      },
      idempotentReplay: Boolean(result.idempotentReplay),
    };
  }

  // Session scope revalidation calls this; native/federated paths don't.
  async isPersonalNamespace(tenantId) {
    const tenant = await this.tenantModel.findOne({
      _id: tenantId, slug: INTERNAL_SLUG,
      status: 'ACTIVE', authModes: 'SUPABASE',
    }).lean();
    return Boolean(tenant && tenant.features?.personalOwner === INTERNAL_OWNER &&
      tenant.metadata?.namespace === 'INTERNAL_ONLY' && tenant.authModes?.length === 1);
  }
}

module.exports = {
  PersonalDemoService, INTERNAL_SLUG, INTERNAL_OWNER, DEMO_BALANCE, DEMO_PRODUCT,
};
