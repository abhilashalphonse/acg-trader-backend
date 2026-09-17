'use strict';

const mongoose = require('mongoose');

function applyTenantScope(schema) {
  schema.add({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  });

  schema.index({ tenantId: 1, accountId: 1 });
}

module.exports = { applyTenantScope };
