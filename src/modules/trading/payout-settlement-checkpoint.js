'use strict';

const crypto = require('crypto');
const { normalizeDecimal, compareDecimal } = require('../../shared/decimal/decimal');

const CONTRACT_VERSION = 'ACG_PAYOUT_SETTLEMENT_CHECKPOINT_V1';

function buildPayoutSettlementCheckpoint({
  account,
  openPositionCount,
  activeOrderCount,
  lastLedger = null,
  checkedAt = new Date(),
} = {}) {
  if (!account) throw new TypeError('An authoritative Trader account is required');
  const state = account.state || {};
  const balance = requiredDecimal(state.balance);
  const initialBalance = requiredDecimal(state.initialBalance);
  const equity = requiredDecimal(state.equity);
  const floatingPnl = requiredDecimal(state.floatingPnl);
  const usedMargin = requiredDecimal(state.usedMargin);
  const latestLedgerBalance = optionalDecimal(lastLedger?.balanceAfter);
  const blockers = [];

  const currency = String(account.currency || '').toUpperCase();
  if (currency !== 'USD') blockers.push('ACCOUNT_CURRENCY_NOT_USD');
  if (!['ACTIVE', 'PAUSED'].includes(String(account.status || '').toUpperCase())) blockers.push('ACCOUNT_NOT_ACTIVE');
  if (account.tradingEnabled !== false) blockers.push('TRADING_NOT_PAUSED');
  if (account.activePayoutReservationId) blockers.push('PAYOUT_ALREADY_RESERVED');
  if (account.payoutRiskBaselineReviewRequired) blockers.push('PAYOUT_RISK_BASELINE_REVIEW_REQUIRED');
  if (account.riskProcessingState !== 'RESOLVED') blockers.push('RISK_NOT_RESOLVED');
  if (String(account.marginStopOutState || 'NONE').toUpperCase() !== 'NONE') blockers.push('STOP_OUT_PENDING');
  if (Number(account.riskSequence || 0) !== Number(account.lastEvaluatedRiskSequence || 0)) {
    blockers.push('RISK_SEQUENCE_NOT_ACKNOWLEDGED');
  }
  if (!Number.isSafeInteger(Number(account.financialRevision))
    || Number(account.financialRevision) < 0) blockers.push('FINANCIAL_REVISION_MISSING');
  if (!Number.isSafeInteger(Number(openPositionCount)) || Number(openPositionCount) !== 0) {
    blockers.push('OPEN_POSITIONS_REMAIN');
  }
  if (!Number.isSafeInteger(Number(activeOrderCount)) || Number(activeOrderCount) !== 0) {
    blockers.push('ACTIVE_ORDERS_REMAIN');
  }
  if ([balance, initialBalance, equity, floatingPnl, usedMargin].some(x => x == null)) {
    blockers.push('FINANCIAL_SNAPSHOT_INCOMPLETE');
  } else if (
    compareDecimal(balance, equity) !== 0
    || compareDecimal(floatingPnl, '0') !== 0
    || compareDecimal(usedMargin, '0') !== 0
  ) {
    blockers.push('FLAT_ACCOUNT_FINANCIAL_INVARIANT_FAILED');
  }
  if (lastLedger == null || latestLedgerBalance == null
      || balance == null || compareDecimal(latestLedgerBalance, balance) !== 0) {
    blockers.push('LEDGER_BALANCE_NOT_RECONCILED');
  }
  const checkpoint = {
    contractVersion: CONTRACT_VERSION,
    platformAccountId: String(account._id || account.id || ''),
    accountCurrency: currency,
    financialRevision: Number(account.financialRevision ?? -1),
    riskSequence: Number(account.riskSequence ?? -1),
    lastEvaluatedRiskSequence: Number(account.lastEvaluatedRiskSequence ?? -1),
    balance,
    initialBalance,
    equity,
    floatingPnl,
    usedMargin,
    openPositionCount: Number(openPositionCount),
    activeOrderCount: Number(activeOrderCount),
    ledgerEntryId: lastLedger?.entryId || null,
    ledgerBalanceAfter: latestLedgerBalance,
    checkedAt: new Date(checkedAt).toISOString(),
    blockers,
    settled: blockers.length === 0,
    productionPayoutAuthorized: false,
  };
  const hashInput = {
    ...checkpoint,
    checkedAt: undefined,
    productionPayoutAuthorized: undefined,
  };
  checkpoint.evidenceHash = crypto.createHash('sha256')
    .update(JSON.stringify(hashInput))
    .digest('hex');
  return Object.freeze(checkpoint);
}

function requiredDecimal(value) {
  try { return value == null ? null : normalizeDecimal(value); }
  catch { return null; }
}

function optionalDecimal(value) { return requiredDecimal(value); }

module.exports = { buildPayoutSettlementCheckpoint, CONTRACT_VERSION };
