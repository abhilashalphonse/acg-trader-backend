'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSnapshot } = require('../../scripts/pr72-production-readonly-audit');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');
function fixture() {
  const account = {
    _id: 'acct', currency: 'USD',
    state: { initialBalance: '100', balance: '110', floatingPnl: '0', equity: '110', usedMargin: '30', freeMargin: '80' },
    riskProcessingState: 'RESOLVED', riskSequence: 2, lastEvaluatedRiskSequence: 2,
  };
  return {
    now: new Date('2026-10-15T12:00:00Z'),
    accounts: [account],
    positions: [{ _id: 'p1', positionId: 'position-1', accountId: 'acct', status: 'OPEN', openVolume: '1', margin: '30' }],
    instruments: [
      { symbol: 'BTCUSD', assetClass: 'CRYPTO', defaultLeverage: 2, executionEnabled: true },
      ...ACG_INDIA_PILOT_CATALOG.map(x => ({
        symbol: x.symbol, assetClass: 'EQUITY', defaultLeverage: 10, executionEnabled: false,
      })),
    ],
    ledgers: [
      { accountId: 'acct', type: 'DEPOSIT', amount: '100', balanceBefore: '0', balanceAfter: '100', currency: 'USD' },
      { accountId: 'acct', type: 'ADJUSTMENT', amount: '10', balanceBefore: '100', balanceAfter: '110', currency: 'USD' },
    ],
    orders: [],
    deals: [],
    riskEvents: [],
    baseline: { capturedAt: '2026-10-14T12:00:00Z', positions: [] },
  };
}
test('coherent snapshot passes finance-only invariants', () => {
  const r = evaluateSnapshot(fixture());
  assert.equal(r.financialInventoryPassed, true);
  assert.equal(r.exceptions.missingLedgerAccounts, 0);
  assert.equal(r.gates.firebaseDeployedCommit, 'BLOCKED');
});
test('accounts without any ledger are explicitly flagged', () => {
  const f = fixture(); f.ledgers = [];
  const r = evaluateSnapshot(f);
  assert.equal(r.financialInventoryPassed, false);
  assert.equal(r.exceptions.missingLedgerAccounts, 1);
});
test('full ledger history detects intermediate continuity despite correct latest balance', () => {
  const f = fixture();
  f.ledgers = [
    { accountId: 'acct', type: 'DEPOSIT', amount: '100', balanceBefore: '0', balanceAfter: '100', currency: 'USD' },
    { accountId: 'acct', amount: '5', balanceBefore: '100', balanceAfter: '105', currency: 'USD' },
    { accountId: 'acct', amount: '5', balanceBefore: '104', balanceAfter: '110', currency: 'USD' },
  ];
  assert.equal(evaluateSnapshot(f).exceptions.ledgerContinuityErrors, 1);
});
test('NSE execution enabled and leverage overruns fail audit', () => {
  const f = fixture(); f.instruments[1].executionEnabled = true;
  f.instruments[0].defaultLeverage = 100;
  const r = evaluateSnapshot(f);
  assert.equal(r.exceptions.enabledNsePilotInstruments, 1);
  assert.equal(r.exceptions.catalogPolicyViolations, 1);
});
test('stuck transient order and expired order fail without misclassifying live GTC', () => {
  const f = fixture();
  f.orders = [
    { status: 'ACCEPTED', updatedAt: '2026-10-15T11:00:00Z' },
    { status: 'PENDING', expiresAt: '2026-10-15T11:40:00Z' },
    { status: 'TRIGGERED', expiresAt: null },
  ];
  const r = evaluateSnapshot(f);
  assert.equal(r.exceptions.stuckTransientOrders, 1);
  assert.equal(r.exceptions.expiredActiveOrders, 1);
});
test('baseline expects proportional margin release backed by close deals', () => {
  const f = fixture();
  f.baseline.positions = [{ positionId: 'position-1', openVolume: '2', margin: '60' }];
  f.deals = [{ orderId: 'close-1', positionId: 'p1', type: 'PARTIAL_CLOSE', volume: '1', executedAt: '2026-10-15T09:00:00Z' }];
  const r = evaluateSnapshot(f);
  assert.equal(r.exceptions.baselineMarginViolations, 0);
  assert.equal(r.exceptions.baselineUnexplainedVolumeChanges, 0);
  f.positions[0].margin = '40';
  assert.equal(evaluateSnapshot(f).exceptions.baselineMarginViolations, 1);
});
test('release baseline absence blocks a fully green financial audit', () => {
  const f = fixture(); f.baseline = null;
  const r = evaluateSnapshot(f);
  assert.equal(r.baseline.status, 'UNVERIFIABLE');
  assert.equal(r.gates.currentFinancialReconciliation, 'PASSED');
  assert.equal(r.gates.historicalPositionMarginPreservation, 'UNVERIFIABLE');
  assert.ok(r.unverifiableChecks.includes('historicalPositionMarginPreservation'));
});
test('duplicate opening executions and stale risk replay are visible', () => {
  const f = fixture();
  f.deals = [
    { orderId: 'order1', type: 'OPEN' },
    { orderId: 'order1', type: 'OPEN' },
  ];
  f.riskEvents = [{ state: 'RECEIVED', createdAt: '2026-10-15T11:00:00Z' }];
  const r = evaluateSnapshot(f);
  assert.equal(r.exceptions.duplicateOpenExecutions, 1);
  assert.equal(r.exceptions.staleChallengeRiskEvents, 1);
});

test('saved equity and free margin must remain arithmetically consistent', () => {
  const f = fixture();
  f.accounts[0].state.equity = '109';
  const r = evaluateSnapshot(f);
  assert.equal(r.exceptions.savedEquityInconsistencies, 1);
  assert.equal(r.exceptions.savedFreeMarginInconsistencies, 1);
});
test('momentary risk sequence lag is informational, aged unresolved is an exception', () => {
  const f = fixture();
  f.accounts[0].riskSequence = 3;
  assert.equal(evaluateSnapshot(f).financialInventoryPassed, true);
  assert.equal(evaluateSnapshot(f).counts.riskSequenceLagAccounts, 1);
  f.accounts[0].riskProcessingState = 'RISK_UNRESOLVED';
  f.accounts[0].riskUnresolvedSince = '2026-10-15T11:00:00Z';
  assert.equal(evaluateSnapshot(f).exceptions.unresolvedRiskAccounts, 1);
});

test('baseline violations fail historical check without misclassifying unrecoverable evidence', () => {
  const f = fixture();
  f.baseline.positions = [{ positionId: 'position-1', openVolume: '1', margin: '20' }];
  const r = evaluateSnapshot(f);
  assert.equal(r.gates.historicalPositionMarginPreservation, 'FAILED');
  assert.equal(r.gates.currentFinancialReconciliation, 'FAILED');
  assert.deepEqual(r.unverifiableChecks, []);
});

test('production bootstrap ledger starts at zero and funding deposit matches initial balance', () => {
  const f = fixture();
  const ok = evaluateSnapshot(f);
  assert.equal(ok.exceptions.ledgerOpeningBalanceErrors, 0);
  f.ledgers[0].balanceBefore = '1';
  assert.equal(evaluateSnapshot(f).exceptions.ledgerOpeningBalanceErrors, 1);
});
test('risk history can be server-aggregated independently of full document row limits', () => {
  const f = fixture();
  f.riskSummary = { total: 885180, staleReceived: 11 };
  const r = evaluateSnapshot(f);
  assert.equal(r.counts.riskEvents, 885180);
  assert.equal(r.exceptions.staleChallengeRiskEvents, 11);
});

test('database ledger projection preserves the opening deposit discriminator', () => {
  const { LEDGER_PROJECTION } = require('../../scripts/pr72-production-readonly-audit');
  const f = fixture();
  f.ledgers = f.ledgers.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => LEDGER_PROJECTION[key])));
  assert.equal(evaluateSnapshot(f).exceptions.ledgerOpeningBalanceErrors, 0);
  f.ledgers[0].type = 'ADJUSTMENT';
  assert.equal(evaluateSnapshot(f).exceptions.ledgerOpeningBalanceErrors, 1);
});
