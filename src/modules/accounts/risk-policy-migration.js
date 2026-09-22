'use strict';

const mongoose = require('mongoose');
const { TradingAccount } = require('./trading-account.model');

async function normalizeLegacyFundedPercentageRiskDefaults({
  accountModel = TradingAccount,
  logger = null,
} = {}) {
  const candidates = await accountModel.find({
    $or: [
      { 'riskPolicy.maxRiskPerTradePercent': '1' },
      { 'riskPolicy.maxAggregateRiskPercent': '2' },
    ],
  })
    .select('_id metadata riskPolicy.maxRiskPerTradePercent riskPolicy.maxAggregateRiskPercent')
    .lean();

  const funded = (candidates || []).filter(account => metadataValue(account?.metadata, 'fundedAccountId'));
  const perTradeIds = funded
    .filter(account => decimalText(account?.riskPolicy?.maxRiskPerTradePercent) === '1')
    .map(account => account._id);
  const aggregateIds = funded
    .filter(account => decimalText(account?.riskPolicy?.maxAggregateRiskPercent) === '2')
    .map(account => account._id);

  const [perTradeResult, aggregateResult] = await Promise.all([
    clearField(accountModel, perTradeIds, 'riskPolicy.maxRiskPerTradePercent'),
    clearField(accountModel, aggregateIds, 'riskPolicy.maxAggregateRiskPercent'),
  ]);

  const maxRiskPerTradeCleared = modifiedCount(perTradeResult);
  const maxAggregateRiskCleared = modifiedCount(aggregateResult);

  if (maxRiskPerTradeCleared || maxAggregateRiskCleared) {
    logger?.info?.({
      maxRiskPerTradeCleared,
      maxAggregateRiskCleared,
    }, 'Normalized legacy ACG Funded percentage-risk defaults');
  }

  return {
    maxRiskPerTradeCleared,
    maxAggregateRiskCleared,
  };
}

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
  normalizeLegacyFundedPercentageRiskDefaults,
  metadataValue,
  decimalText,
  modifiedCount,
};
