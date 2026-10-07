'use strict';

function buildGlobalMarketsOperationalGate({
  readiness,
  runtimeHealth = null,
  reconciliationHealth = null,
  thresholds = {},
  nowMs = Date.now(),
} = {}) {
  const normalizedThresholds = normalizeThresholds(thresholds);
  const thresholdChecks = {
    maxUnderlyingAgeMs: configuredPositive(normalizedThresholds.maxUnderlyingAgeMs, 'GLOBAL_MARKETS_MAX_UNDERLYING_AGE_MS'),
    maxFxAgeMs: configuredPositive(normalizedThresholds.maxFxAgeMs, 'GLOBAL_MARKETS_MAX_FX_AGE_MS'),
    maxPlatformEventFailures: configuredNonNegative(normalizedThresholds.maxPlatformEventFailures, 'GLOBAL_MARKETS_MAX_PLATFORM_EVENT_FAILURES'),
    maxRiskInFlight: configuredNonNegative(normalizedThresholds.maxRiskInFlight, 'GLOBAL_MARKETS_MAX_RISK_IN_FLIGHT'),
    maxReconciliationIssues: configuredNonNegative(normalizedThresholds.maxReconciliationIssues, 'GLOBAL_MARKETS_MAX_RECONCILIATION_ISSUES'),
  };
  const thresholdsConfigured = Object.values(thresholdChecks).every(item => item.pass);

  const underlyingAgeMs = maxFinite([
    readiness?.marketData?.underlying?.ageMs,
    readiness?.marketData?.underlying?.sourceAgeMs,
  ]);
  const fxAgeMs = conversionEvidenceAgeMs(readiness?.marketData?.fx?.evidence, nowMs);
  const platform = runtimeHealth?.platformEvents || readiness?.platformEvents || {};
  const risk = runtimeHealth?.riskEngine || {};
  const reconciliation = reconciliationHealth || runtimeHealth?.reconciliation || {};

  const checks = {
    activationPrerequisites: check(
      readiness?.activationReady === true,
      'Global Markets activation prerequisites are not satisfied',
      { readinessStatus: readiness?.status || null },
    ),
    thresholdsConfigured: check(
      thresholdsConfigured,
      'Operational thresholds are not fully configured',
      {
        missing: Object.entries(thresholdChecks)
          .filter(([, item]) => !item.pass)
          .map(([name, item]) => ({ name, env: item.env })),
      },
    ),
    underlyingFreshness: check(
      readiness?.marketData?.underlying?.status === 'LIVE'
      && normalizedThresholds.maxUnderlyingAgeMs != null
      && underlyingAgeMs != null
      && underlyingAgeMs <= normalizedThresholds.maxUnderlyingAgeMs,
      'Underlying quote age exceeds the approved operational threshold',
      {
        status: readiness?.marketData?.underlying?.status || null,
        observedAgeMs: underlyingAgeMs,
        thresholdMs: normalizedThresholds.maxUnderlyingAgeMs,
      },
    ),
    fxFreshness: check(
      readiness?.marketData?.fx?.status === 'LIVE'
      && normalizedThresholds.maxFxAgeMs != null
      && fxAgeMs != null
      && fxAgeMs <= normalizedThresholds.maxFxAgeMs,
      'FX conversion evidence age exceeds the approved operational threshold',
      {
        status: readiness?.marketData?.fx?.status || null,
        observedAgeMs: fxAgeMs,
        thresholdMs: normalizedThresholds.maxFxAgeMs,
      },
    ),
    platformEvents: check(
      platform.enabled === true
      && platform.started === true
      && platform.webhookConfigured === true
      && Number(platform.deadEvents || 0) === 0
      && normalizedThresholds.maxPlatformEventFailures != null
      && Number(platform.deliveryFailures || 0) <= normalizedThresholds.maxPlatformEventFailures,
      'Platform event relay is unhealthy or above the approved failure threshold',
      {
        enabled: platform.enabled === true,
        started: platform.started === true,
        webhookConfigured: platform.webhookConfigured === true,
        deadEvents: finiteOrNull(platform.deadEvents),
        deliveryFailures: finiteOrNull(platform.deliveryFailures),
        threshold: normalizedThresholds.maxPlatformEventFailures,
      },
    ),
    durableRisk: check(
      risk.started === true
      && risk.durableOrderedRisk === true
      && normalizedThresholds.maxRiskInFlight != null
      && Number(risk.inFlight || 0) <= normalizedThresholds.maxRiskInFlight,
      'Durable risk processing is unhealthy or above the approved in-flight threshold',
      {
        started: risk.started === true,
        durableOrderedRisk: risk.durableOrderedRisk === true,
        inFlight: finiteOrNull(risk.inFlight),
        threshold: normalizedThresholds.maxRiskInFlight,
      },
    ),
    reconciliation: check(
      reconciliation?.recovery?.consistent !== false
      && !['DEGRADED', 'ISSUES'].includes(String(reconciliation?.state || '').toUpperCase())
      && normalizedThresholds.maxReconciliationIssues != null
      && Number(reconciliation?.lastReport?.issueCount ?? reconciliation?.issueCount ?? 0)
        <= normalizedThresholds.maxReconciliationIssues,
      'Reconciliation is degraded or above the approved issue threshold',
      {
        state: reconciliation?.state || null,
        recoveryConsistent: reconciliation?.recovery?.consistent !== false,
        issueCount: finiteOrNull(reconciliation?.lastReport?.issueCount ?? reconciliation?.issueCount ?? 0),
        threshold: normalizedThresholds.maxReconciliationIssues,
      },
    ),
  };

  const operationalReady = Object.values(checks).every(item => item.pass);

  return {
    contractVersion: 'GLOBAL_MARKETS_OPERATIONAL_GATE_V1',
    asOf: new Date(nowMs).toISOString(),
    symbol: readiness?.symbol || null,
    status: operationalReady ? 'OPERATIONALLY_READY_FOR_STAGING_EVIDENCE' : 'BLOCKED',
    operationalReady,
    productionAuthorized: false,
    thresholds: normalizedThresholds,
    checks,
    alerts: Object.entries(checks)
      .filter(([, item]) => !item.pass)
      .map(([name, item]) => ({
        severity: name === 'thresholdsConfigured' ? 'CONFIGURATION' : 'BLOCKING',
        check: name,
        reason: item.reason,
        observed: item.observed || null,
      })),
  };
}

function normalizeThresholds(input) {
  return Object.freeze({
    maxUnderlyingAgeMs: positiveOrNull(input.maxUnderlyingAgeMs),
    maxFxAgeMs: positiveOrNull(input.maxFxAgeMs),
    maxPlatformEventFailures: nonNegativeOrNull(input.maxPlatformEventFailures),
    maxRiskInFlight: nonNegativeOrNull(input.maxRiskInFlight),
    maxReconciliationIssues: nonNegativeOrNull(input.maxReconciliationIssues),
  });
}

function conversionEvidenceAgeMs(evidence, nowMs) {
  const path = Array.isArray(evidence?.path) ? evidence.path : [];
  if (path.length === 0) return 0;

  const ages = [];
  for (const leg of path) {
    for (const timestamp of [
      leg?.quoteReceivedAtMs,
      leg?.quoteSourceAtMs,
      leg?.receivedAtMs,
      leg?.sourceTimestampMs,
    ]) {
      const value = Number(timestamp);
      if (Number.isFinite(value)) ages.push(Math.max(0, Number(nowMs) - value));
    }
  }
  return ages.length ? Math.max(...ages) : null;
}

function configuredPositive(value, env) {
  return { pass: Number.isFinite(value) && value > 0, env };
}

function configuredNonNegative(value, env) {
  return { pass: Number.isFinite(value) && value >= 0, env };
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function maxFinite(values) {
  const numbers = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function check(pass, reason, observed = null) {
  return Object.freeze({ pass: pass === true, reason: pass === true ? null : reason, observed });
}

module.exports = {
  buildGlobalMarketsOperationalGate,
  conversionEvidenceAgeMs,
  normalizeThresholds,
};
