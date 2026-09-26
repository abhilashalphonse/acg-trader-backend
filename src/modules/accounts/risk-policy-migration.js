'use strict';

const mongoose = require('mongoose');
const { TradingAccount } = require('./trading-account.model');

const FUNDED_ACCOUNT_RISK_POLICY = Object.freeze([
  { key: 'maxRiskPerTradePercent', value: '1', resultKey: 'maxRiskPerTradeRepaired' },
  { key: 'maxAggregateRiskPercent', value: '2', resultKey: 'maxAggregateRiskRepaired' },
  { key: 'maxMarginUsagePercent', value: '50', resultKey: 'maxMarginUsageRepaired' },
  { key: 'maxSingleOrderMarginPercentOfFree', value: '20', resultKey: 'maxSingleOrderMarginRepaired' },
  { key: 'maxSymbolMarginPercentOfPermitted', value: '30', resultKey: 'maxSymbolMarginRepaired' },
  { key: 'maxOpenPositions', value: 10, resultKey: 'maxOpenPositionsRepaired' },
  { key: 'maxPositionsPerSymbol', value: 3, resultKey: 'maxPositionsPerSymbolRepaired' },
  { key: 'maxPendingOrders', value: 10, resultKey: 'maxPendingOrdersRepaired' },
  { key: 'maxPendingOrdersPerSymbol', value: 3, resultKey: 'maxPendingOrdersPerSymbolRepaired' },
]);

async function repairFundedAccountRiskPolicy({
  accountModel = TradingAccount,
  logger = null,
} = {}) {
  const summary = {};

  for (const item of FUNDED_ACCOUNT_RISK_POLICY) {
    // Match only null/missing values. Existing explicit non-null values are
    // intentionally preserved so this repair cannot overwrite a deliberate
    // account-specific override.
    const candidates = await accountModel.find({
      [`riskPolicy.${item.key}`]: null,
    })
      .select(`_id metadata riskPolicy.${item.key}`)
      .lean();

    const ids = (candidates || [])
      .filter(account => metadataValue(account?.metadata, 'fundedAccountId'))
      .map(account => account._id);

    const result = await setField(accountModel, ids, `riskPolicy.${item.key}`, item.value);
    summary[item.resultKey] = modifiedCount(result);
  }

  if (Object.values(summary).some(Boolean)) {
    logger?.info?.(summary, 'Repaired ACG Funded account risk-policy fields');
  }

  return summary;
}

// Compatibility aliases for older internal imports. These now repair missing
// ACG Funded policy fields; they no longer clear official Funded limits.
const normalizeLegacyFundedRiskDefaults = repairFundedAccountRiskPolicy;
const normalizeLegacyFundedPercentageRiskDefaults = repairFundedAccountRiskPolicy;

async function setField(accountModel, ids, field, value) {
  if (!ids.length) return { modifiedCount: 0 };
  return accountModel.updateMany(
    { _id: mongoose.trusted({ $in: ids }) },
    { $set: { [field]: value } },
  );
}

function metadataValue(metadata, key) {
  if (!metadata) return null;
  if (metadata instanceof Map) return metadata.get(key) ?? null;
  return metadata[key] ?? null;
}

function decimalText(value) {
  if (value === null || value === undefined) return null;
  return value?.toString ? value.toString() : String(value);
}

function modifiedCount(result) {
  return Number(result?.modifiedCount ?? result?.nModified ?? 0) || 0;
}

module.exports = {
  FUNDED_ACCOUNT_RISK_POLICY,
  repairFundedAccountRiskPolicy,
  normalizeLegacyFundedRiskDefaults,
  normalizeLegacyFundedPercentageRiskDefaults,
  metadataValue,
  decimalText,
  modifiedCount,
};
