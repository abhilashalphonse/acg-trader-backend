'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGlobalMarketsOperationalGate,
  conversionEvidenceAgeMs,
} = require('../../src/modules/operations/global-markets-operational-gate');

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function readiness(overrides = {}) {
  return {
    symbol: 'RELIANCE',
    activationReady: true,
    status: 'READY_TO_ENABLE_PILOT',
    marketData: {
      underlying: {
        status: 'LIVE',
        ageMs: 500,
        sourceAgeMs: 700,
      },
      fx: {
        status: 'LIVE',
        evidence: {
          path: [{
            symbol: 'USDINR',
            quoteReceivedAtMs: NOW - 400,
            quoteSourceAtMs: NOW - 600,
          }],
        },
      },
    },
    ...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    platformEvents: {
      enabled: true,
      started: true,
      webhookConfigured: true,
      deliveryFailures: 0,
      deadEvents: 0,
    },
    riskEngine: {
      started: true,
      durableOrderedRisk: true,
      inFlight: 0,
    },
    reconciliation: {
      state: 'HEALTHY',
      recovery: { consistent: true },
      latest: { issueCount: 0 },
    },
    ...overrides,
  };
}

const thresholds = {
  maxUnderlyingAgeMs: 2000,
  maxFxAgeMs: 2000,
  maxPlatformEventFailures: 2,
  maxRiskInFlight: 5,
  maxReconciliationIssues: 0,
};

test('operational gate is fail-closed until every threshold is explicitly configured', () => {
  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness(),
    runtimeHealth: runtime(),
    reconciliationHealth: runtime().reconciliation,
    thresholds: {},
    nowMs: NOW,
  });

  assert.equal(gate.operationalReady, false);
  assert.equal(gate.productionAuthorized, false);
  assert.equal(gate.checks.thresholdsConfigured.pass, false);
  assert.ok(gate.alerts.some(alert => alert.check === 'thresholdsConfigured'));
});

test('operational gate passes healthy staging evidence but never authorizes production', () => {
  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness(),
    runtimeHealth: runtime(),
    reconciliationHealth: runtime().reconciliation,
    thresholds,
    nowMs: NOW,
  });

  assert.equal(gate.status, 'OPERATIONALLY_READY_FOR_STAGING_EVIDENCE');
  assert.equal(gate.operationalReady, true);
  assert.equal(gate.productionAuthorized, false);
  assert.equal(gate.alerts.length, 0);
});

test('stale FX evidence blocks operational readiness even when converter status says LIVE', () => {
  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness({
      marketData: {
        underlying: { status: 'LIVE', ageMs: 100, sourceAgeMs: 100 },
        fx: {
          status: 'LIVE',
          evidence: {
            path: [{
              quoteReceivedAtMs: NOW - 500,
              quoteSourceAtMs: NOW - 5000,
            }],
          },
        },
      },
    }),
    runtimeHealth: runtime(),
    reconciliationHealth: runtime().reconciliation,
    thresholds,
    nowMs: NOW,
  });

  assert.equal(gate.operationalReady, false);
  assert.equal(gate.checks.fxFreshness.pass, false);
  assert.equal(gate.checks.fxFreshness.observed.observedAgeMs, 5000);
});

test('dead platform event or degraded risk processing is release-blocking', () => {
  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness(),
    runtimeHealth: runtime({
      platformEvents: {
        enabled: true,
        started: true,
        webhookConfigured: true,
        deliveryFailures: 0,
        deadEvents: 1,
      },
      riskEngine: {
        started: true,
        durableOrderedRisk: true,
        inFlight: 6,
      },
    }),
    reconciliationHealth: runtime().reconciliation,
    thresholds,
    nowMs: NOW,
  });

  assert.equal(gate.checks.platformEvents.pass, false);
  assert.equal(gate.checks.durableRisk.pass, false);
  assert.equal(gate.operationalReady, false);
});

test('conversion evidence age uses the oldest timestamp across all FX legs', () => {
  assert.equal(conversionEvidenceAgeMs({
    path: [
      { quoteReceivedAtMs: NOW - 100, quoteSourceAtMs: NOW - 300 },
      { quoteReceivedAtMs: NOW - 200, quoteSourceAtMs: NOW - 900 },
    ],
  }, NOW), 900);

  assert.equal(conversionEvidenceAgeMs({ path: [] }, NOW), 0);
});


test('reconciliation lastReport issue count is release-blocking', () => {
  const unhealthy = runtime();
  unhealthy.reconciliation = {
    state: 'ISSUES',
    recovery: { consistent: true },
    lastReport: { issueCount: 2 },
  };

  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness(),
    runtimeHealth: unhealthy,
    reconciliationHealth: unhealthy.reconciliation,
    thresholds: { ...thresholds, maxReconciliationIssues: 0 },
    nowMs: NOW,
  });

  assert.equal(gate.checks.reconciliation.pass, false);
  assert.equal(gate.checks.reconciliation.observed.issueCount, 2);
  assert.equal(gate.operationalReady, false);
});


test('unset non-negative thresholds are not silently treated as zero', () => {
  const gate = buildGlobalMarketsOperationalGate({
    readiness: readiness(),
    runtimeHealth: runtime(),
    reconciliationHealth: runtime().reconciliation,
    thresholds: {
      maxUnderlyingAgeMs: 2000,
      maxFxAgeMs: 2000,
      maxPlatformEventFailures: null,
      maxRiskInFlight: undefined,
      maxReconciliationIssues: '',
    },
    nowMs: NOW,
  });
  assert.equal(gate.operationalReady, false);
  assert.equal(gate.checks.thresholdsConfigured.pass, false);
  assert.equal(gate.thresholds.maxPlatformEventFailures, null);
  assert.equal(gate.thresholds.maxRiskInFlight, null);
  assert.equal(gate.thresholds.maxReconciliationIssues, null);
});
