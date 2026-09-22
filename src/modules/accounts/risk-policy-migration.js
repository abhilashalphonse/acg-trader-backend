'use strict';

const mongoose = require('mongoose');
const { TradingAccount } = require('./trading-account.model');

const LEGACY_FUNDED_RISK_DEFAULTS = Object.freeze([
  { key: 'maxRiskPerTradePercent', value: '1', resultKey: 'maxRiskPerTradeCleared' },
  { key: 'maxAggregateRiskPercent', value: '2', resultKey: 'maxAggregateRiskCleared' },
  { key: 'maxMarginUsagePercent', value: '50', resultKey: 'maxMarginUsageCleared' },
  { key: 'maxSingleOrderMarginPercentOfFree', value: '20', resultKey: 'maxSingleOrderMarginCleared' },
  { key: 'maxSymbolMarginPercentOfPermitted', value: '30', resultKey: 'maxSymbolMarginCleared' },
]);

async function normalizeLegacyFundedRiskDefaults({
  accountModel = TradingAccount,
  logger = null,
} = {}) {
  const candidates = await accountModel.find({
    $or: LEGACY_FUNDED_RISK_DEFAULTS.map(item => ({
      [`riskPolicy.${item.key}`]: item.value,
    })),
  })
    .select(`_id metadata ${LEGACY_FUNDED_RISK_DEFAULTS.map(item => `riskPolicy.${item.key}`).join(' ')}`)
    .lean();

  const funded = (candidates || []).filter(account => metadataValue(account?.metadata, 'fundedAccountId'));
  const operations = LEGACY_FUNDED_RISK_DEFAULTS.map(item => {
    const ids = funded
      .filter(account => decimalText(account?.riskPolicy?.[item.key]) === item.value)
      .map(account => account._id);
    return clearField(accountModel, ids, `riskPolicy.${item.key}`);
  });
  const results = await Promise.all(operations);

  const summary = Object.fromEntries(
    LEGACY_FUNDED_RISK_DEFAULTS.map((item, index) => [item.resultKey, modifiedCount(results[index])]),
  );

  if (Object.values(summary).some(Boolean)) {
    logger?.info?.(summary, 'Normalized legacy ACG Funded risk-policy defaults');
  }

  return summary;
}

// Backward-compatible export for callers/tests created before margin defaults
// were included in this normalization.
const normalizeLegacyFundedPercentageRiskDefaults = normalizeLegacyFundedRiskDefaults;

async function clearField(accountModel, ids, field) {
  if (!ids.length) return { modifiedCount: 0 };
  return accountModel.updateMany(
    { _id: mongoose.trusted({ $in: ids }) },
    { $set: { [field]: null } },
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
  LEGACY_FUNDED_RISK_DEFAULTS,
  normalizeLegacyFundedRiskDefaults,
  normalizeLegacyFundedPercentageRiskDefaults,
  metadataValue,
  decimalText,
  modifiedCount,
};
