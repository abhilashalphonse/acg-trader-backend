'use strict';

// Read-only, aggregate-only production audit. Requires an independent read-only
// MongoDB principal; never log account IDs, order IDs or database credentials.
// All collections are read inside one snapshot transaction (fail closed).
const fs = require('node:fs');
const { MongoClient } = require('mongodb');
const { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, compareDecimal } = require('../src/shared/decimal/decimal');
const { ACG_LEVERAGE_BY_ASSET_CLASS } = require('../src/modules/instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../src/modules/instruments/india-pilot-catalog');

const MAX_AUDIT_ROWS = 200000;
const STUCK_MS = 10 * 60 * 1000;
const PENDING_EXPIRY_GRACE_MS = 2 * 60 * 1000;
const MARGIN_ROUNDING_TOLERANCE = '0.02';

function s(value) {
  return value == null ? null : String(value);
}
function eq(a, b) {
  return a != null && b != null && compareDecimal(a, b) === 0;
}
function zeroCounters() {
  return {
    missingLedgerAccounts: 0, ledgerMathErrors: 0, ledgerContinuityErrors: 0,
    ledgerOpeningBalanceErrors: 0, ledgerCurrencyErrors: 0, ledgerBalanceMismatches: 0,
    savedEquityInconsistencies: 0, savedFreeMarginInconsistencies: 0,
    orphanLedgerEntries: 0, marginMismatches: 0, negativePositionMargins: 0,
    catalogPolicyViolations: 0, missingNsePilotInstruments: 0, enabledNsePilotInstruments: 0,
    stuckTransientOrders: 0, expiredActiveOrders: 0, duplicateOpenExecutions: 0,
    staleChallengeRiskEvents: 0, unresolvedRiskAccounts: 0,
    baselineMarginViolations: 0, baselineUnexplainedVolumeChanges: 0,
  };
}
function compareBaseline(baseline, positions, deals, counters) {
  if (!baseline || !Array.isArray(baseline.positions) || !baseline.capturedAt || !Number.isFinite(Date.parse(baseline.capturedAt))) {
    return { status: 'UNVERIFIABLE', positionsChecked: 0 };
  }
  const current = new Map(positions.map(p => [String(p.positionId || p._id), p]));
  const closes = new Map();
  for (const d of deals) {
    if (new Date(d.executedAt).getTime() < Date.parse(baseline.capturedAt)) continue;
    if (!['CLOSE', 'PARTIAL_CLOSE', 'REVERSE_CLOSE', 'STOP_LOSS', 'TAKE_PROFIT', 'LIQUIDATION'].includes(d.type)) continue;
    const key = String(d.positionId);
    closes.set(key, addDecimal(closes.get(key) || '0', d.volume));
  }
  for (const entry of baseline.positions) {
    const p = current.get(String(entry.positionId));
    if (!p || !entry.positionId || !entry.openVolume || entry.margin == null) {
      counters.baselineMarginViolations += 1;
      continue;
    }
    const currentVolume = p.status === 'CLOSED' ? '0' : s(p.openVolume);
    if (compareDecimal(currentVolume, entry.openVolume) > 0) {
      counters.baselineUnexplainedVolumeChanges += 1;
      continue;
    }
    const expectedClosed = subtractDecimal(entry.openVolume, currentVolume);
    const closedFromDeals = closes.get(String(p._id)) || '0';
    if (!eq(expectedClosed, closedFromDeals)) counters.baselineUnexplainedVolumeChanges += 1;
    const expectedMargin = compareDecimal(currentVolume, '0') === 0
      ? '0'
      : divideDecimal(multiplyDecimal(entry.margin, currentVolume), entry.openVolume, { scale: 12 });
    const delta = subtractDecimal(s(p.margin) || '0', expectedMargin);
    if (compareDecimal(delta, MARGIN_ROUNDING_TOLERANCE) > 0
      || compareDecimal(delta, '-' + MARGIN_ROUNDING_TOLERANCE) < 0) counters.baselineMarginViolations += 1;
  }
  return { status: 'VERIFIED', positionsChecked: baseline.positions.length };
}

function evaluateSnapshot({ accounts, positions, instruments, ledgers, orders, deals, riskEvents = [], riskSummary = null, baseline, now = new Date() }) {
  const c = zeroCounters();
  const accountById = new Map(accounts.map(a => [String(a._id), a]));
  const margins = new Map();
  for (const p of positions) {
    if (p.status !== 'OPEN') continue;
    const id = String(p.accountId);
    margins.set(id, addDecimal(margins.get(id) || '0', s(p.margin) || '0'));
    if (p.margin == null || compareDecimal(p.margin, '0') < 0) c.negativePositionMargins++;
  }
  const previous = new Map();
  for (const entry of ledgers) {
    const id = String(entry.accountId);
    const a = accountById.get(id);
    if (!a) { c.orphanLedgerEntries++; continue; }
    const before = s(entry.balanceBefore), after = s(entry.balanceAfter), amount = s(entry.amount);
    if (before == null || after == null || amount == null || !eq(addDecimal(before, amount), after)) c.ledgerMathErrors++;
    if (previous.has(id)) {
      if (!eq(before, previous.get(id))) c.ledgerContinuityErrors++;
    } else if (!(entry.type === 'DEPOSIT' && eq(before, '0') && eq(after, a.state?.initialBalance))) {
      // Provisioning writes the initial funding as a deposit from zero.
      c.ledgerOpeningBalanceErrors++;
    }
    if (entry.currency !== a.currency) c.ledgerCurrencyErrors++;
    previous.set(id, after);
  }
  let riskSequenceLagAccounts = 0;
  for (const a of accounts) {
    const id = String(a._id);
    if (!previous.has(id)) c.missingLedgerAccounts++;
    else if (!eq(previous.get(id), a.state?.balance)) c.ledgerBalanceMismatches++;
    if (!eq(a.state?.usedMargin, margins.get(id) || '0')) c.marginMismatches++;
    if (a.state?.equity != null && a.state?.floatingPnl != null && a.state?.balance != null
      && !eq(a.state.equity, addDecimal(a.state.balance, a.state.floatingPnl))) c.savedEquityInconsistencies++;
    if (a.state?.freeMargin != null && a.state?.equity != null && a.state?.usedMargin != null
      && !eq(a.state.freeMargin, subtractDecimal(a.state.equity, a.state.usedMargin))) c.savedFreeMarginInconsistencies++;
    if (Number(a.riskSequence || 0) > Number(a.lastEvaluatedRiskSequence || 0)) riskSequenceLagAccounts++;
    const riskUnresolvedAt = a.riskUnresolvedSince ? new Date(a.riskUnresolvedSince).getTime() : NaN;
    if (a.riskProcessingState === 'RISK_UNRESOLVED' && Number.isFinite(riskUnresolvedAt)
      && now.getTime() - riskUnresolvedAt > STUCK_MS) c.unresolvedRiskAccounts++;
  }
  const bySymbol = new Map(instruments.map(i => [i.symbol, i]));
  for (const i of instruments) {
    if (!Object.hasOwn(ACG_LEVERAGE_BY_ASSET_CLASS, i.assetClass)
        || Number(i.defaultLeverage) !== ACG_LEVERAGE_BY_ASSET_CLASS[i.assetClass]) c.catalogPolicyViolations++;
  }
  for (const item of ACG_INDIA_PILOT_CATALOG) {
    const i = bySymbol.get(item.symbol);
    if (!i) c.missingNsePilotInstruments++;
    else if (i.executionEnabled !== false) c.enabledNsePilotInstruments++;
  }
  const nowMs = now.getTime();
  const orderStatuses = {};
  for (const o of orders) {
    orderStatuses[o.status] = (orderStatuses[o.status] || 0) + 1;
    if (['RECEIVED', 'VALIDATING', 'ACCEPTED'].includes(o.status)
      && nowMs - new Date(o.updatedAt || o.createdAt || o.receivedAt).getTime() > STUCK_MS) c.stuckTransientOrders++;
    if (['PENDING', 'TRIGGERED'].includes(o.status) && o.expiresAt != null
      && nowMs - new Date(o.expiresAt).getTime() > PENDING_EXPIRY_GRACE_MS) c.expiredActiveOrders++;
  }
  const openByOrder = new Map();
  for (const d of deals) {
    if (!['OPEN', 'REVERSE_OPEN'].includes(d.type)) continue;
    const key = String(d.orderId);
    openByOrder.set(key, (openByOrder.get(key) || 0) + 1);
  }
  c.duplicateOpenExecutions = [...openByOrder.values()].filter(n => n > 1).length;
  if (riskSummary != null) c.staleChallengeRiskEvents = Number(riskSummary.staleReceived || 0);
  else for (const r of riskEvents) {
    if (r.state === 'RECEIVED' && nowMs - new Date(r.createdAt).getTime() > STUCK_MS) c.staleChallengeRiskEvents++;
  }
  const marginBaseline = compareBaseline(baseline, positions, deals, c);
  const failures = Object.entries(c).filter(([, value]) => value > 0).map(([key]) => key);
  const unverifiable = marginBaseline.status === 'UNVERIFIABLE' ? ['historicalPositionMarginPreservation'] : [];
  const financialReconciliationStatus = failures.length ? 'FAILED' : 'PASSED';
  const historicalMarginStatus = marginBaseline.status === 'UNVERIFIABLE' ? 'UNVERIFIABLE'
    : (c.baselineMarginViolations || c.baselineUnexplainedVolumeChanges ? 'FAILED' : 'PASSED');
  return {
    schema: 'acg-production-financial-audit/v1',
    auditedAt: now.toISOString(),
    counts: {
      accounts: accounts.length,
      openPositions: positions.filter(p => p.status === 'OPEN').length,
      instruments: instruments.length,
      ledgerEntries: ledgers.length,
      orders: orders.length,
      deals: deals.length,
      riskEvents: riskSummary == null ? riskEvents.length : Number(riskSummary.total || 0),
      riskSequenceLagAccounts,
      orderStatuses,
    },
    exceptions: c,
    baseline: marginBaseline,
    dataConsistency: 'single-mongodb-snapshot',
    auditReadOnly: true,
    provenance: { auditCodeCommit: process.env.GITHUB_SHA || null, railwayLiveCommit: null, firebaseServedCommit: null },
    overallStatus: failures.length ? 'FAILED' : (unverifiable.length ? 'UNVERIFIABLE' : 'PASSED'),
    gates: {
      currentFinancialReconciliation: financialReconciliationStatus,
      historicalPositionMarginPreservation: historicalMarginStatus,
      firebaseDeployedCommit: 'BLOCKED',
      liveMarketAndFxValuation: 'BLOCKED',
      authenticatedProductionCustomerWorkflow: 'BLOCKED',
      operationalWarnings: 'BLOCKED',
    },
    financialInventoryPassed: failures.length === 0 && unverifiable.length === 0,
    failedChecks: failures,
    unverifiableChecks: unverifiable,
  };
}

async function readBounded(db, collection, projection, session, sort = { _id: 1 }) {
  const rows = await db.collection(collection).find({}, { session, projection, maxTimeMS: 40000 })
    .sort(sort).limit(MAX_AUDIT_ROWS + 1).toArray();
  if (rows.length > MAX_AUDIT_ROWS) throw new Error('AUDIT_ROW_LIMIT');
  return rows;
}

async function main() {
  if (process.env.PR72_READONLY_RELEASE_AUDIT !== '1' || !process.argv.includes('--comprehensive')
    || !process.argv.includes('--expect-approved')) throw new Error('AUDIT_EXPLICIT_APPROVAL_FLAGS_REQUIRED');
  if (process.env.PR72_AUDIT_DATABASE !== 'acg_trader' || !process.env.MONGODB_URI) {
    throw new Error('AUDIT_PRODUCTION_READONLY_CONFIGURATION_REQUIRED');
  }
  const baseline = process.env.PR72_RELEASE_BASELINE_JSON ? JSON.parse(process.env.PR72_RELEASE_BASELINE_JSON) : null;
  const client = new MongoClient(process.env.MONGODB_URI, {
    retryWrites: false, serverSelectionTimeoutMS: 10000, appName: 'acg-readonly-production-audit',
  });
  let report;
  try {
    await client.connect();
    // Explicitly reject admin/readWrite credentials even if mistakenly supplied.
    const auth = await client.db('admin').command({ connectionStatus: 1 });
    const roles = auth?.authInfo?.authenticatedUserRoles || [];
    if (roles.length !== 1 || roles.some(role => role.role !== 'read' || role.db !== 'acg_trader')) {
      throw new Error('AUDIT_CREDENTIAL_NOT_STRICT_READONLY');
    }
    const session = client.startSession();
    try {
      report = await session.withTransaction(async () => {
        const db = client.db('acg_trader');
        // Serial commands are mandatory within a MongoDB transaction.
        const accounts = await readBounded(db, 'tradingaccounts',
          { _id: 1, currency: 1, state: 1, riskProcessingState: 1, riskUnresolvedSince: 1, riskSequence: 1, lastEvaluatedRiskSequence: 1 }, session);
        const positions = await readBounded(db, 'positions',
          { _id: 1, positionId: 1, accountId: 1, status: 1, openVolume: 1, margin: 1 }, session);
        const instruments = await readBounded(db, 'instruments',
          { symbol: 1, assetClass: 1, defaultLeverage: 1, executionEnabled: 1 }, session);
        const ledgers = await readBounded(db, 'accountledgers',
          { accountId: 1, amount: 1, balanceBefore: 1, balanceAfter: 1, currency: 1, createdAt: 1 }, session,
          { accountId: 1, createdAt: 1, _id: 1 });
        const orders = await readBounded(db, 'orders',
          { status: 1, createdAt: 1, receivedAt: 1, updatedAt: 1, expiresAt: 1 }, session);
        const deals = await readBounded(db, 'deals',
          { orderId: 1, positionId: 1, executedAt: 1, type: 1, volume: 1 }, session);
        // Risk history already exceeds 885k rows. Aggregate on the server;
        // never load it into application memory or hit the 200k row limit.
        const riskCollection = db.collection('accountriskevents');
        const riskTotal = await riskCollection.countDocuments({}, { session, maxTimeMS: 40000 });
        const riskStale = await riskCollection.countDocuments(
          { state: 'RECEIVED', createdAt: { $lt: new Date(Date.now() - STUCK_MS) } },
          { session, maxTimeMS: 40000 });
        return evaluateSnapshot({ accounts, positions, instruments, ledgers, orders, deals,
          riskSummary: { total: riskTotal, staleReceived: riskStale }, baseline });
      }, { readConcern: { level: 'snapshot' }, readPreference: 'primary', maxCommitTimeMS: 10000 });
    } finally {
      await session.endSession();
    }
  } finally {
    await client.close();
  }
  const pathIndex = process.argv.indexOf('--json-output');
  if (pathIndex !== -1) {
    if (!process.argv[pathIndex + 1]) throw new Error('AUDIT_OUTPUT_PATH_REQUIRED');
    fs.writeFileSync(process.argv[pathIndex + 1], JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
  } else {
    console.log('PR72_COMPREHENSIVE_READONLY_AUDIT', JSON.stringify(report));
  }
  if (report.overallStatus === 'FAILED') process.exitCode = 1;
  else if (report.overallStatus === 'UNVERIFIABLE') process.exitCode = 3;
}
if (require.main === module) {
  main().catch(error => {
    console.error('PR72_COMPREHENSIVE_AUDIT_ERROR', String(error?.code || error?.message || error?.name || 'UNKNOWN').replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[REDACTED]'));
    process.exitCode = 2;
  });
}
module.exports = { evaluateSnapshot, main };
