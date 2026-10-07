'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
  subtractDecimal,
} = require('../../shared/decimal/decimal');

let defaultEngine = null;

const CONVERSION_PURPOSES = Object.freeze({
  GENERAL: 'GENERAL',
  LOSS_LIABILITY: 'LOSS_LIABILITY',
  PROCEEDS: 'PROCEEDS',
  EXPOSURE: 'EXPOSURE',
  MARGIN: 'MARGIN',
  FEES: 'FEES',
});

class CurrencyConversionEngine {
  constructor({ quoteStore, symbols = [], maxQuoteAgeMs = 10000 } = {}) {
    this.quoteStore = quoteStore;
    this.symbols = new Set((symbols || []).map(symbol => normalizePair(symbol)).filter(Boolean));
    this.maxQuoteAgeMs = Number(maxQuoteAgeMs) || 10000;
  }

  convert(amount, fromCurrency, toCurrency, options = {}) {
    return this.convertWithEvidence(amount, fromCurrency, toCurrency, options).amount;
  }

  convertWithEvidence(amount, fromCurrency, toCurrency, {
    nowMs = Date.now(),
    purpose = CONVERSION_PURPOSES.GENERAL,
  } = {}) {
    const amountDecimal = normalizeDecimal(amount);
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    const normalizedPurpose = normalizePurpose(purpose);
    if (!from || !to) throw conversionUnavailable(from, to);

    if (from === to) {
      return {
        amount: amountDecimal,
        evidence: Object.freeze({
          purpose: normalizedPurpose,
          fromCurrency: from,
          toCurrency: to,
          inputAmount: amountDecimal,
          outputAmount: amountDecimal,
          path: [],
          capturedAtMs: Number(nowMs),
        }),
      };
    }

    const liabilityMagnitude = normalizedPurpose === CONVERSION_PURPOSES.LOSS_LIABILITY
      && compareDecimal(amountDecimal, '0') >= 0;
    const economicAmount = liabilityMagnitude
      ? subtractDecimal('0', amountDecimal)
      : amountDecimal;

    const direct = this.#convertLeg(economicAmount, from, to, nowMs);
    if (direct) return finalizeConversion(direct, {
      amountDecimal,
      from,
      to,
      purpose: normalizedPurpose,
      liabilityMagnitude,
      nowMs,
    });

    if (from !== 'USD' && to !== 'USD') {
      const usd = this.#convertLeg(economicAmount, from, 'USD', nowMs);
      if (usd) {
        const target = this.#convertLeg(usd.amount, 'USD', to, nowMs);
        if (target) {
          return finalizeConversion({
            amount: target.amount,
            path: [...usd.path, ...target.path],
          }, {
            amountDecimal,
            from,
            to,
            purpose: normalizedPurpose,
            liabilityMagnitude,
            nowMs,
          });
        }
      }
    }

    throw conversionUnavailable(from, to);
  }

  canConvert(fromCurrency, toCurrency, options = {}) {
    try {
      this.convert('1', fromCurrency, toCurrency, options);
      return true;
    } catch {
      return false;
    }
  }

  #convertLeg(amount, from, to, nowMs) {
    const positive = compareDecimal(amount, '0') >= 0;
    const directSymbol = `${from}${to}`;
    if (this.#symbolAvailable(directSymbol)) {
      const quote = this.#quote(directSymbol, nowMs);
      if (quote) {
        const side = positive ? 'bid' : 'ask';
        const rate = normalizeDecimal(String(quote[side]));
        return {
          amount: multiplyDecimal(amount, rate),
          path: [conversionLegEvidence({
            symbol: directSymbol,
            direction: 'DIRECT',
            side,
            rate,
            quote,
          })],
        };
      }
    }

    const inverseSymbol = `${to}${from}`;
    if (this.#symbolAvailable(inverseSymbol)) {
      const quote = this.#quote(inverseSymbol, nowMs);
      if (quote) {
        const side = positive ? 'ask' : 'bid';
        const rate = normalizeDecimal(String(quote[side]));
        return {
          amount: divideDecimal(amount, rate, { scale: 12 }),
          path: [conversionLegEvidence({
            symbol: inverseSymbol,
            direction: 'INVERSE',
            side,
            rate,
            quote,
          })],
        };
      }
    }
    return null;
  }

  #symbolAvailable(symbol) {
    return !this.symbols.size || this.symbols.has(symbol);
  }

  #quote(symbol, nowMs) {
    const quote = this.quoteStore?.get?.(symbol);
    if (!quote || quote.isStale) return null;
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
    const receivedAtMs = Number(quote.receivedAtMs);
    if (!Number.isFinite(receivedAtMs) || Math.max(0, nowMs - receivedAtMs) > this.maxQuoteAgeMs) return null;

    const sourceTimestampMs = Number(
      quote.sourceTimestampMs
      ?? quote.timestampMs
      ?? quote.eventTimestampMs
      ?? quote.receivedAtMs,
    );
    if (Number.isFinite(sourceTimestampMs) && Math.max(0, nowMs - sourceTimestampMs) > this.maxQuoteAgeMs) return null;
    return quote;
  }
}

function finalizeConversion(result, {
  amountDecimal,
  from,
  to,
  purpose,
  liabilityMagnitude,
  nowMs,
}) {
  const output = liabilityMagnitude
    ? absoluteDecimal(result.amount)
    : normalizeDecimal(result.amount);

  return {
    amount: output,
    evidence: Object.freeze({
      purpose,
      fromCurrency: from,
      toCurrency: to,
      inputAmount: amountDecimal,
      outputAmount: output,
      path: Object.freeze(result.path.map(leg => Object.freeze(leg))),
      capturedAtMs: Number(nowMs),
    }),
  };
}

function conversionLegEvidence({ symbol, direction, side, rate, quote }) {
  return {
    symbol,
    direction,
    side,
    rate,
    bid: normalizeDecimal(String(quote.bid)),
    ask: normalizeDecimal(String(quote.ask)),
    source: quote.source || null,
    sourceTimestampMs: finiteNumber(
      quote.sourceTimestampMs
      ?? quote.timestampMs
      ?? quote.eventTimestampMs,
    ),
    receivedAtMs: finiteNumber(quote.receivedAtMs),
    sequence: quote.sequence ?? null,
  };
}

function absoluteDecimal(value) {
  const normalized = normalizeDecimal(value);
  return compareDecimal(normalized, '0') < 0
    ? subtractDecimal('0', normalized)
    : normalized;
}

function normalizePurpose(value) {
  const normalized = String(value || CONVERSION_PURPOSES.GENERAL).trim().toUpperCase();
  return Object.values(CONVERSION_PURPOSES).includes(normalized)
    ? normalized
    : CONVERSION_PURPOSES.GENERAL;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function setDefaultCurrencyConversionEngine(engine) {
  defaultEngine = engine || null;
  return defaultEngine;
}
function getDefaultCurrencyConversionEngine() { return defaultEngine; }
function normalizeCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}
function normalizePair(value) { return String(value || '').replace('/', '').trim().toUpperCase(); }
function conversionUnavailable(from, to) {
  return new AppError('Live currency conversion path is unavailable', {
    statusCode: 409,
    code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
    details: { fromCurrency: from || null, toCurrency: to || null },
  });
}

module.exports = {
  CurrencyConversionEngine,
  CONVERSION_PURPOSES,
  setDefaultCurrencyConversionEngine,
  getDefaultCurrencyConversionEngine,
  normalizeCurrency,
};
