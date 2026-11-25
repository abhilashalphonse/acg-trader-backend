'use strict';

const mongoose = require('mongoose');

function applyTenantScope(schema) {
  schema.add({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  });

  enforceAccountOwnership(schema);
  schema.index({ tenantId: 1, accountId: 1 });
}

// Resolve ownership in the document's transaction, including accounts created
// in that transaction. Existing immutable ownership pairs need no extra read.
function enforceAccountOwnership(schema) {
  schema.pre('validate', async function verifyAccountOwnership() {
    if (!this.accountId || (!this.isNew && !this.isModified('accountId') && !this.isModified('tenantId') && this.tenantId)) return;
    const Account = mongoose.models.TradingAccount;
    if (!Account) {
      this.invalidate('tenantId', 'TradingAccount model is unavailable for tenant resolution');
      return;
    }
    const query = Account.findById(this.accountId).select('tenantId');
    const session = this.$session();
    if (session) query.session(session);
    const account = await query.lean();
    if (!account?.tenantId) {
      this.invalidate('tenantId', 'Trading account does not have a tenant assignment');
      return;
    }
    if (this.tenantId && String(this.tenantId) !== String(account.tenantId)) {
      this.invalidate('tenantId', 'Trading account belongs to a different tenant');
      return;
    }
    this.tenantId = account.tenantId;
  });
}

module.exports = { applyTenantScope, enforceAccountOwnership };
