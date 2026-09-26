'use strict';

const mongoose = require('mongoose');
const { env } = require('../src/config/env');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { Position } = require('../src/modules/trading/position.model');

const POLICY_KEYS = Object.freeze([
  'maxRiskPerTradePercent',
  'maxAggregateRiskPercent',
  'maxMarginUsagePercent',
  'maxSingleOrderMarginPercentOfFree',
  'maxSymbolMarginPercentOfPermitted',
  'maxOpenPositions',
  'maxPositionsPerSymbol',
  'maxPendingOrders',
  'maxPendingOrdersPerSymbol',
]);

async function main() {
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: env.mongoServerSelectionTimeoutMs,
  });

  const accounts = await TradingAccount.find({
    'metadata.fundedAccountId': { $exists: true },
  })
    .select('_id accountCode accountType status metadata riskPolicy')
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const accountIds = accounts.map(account => account._id);
  const openPositions = accountIds.length
    ? await Position.find({
      accountId: { $in: accountIds },
      status: 'OPEN',
    })
      .select('accountId positionId symbol side openVolume stopLoss')
      .lean()
    : [];

  const positionsByAccount = new Map();
  for (const position of openPositions) {
    const key = String(position.accountId);
    if (!positionsByAccount.has(key)) positionsByAccount.set(key, []);
    positionsByAccount.get(key).push(position);
  }

  const signatures = new Map();
  let noStopLossPositions = 0;
  let accountsWithNoStopLoss = 0;

  for (const account of accounts) {
    const policy = {};
    for (const key of POLICY_KEYS) policy[key] = scalar(account?.riskPolicy?.[key]);

    const metadata = account?.metadata instanceof Map
      ? Object.fromEntries(account.metadata)
      : (account?.metadata || {});
    const open = positionsByAccount.get(String(account._id)) || [];
    const noStop = open.filter(position =>
      position.stopLoss === null || position.stopLoss === undefined || position.stopLoss === ''
    );

    if (noStop.length) {
      accountsWithNoStopLoss += 1;
      noStopLossPositions += noStop.length;
    }

    const signature = JSON.stringify(policy);
    signatures.set(signature, (signatures.get(signature) || 0) + 1);

    console.log('[FUNDED_RISK_POLICY_AUDIT] ACCOUNT', JSON.stringify({
      accountId: String(account._id),
      accountCode: account.accountCode || null,
      fundedAccountId: metadata.fundedAccountId || null,
      accountType: account.accountType || null,
      status: account.status || null,
      riskPolicyVersion: metadata.riskPolicyVersion || null,
      policy,
      openPositions: open.length,
      openWithoutStopLoss: noStop.map(position => ({
        positionId: position.positionId || String(position._id),
        symbol: position.symbol,
        side: position.side,
        openVolume: scalar(position.openVolume),
      })),
    }));
  }

  console.log('[FUNDED_RISK_POLICY_AUDIT] SUMMARY', JSON.stringify({
    tradingAccountsAudited: accounts.length,
    policySignatures: [...signatures.entries()].map(([policy, count]) => ({
      count,
      policy: JSON.parse(policy),
    })),
    accountsWithOpenPositionsWithoutStopLoss: accountsWithNoStopLoss,
    openPositionsWithoutStopLoss: noStopLossPositions,
  }));
}

function scalar(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value?.toString ? value.toString() : value);
}

main()
  .catch(error => {
    console.error('[FUNDED_RISK_POLICY_AUDIT] FAILED', {
      code: error?.code,
      message: error?.message,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
