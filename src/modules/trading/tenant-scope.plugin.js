'use strict';

const mongoose = require('mongoose');

function applyTenantScope(schema) {
  schema.add({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  });

  schema.pre('validate', async function hydrateTenantFromAccount() {
    if (this.tenantId || !this.accountId) return;
    const Account = mongoose.models.TradingAccount;
    if (!Account) {
      this.invalidate('tenantId', 'TradingAccount model is unavailable for tenant resolution');
      return;
    }
    const account = await Account.findById(this.accountId).select('tenantId').lean();
    if (!account?.tenantId) {
      this.invalidate('tenantId', 'Trading account does not have a tenant assignment');
      return;
    }
    this.tenantId = account.tenantId;
  });

  schema.index({ tenantId: 1, accountId: 1 });
}

module.exports = { applyTenantScope };
