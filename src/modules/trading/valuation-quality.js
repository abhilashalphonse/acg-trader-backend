'use strict';

const {
  isInstrumentSessionOpen,
  previousSessionCloseTimeMs,
} = require('../instruments/session-calendar');

const INSTRUMENT_QUALITIES = Object.freeze({
  LIVE: 'LIVE',
  APPROVED_CLOSE: 'APPROVED_CLOSE',
  STALE: 'STALE',
  MISSING: 'MISSING',
});

const FX_QUALITIES = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  LIVE: 'LIVE',
  APPROVED_FALLBACK: 'APPROVED_FALLBACK',
  STALE: 'STALE',
  MISSING: 'MISSING',
});

const EXECUTION_AVAILABILITY = Object.freeze({
  OPEN_ALLOWED: 'OPEN_ALLOWED',
  CLOSED_SESSION: 'CLOSED_SESSION',
  HALTED: 'HALTED',
  DATA_BLOCKED: 'DATA_BLOCKED',
});

function resolveInstrumentValuationQuality({ instrument = null, quote = null, nowMs = Date.now(), hasExecutablePrice = false } = {}) {
  if (!hasExecutablePrice || !quote) {
    return {
      instrumentValuationQuality: INSTRUMENT_QUALITIES.MISSING,
      executionAvailability: EXECUTION_AVAILABILITY.DATA_BLOCKED,
      approvedCloseAtMs: null,
    };
  }

  // Compatibility path for tests/legacy callers that do not supply catalog
  // metadata. Existing behavior remains LIVE/STALE based on the quote.
  if (!instrument) {
    const quality = quote.isStale ? INSTRUMENT_QUALITIES.STALE : INSTRUMENT_QUALITIES.LIVE;
    return {
      instrumentValuationQuality: quality,
      executionAvailability: quality === INSTRUMENT_QUALITIES.LIVE
        ? EXECUTION_AVAILABILITY.OPEN_ALLOWED
        : EXECUTION_AVAILABILITY.DATA_BLOCKED,
      approvedCloseAtMs: null,
    };
  }

  if (String(instrument.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    return {
      instrumentValuationQuality: INSTRUMENT_QUALITIES.STALE,
      executionAvailability: EXECUTION_AVAILABILITY.HALTED,
      approvedCloseAtMs: null,
    };
  }

  const sessionOpen = isInstrumentSessionOpen(instrument, nowMs);
  if (sessionOpen) {
    const quoteAgeMs = ageMs(quote.receivedAtMs, nowMs);
    const maxAgeMs = positiveNumber(instrument.maxQuoteAgeMs);
    const fresh = quote.isStale !== true && (maxAgeMs == null || quoteAgeMs <= maxAgeMs);
    return {
      instrumentValuationQuality: fresh ? INSTRUMENT_QUALITIES.LIVE : INSTRUMENT_QUALITIES.STALE,
      executionAvailability: fresh ? EXECUTION_AVAILABILITY.OPEN_ALLOWED : EXECUTION_AVAILABILITY.DATA_BLOCKED,
      approvedCloseAtMs: null,
    };
  }

  // Closed-market valuation contract:
  // use only the final executable mark that was fresh at the scheduled close.
  // Its validity lasts through the scheduled closure; current FX may continue
  // to revalue the USD account independently. A mid-session outage cannot be
  // promoted to APPROVED_CLOSE merely because the exchange later closed.
  const closeMs = previousSessionCloseTimeMs(instrument, nowMs);
  const markTimeMs = quoteSourceTimeMs(quote);
  const maxAgeMs = positiveNumber(instrument.maxQuoteAgeMs);
  const markWasFreshAtClose = Number.isFinite(closeMs)
    && Number.isFinite(markTimeMs)
    && markTimeMs <= closeMs
    && (maxAgeMs == null || closeMs - markTimeMs <= maxAgeMs);

  return {
    instrumentValuationQuality: markWasFreshAtClose
      ? INSTRUMENT_QUALITIES.APPROVED_CLOSE
      : INSTRUMENT_QUALITIES.STALE,
    executionAvailability: EXECUTION_AVAILABILITY.CLOSED_SESSION,
    approvedCloseAtMs: markWasFreshAtClose ? closeMs : null,
  };
}

function accountValuationQuality({ positionValuations = [], fxValuationQuality = FX_QUALITIES.NOT_REQUIRED, complete = true } = {}) {
  if (!complete) return 'MISSING';
  let instrumentQuality = INSTRUMENT_QUALITIES.LIVE;
  for (const valuation of positionValuations) {
    const quality = String(valuation?.instrumentValuationQuality || valuation?.valuationStatus || '').toUpperCase();
    if (['MISSING', 'WAITING'].includes(quality)) return 'MISSING';
    if (quality === INSTRUMENT_QUALITIES.STALE) instrumentQuality = INSTRUMENT_QUALITIES.STALE;
    else if (quality === INSTRUMENT_QUALITIES.APPROVED_CLOSE && instrumentQuality === INSTRUMENT_QUALITIES.LIVE) {
      instrumentQuality = INSTRUMENT_QUALITIES.APPROVED_CLOSE;
    }
  }
  if (![FX_QUALITIES.NOT_REQUIRED, FX_QUALITIES.LIVE, FX_QUALITIES.APPROVED_FALLBACK].includes(fxValuationQuality)) {
    return 'MISSING';
  }
  return instrumentQuality;
}

function isRiskValuationAcceptable(valuation) {
  if (!valuation || valuation.complete !== true) return false;
  const instrumentQuality = String(
    valuation.instrumentValuationQuality
      || valuation.accountValuationQuality
      || valuation.valuationStatus
      || '',
  ).toUpperCase();
  const fxQuality = String(valuation.fxValuationQuality || FX_QUALITIES.NOT_REQUIRED).toUpperCase();
  return [INSTRUMENT_QUALITIES.LIVE, INSTRUMENT_QUALITIES.APPROVED_CLOSE].includes(instrumentQuality)
    && [FX_QUALITIES.NOT_REQUIRED, FX_QUALITIES.LIVE, FX_QUALITIES.APPROVED_FALLBACK].includes(fxQuality);
}

function isPositionExecutable(valuation) {
  return Boolean(valuation)
    && valuation.executionAvailability === EXECUTION_AVAILABILITY.OPEN_ALLOWED
    && String(valuation.instrumentValuationQuality || valuation.valuationStatus || '').toUpperCase() === INSTRUMENT_QUALITIES.LIVE;
}

function quoteSourceTimeMs(quote) {
  const candidates = [
    quote?.providerTimestampMs,
    quote?.sourceAtMs,
    quote?.sourceTimestampMs,
    quote?.timestampMs,
    quote?.timeMs,
    quote?.receivedAtMs,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function ageMs(timestamp, nowMs) {
  const value = Number(timestamp);
  return Number.isFinite(value) ? Math.max(0, Number(nowMs) - value) : Number.POSITIVE_INFINITY;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

module.exports = {
  INSTRUMENT_QUALITIES,
  FX_QUALITIES,
  EXECUTION_AVAILABILITY,
  resolveInstrumentValuationQuality,
  accountValuationQuality,
  isRiskValuationAcceptable,
  isPositionExecutable,
  quoteSourceTimeMs,
};
