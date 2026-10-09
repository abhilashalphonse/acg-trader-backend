'use strict';

const { isInstrumentSessionOpen } = require('../instruments/session-calendar');
const { sourceTimestampMs } = require('../trading/currency-conversion-engine');

function buildGlobalMarketsReadiness({
  symbol = 'RELIANCE',
  instrument = null,
  quoteStore = null,
  currencyConverter = null,
  platformEventsHealth = null,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const normalizedSymbol = String(symbol || 'RELIANCE').trim().toUpperCase();
  const quote = instrument ? quoteStore?.get?.(normalizedSymbol) : null;
  const quoteState = classifyQuote(quote, instrument?.maxQuoteAgeMs, nowMs);
  const sessionOpen = instrument ? isInstrumentSessionOpen(instrument, nowMs) : false;
  const fx = conversionReadiness({
    currencyConverter,
    fromCurrency: instrument?.marginCurrency || instrument?.quoteCurrency || null,
    toCurrency: 'USD',
    nowMs,
  });

  const checks = {
    providerMulti: check(config.marketProvider === 'multi', 'MARKET_PROVIDER must be multi'),
    indiaMarketEnabled: check(config.indiaMarketEnabled === true, 'INDIA_MARKET_ENABLED must be true'),
    accelpixConfigured: check(config.accelpixConfigured === true, 'ACCELPIX_API_KEY is not configured'),
    instrumentFound: check(Boolean(instrument), `${normalizedSymbol} is missing from the instrument catalog`),
    instrumentTerms: check(
      Boolean(instrument)
      && String(instrument.assetClass || '').toUpperCase() === 'EQUITY'
      && String(instrument.quoteCurrency || '').toUpperCase() === 'INR'
      && String(instrument.marginCurrency || instrument.quoteCurrency || '').toUpperCase() === 'INR'
      && Number(instrument.defaultLeverage) === 10
      && Number(instrument.leveragePolicyVersion || 0) === 2
      && String(instrument.corporateActionPolicy || '').toUpperCase() === 'UNSUPPORTED',
      'Pilot terms must be INR EQUITY, 1:10 leverage policy v2, corporate actions UNSUPPORTED',
    ),
    sessionOpen: check(sessionOpen, 'Instrument execution session is closed'),
    underlyingQuoteLive: check(quoteState.status === 'LIVE', `Underlying quote is ${quoteState.status}`),
    usdConversionLive: check(fx.status === 'LIVE', 'USD conversion path is unavailable or stale'),
    platformEventsHealthy: check(
      platformEventsHealth?.enabled === true
      && platformEventsHealth?.started === true
      && platformEventsHealth?.webhookConfigured === true
      && Number(platformEventsHealth?.deadEvents || 0) === 0,
      'Platform event relay must be enabled, started, webhook-configured and free of dead events',
    ),
  };

  const activationPrerequisites = [
    checks.providerMulti,
    checks.indiaMarketEnabled,
    checks.accelpixConfigured,
    checks.instrumentFound,
    checks.instrumentTerms,
    checks.sessionOpen,
    checks.underlyingQuoteLive,
    checks.usdConversionLive,
    checks.platformEventsHealthy,
  ];
  const activationReady = activationPrerequisites.every(item => item.pass);
  const executionEnabled = instrument?.executionEnabled === true;
  const executionProvisionVersion = Number(instrument?.executionProvisionVersion || 0);
  // The staging pilot deliberately uses UNSUPPORTED equity corporate actions
  // while exercising financial plumbing. That is not customer-release approval:
  // any unmitigated corporate action can change already-open positions.
  const corporateActionCustomerSafe = false;
  const customerReleaseBlockers = [
    ...(!corporateActionCustomerSafe ? [{
      check: 'corporateActionOpenPositionSafety',
      reason: 'Corporate-action handling for existing positions is not implemented or independently verified',
    }] : []),
    ...(!activationReady ? [{
      check: 'stagingReadiness',
      reason: 'Underlying staging prerequisites have not passed',
    }] : []),
  ];

  return {
    contractVersion: 'GLOBAL_MARKETS_READINESS_V1',
    symbol: normalizedSymbol,
    asOf: new Date(nowMs).toISOString(),
    status: activationReady ? (executionEnabled ? 'EXECUTION_READY' : 'READY_TO_ENABLE_PILOT') : 'BLOCKED',
    activationReady,
    executionReady: activationReady && executionEnabled,
    customerReleaseReady: false,
    customerReleaseBlockers,
    checks,
    instrument: instrument ? {
      assetClass: instrument.assetClass || null,
      quoteCurrency: instrument.quoteCurrency || null,
      marginCurrency: instrument.marginCurrency || instrument.quoteCurrency || null,
      pnlCurrency: instrument.pnlCurrency || instrument.quoteCurrency || null,
      defaultLeverage: Number(instrument.defaultLeverage || 0),
      leveragePolicyVersion: Number(instrument.leveragePolicyVersion || 0),
      corporateActionPolicy: instrument.corporateActionPolicy || null,
      sessionOpen,
      executionEnabled,
      executionProvisionVersion,
    } : null,
    marketData: {
      underlying: quoteState,
      fx,
    },
    platformEvents: sanitizePlatformEventsHealth(platformEventsHealth),
    blockers: Object.entries(checks)
      .filter(([, item]) => !item.pass)
      .map(([name, item]) => ({ check: name, reason: item.reason })),
  };
}

function check(pass, reason) {
  return Object.freeze({ pass: pass === true, reason: pass === true ? null : reason });
}

function classifyQuote(quote, maxQuoteAgeMs, nowMs) {
  if (!quote) return { status: 'MISSING', source: null, sequence: null, ageMs: null, sourceAgeMs: null };

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return quoteSummary(quote, 'INVALID', nowMs);
  }

  const maxAge = Number(maxQuoteAgeMs);
  const receivedAtMs = Number(quote.receivedAtMs);
  const sourceAtMs = sourceTimestampMs(quote);
  const receivedAge = Number.isFinite(receivedAtMs) ? Math.max(0, Number(nowMs) - receivedAtMs) : null;
  const sourceAge = Number.isFinite(sourceAtMs) ? Math.max(0, Number(nowMs) - sourceAtMs) : null;
  const staleByAge = Number.isFinite(maxAge) && maxAge > 0 && (
    receivedAge == null
    || receivedAge > maxAge
    || (sourceAge != null && sourceAge > maxAge)
  );

  return quoteSummary(quote, quote.isStale || staleByAge ? 'STALE' : 'LIVE', nowMs);
}

function quoteSummary(quote, status, nowMs) {
  const receivedAtMs = Number(quote?.receivedAtMs);
  const sourceAtMs = sourceTimestampMs(quote);
  return {
    status,
    bid: finiteString(quote?.bid),
    ask: finiteString(quote?.ask),
    source: quote?.source || null,
    sequence: quote?.sequence ?? null,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : null,
    sourceAtMs: Number.isFinite(sourceAtMs) ? sourceAtMs : null,
    ageMs: Number.isFinite(receivedAtMs) ? Math.max(0, Number(nowMs) - receivedAtMs) : null,
    sourceAgeMs: Number.isFinite(sourceAtMs) ? Math.max(0, Number(nowMs) - sourceAtMs) : null,
  };
}

function conversionReadiness({ currencyConverter, fromCurrency, toCurrency, nowMs }) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!from || !to) return { status: 'UNAVAILABLE', fromCurrency: from || null, toCurrency: to || null, evidence: null };
  if (from === to) return { status: 'LIVE', fromCurrency: from, toCurrency: to, evidence: { path: [] } };

  try {
    const result = currencyConverter?.convertWithEvidence?.('1', from, to, {
      nowMs,
      purpose: 'MARGIN',
    });
    if (!result) throw new Error('No conversion result');
    return {
      status: 'LIVE',
      fromCurrency: from,
      toCurrency: to,
      amount: result.amount,
      evidence: result.evidence || null,
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE',
      fromCurrency: from,
      toCurrency: to,
      errorCode: error?.code || 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
      evidence: null,
    };
  }
}

function sanitizePlatformEventsHealth(health) {
  if (!health || typeof health !== 'object') return null;
  return {
    enabled: health.enabled === true,
    started: health.started === true,
    webhookConfigured: health.webhookConfigured === true,
    pendingSnapshots: Number.isFinite(Number(health.pendingSnapshots)) ? Number(health.pendingSnapshots) : null,
    snapshotRetryPending: Number.isFinite(Number(health.snapshotRetryPending)) ? Number(health.snapshotRetryPending) : null,
    deliveryFailures: Number.isFinite(Number(health.deliveryFailures)) ? Number(health.deliveryFailures) : null,
    deadEvents: Number.isFinite(Number(health.deadEvents)) ? Number(health.deadEvents) : null,
    lastSuccessfulDeliveryAt: health.lastSuccessfulDeliveryAt || null,
    lastDeliveryFailureAt: health.lastDeliveryFailureAt || null,
  };
}

function finiteString(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(value) : null;
}

module.exports = {
  buildGlobalMarketsReadiness,
  classifyQuote,
  conversionReadiness,
};
