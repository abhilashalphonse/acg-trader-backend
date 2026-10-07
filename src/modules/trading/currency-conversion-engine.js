'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');

let defaultEngine = null;

const CONVERSION_PURPOSES = Object.freeze({
  GENERIC: 'GENERIC',
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

  createContext({ nowMs = Date.now() } = {}) {
    const snapshots = new Map();
    const quoteResolver = symbol => {
      const key = normalizePair(symbol);
      if (!snapshots.has(key)) {
        const quote = this.quoteStore?.get?.(key);
        snapshots.set(key, quote ? Object.freeze({ ...quote }) : null);
      }
      return snapshots.get(key);
    };
    const fixedNowMs = Number(nowMs);
    return Object.freeze({
      nowMs: fixedNowMs,
      convert: (amount, fromCurrency, toCurrency, options = {}) => this.convert(
        amount,
        fromCurrency,
        toCurrency,
        { ...options, nowMs: fixedNowMs, quoteResolver },
      ),
      convertWithEvidence: (amount, fromCurrency, toCurrency, options = {}) => this.convertWithEvidence(
        amount,
        fromCurrency,
        toCurrency,
        { ...options, nowMs: fixedNowMs, quoteResolver },
      ),
      canConvert: (fromCurrency, toCurrency, options = {}) => {
        try {
          this.convert('0', fromCurrency, toCurrency, { ...options, nowMs: fixedNowMs, quoteResolver });
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  convert(amount, fromCurrency, toCurrency, options = {}) {
    return this.convertWithEvidence(amount, fromCurrency, toCurrency, options).amount;
  }

  convertWithEvidence(amount, fromCurrency, toCurrency, {
    nowMs = Date.now(),
    purpose = CONVERSION_PURPOSES.GENERIC,
    quoteResolver = null,
  } = {}) {
    const inputAmount = normalizeDecimal(amount);
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    const normalizedPurpose = normalizePurpose(purpose);
    if (!from || !to) throw conversionUnavailable(from, to);

    if (from === to) {
      return Object.freeze({
        amount: normalizePurposeResult(inputAmount, inputAmount, normalizedPurpose),
        evidence: Object.freeze({
          fromCurrency: from,
          toCurrency: to,
          inputAmount,
          economicAmount: inputAmount,
          purpose: normalizedPurpose,
          path: Object.freeze([]),
          convertedAtMs: Number(nowMs),
        }),
      });
    }

    // A positive stop-risk number represents a liability, while realized loss
    // reaches settlement as a negative amount. Normalize the economic sign so
    // preview and settlement select the same FX side for identical inputs.
    const economicAmount = economicAmountForPurpose(inputAmount, normalizedPurpose);

    const direct = this.#convertLeg(economicAmount, from, to, nowMs, quoteResolver);
    if (direct) return finalizeConversion({ inputAmount, economicAmount, from, to, purpose: normalizedPurpose, result: direct, nowMs });

    if (from !== 'USD' && to !== 'USD') {
      const usd = this.#convertLeg(economicAmount, from, 'USD', nowMs, quoteResolver);
      if (usd) {
        const target = this.#convertLeg(usd.amount, 'USD', to, nowMs, quoteResolver);
        if (target) {
          return finalizeConversion({
            inputAmount,
            economicAmount,
            from,
            to,
            purpose: normalizedPurpose,
            result: {
              amount: target.amount,
              legs: [...usd.legs, ...target.legs],
            },
            nowMs,
          });
        }
      }
    }

    throw conversionUnavailable(from, to);
  }

  canConvert(fromCurrency, toCurrency, options = {}) {
    try {
      // Do not special-case zero: dependency completeness requires a usable
      // conversion path even when the current native amount happens to be zero.
      this.convert('0', fromCurrency, toCurrency, options);
      return true;
    } catch {
      return false;
    }
  }

  #convertLeg(amount, from, to, nowMs, quoteResolver = null) {
    const positive = compareDecimal(amount, '0') >= 0;
    const directSymbol = `${from}${to}`;
    if (this.#symbolAvailable(directSymbol)) {
      const quote = this.#quote(directSymbol, nowMs, quoteResolver);
      if (quote) {
        const selectedSide = positive ? 'BID' : 'ASK';
        const quoteRate = normalizeDecimal(String(positive ? quote.bid : quote.ask));
        return {
          amount: multiplyDecimal(amount, quoteRate),
          legs: [conversionLeg({
            symbol: directSymbol,
            from,
            to,
            operation: 'MULTIPLY',
            selectedSide,
            quoteRate,
            quote,
          })],
        };
      }
    }

    const inverseSymbol = `${to}${from}`;
    if (this.#symbolAvailable(inverseSymbol)) {
      const quote = this.#quote(inverseSymbol, nowMs, quoteResolver);
      if (quote) {
        const selectedSide = positive ? 'ASK' : 'BID';
        const quoteRate = normalizeDecimal(String(positive ? quote.ask : quote.bid));
        return {
          amount: divideDecimal(amount, quoteRate, { scale: 12 }),
          legs: [conversionLeg({
            symbol: inverseSymbol,
            from,
            to,
            operation: 'DIVIDE',
            selectedSide,
            quoteRate,
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

  #quote(symbol, nowMs, quoteResolver = null) {
    const quote = quoteResolver ? quoteResolver(symbol) : this.quoteStore?.get?.(symbol);
    if (!quote) return null;
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;

    const quality = fxQualityOfQuote(quote);
    if (quality === 'APPROVED_FALLBACK') {
      const approvedUntilMs = Number(quote.approvedUntilMs);
      if (!Number.isFinite(approvedUntilMs) || Number(nowMs) > approvedUntilMs) return null;
      return quote;
    }

    if (quote.isStale) return null;
    const receivedAtMs = Number(quote.receivedAtMs);
    if (!Number.isFinite(receivedAtMs) || Math.max(0, nowMs - receivedAtMs) > this.maxQuoteAgeMs) return null;

    // Receipt freshness alone is insufficient: a delayed provider event with
    // a recent local receipt must not be promoted into an authoritative FX rate.
    const sourceAtMs = sourceTimestampMs(quote);
    if (Number.isFinite(sourceAtMs) && Math.max(0, nowMs - sourceAtMs) > this.maxQuoteAgeMs) return null;
    return quote;
  }
}

function conversionLeg({ symbol, from, to, operation, selectedSide, quoteRate, quote }) {
  return Object.freeze({
    symbol,
    fromCurrency: from,
    toCurrency: to,
    operation,
    selectedSide,
    quoteRate,
    quoteSequence: quote?.sequence ?? null,
    quoteSource: quote?.source ?? null,
    quoteReceivedAtMs: Number.isFinite(Number(quote?.receivedAtMs)) ? Number(quote.receivedAtMs) : null,
    quoteSourceAtMs: sourceTimestampMs(quote),
    fxValuationQuality: fxQualityOfQuote(quote),
    approvedUntilMs: Number.isFinite(Number(quote?.approvedUntilMs)) ? Number(quote.approvedUntilMs) : null,
  });
}

function fxQualityOfQuote(quote) {
  return String(quote?.fxValuationQuality || '').trim().toUpperCase() === 'APPROVED_FALLBACK'
    ? 'APPROVED_FALLBACK'
    : 'LIVE';
}

function sourceTimestampMs(quote) {
  const candidates = [
    quote?.providerTimestampMs,
    quote?.sourceAtMs,
    quote?.sourceTimestampMs,
    quote?.timestampMs,
    quote?.timeMs,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function finalizeConversion({ inputAmount, economicAmount, from, to, purpose, result, nowMs }) {
  return Object.freeze({
    amount: normalizePurposeResult(inputAmount, result.amount, purpose),
    evidence: Object.freeze({
      fromCurrency: from,
      toCurrency: to,
      inputAmount,
      economicAmount,
      purpose,
      path: Object.freeze(result.legs || []),
      convertedAtMs: Number(nowMs),
    }),
  });
}

function economicAmountForPurpose(amount, purpose) {
  if (purpose !== CONVERSION_PURPOSES.LOSS_LIABILITY) return amount;
  if (compareDecimal(amount, '0') === 0) return '0';
  return compareDecimal(amount, '0') < 0 ? amount : subtractDecimal('0', amount);
}

function normalizePurposeResult(inputAmount, convertedAmount, purpose) {
  if (purpose !== CONVERSION_PURPOSES.LOSS_LIABILITY) return normalizeDecimal(convertedAmount);
  if (compareDecimal(convertedAmount, '0') < 0) return subtractDecimal('0', convertedAmount);
  // A liability API returns a positive magnitude even when callers supplied
  // an already-negative economic loss.
  if (compareDecimal(inputAmount, '0') < 0) return normalizeDecimal(convertedAmount);
  return normalizeDecimal(convertedAmount);
}

function normalizePurpose(value) {
  const normalized = String(value || CONVERSION_PURPOSES.GENERIC).trim().toUpperCase();
  return Object.values(CONVERSION_PURPOSES).includes(normalized)
    ? normalized
    : CONVERSION_PURPOSES.GENERIC;
}

function setDefaultCurrencyConversionEngine(engine) {
  defaultEngine = engine || null;
  return defaultEngine;
}

function getDefaultCurrencyConversionEngine() {
  return defaultEngine;
}

function normalizeCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

function normalizePair(value) {
  return String(value || '').replace('/', '').trim().toUpperCase();
}

function conversionUnavailable(from, to) {
  return new AppError('Live currency conversion path is unavailable', {
    statusCode: 409,
    code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
    details: { fromCurrency: from || null, toCurrency: to || null },
  });
}

module.exports = {
  CONVERSION_PURPOSES,
  CurrencyConversionEngine,
  setDefaultCurrencyConversionEngine,
  getDefaultCurrencyConversionEngine,
  normalizeCurrency,
  sourceTimestampMs,
  fxQualityOfQuote,
};
