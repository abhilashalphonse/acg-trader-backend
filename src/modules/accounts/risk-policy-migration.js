'use strict';

const { TradingAccount } = require('./trading-account.model');

async function normalizeLegacyFundedPercentageRiskDefaults({
  accountModel = TradingAccount,
  logger = null,
} = {}) {
  const fundedFilter = {
    'metadata.fundedAccountId': { $exists: true, $ne: null },
  };

  const [perTradeResult, aggregateResult] = await Promise.all([
    accountModel.updateMany(
      {
        ...fundedFilter,
        'riskPolicy.maxRiskPerTradePercent': '1',
      },
      { $set: { 'riskPolicy.maxRiskPerTradePercent': null } },
    ),
    accountModel.updateMany(
      {
        ...fundedFilter,
        'riskPolicy.maxAggregateRiskPercent': '2',
      },
      { $set: { 'riskPolicy.maxAggregateRiskPercent': null } },
    ),
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

function modifiedCount(result) {
  return Number(result?.modifiedCount ?? result?.nModified ?? 0) || 0;
}

module.exports = {
  normalizeLegacyFundedPercentageRiskDefaults,
  modifiedCount,
};
