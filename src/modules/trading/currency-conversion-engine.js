'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { normalizeDecimal, multiplyDecimal, divideDecimal, compareDecimal } = require('../../shared/decimal/decimal');

let defaultEngine = null;

class CurrencyConversionEngine {
  constructor({ quoteStore, symbols = [], maxQuoteAgeMs = 10000 } = {}) {
    this.quoteStore = quoteStore;
    this.symbols = new Set((symbols || []).map(symbol => normalizePair(symbol)).filter(Boolean));
    this.maxQuoteAgeMs = Number(maxQuoteAgeMs) || 10000;
  }
  convert(amount, fromCurrency, toCurrency, { nowMs = Date.now() } = {}) {
    const amountDecimal = normalizeDecimal(amount);
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    if (!from || !to) throw conversionUnavailable(from, to);
    if (from === to || compareDecimal(amountDecimal, '0') === 0) return amountDecimal;
    const direct = this.#convertLeg(amountDecimal, from, to, nowMs);
    if (direct != null) return direct;
    if (from !== 'USD' && to !== 'USD') {
      const usd = this.#convertLeg(amountDecimal, from, 'USD', nowMs);
      if (usd != null) {
        const target = this.#convertLeg(usd, 'USD', to, nowMs);
        if (target != null) return target;
      }
    }
    throw conversionUnavailable(from, to);
  }
  canConvert(fromCurrency, toCurrency, options = {}) {
    try { this.convert('1', fromCurrency, toCurrency, options); return true; } catch { return false; }
  }
  #convertLeg(amount, from, to, nowMs) {
    const positive = compareDecimal(amount, '0') >= 0;
    const directSymbol = `${from}${to}`;
    if (this.#symbolAvailable(directSymbol)) {
      const quote = this.#quote(directSymbol, nowMs);
      if (quote) return multiplyDecimal(amount, normalizeDecimal(String(positive ? quote.bid : quote.ask)));
    }
    const inverseSymbol = `${to}${from}`;
    if (this.#symbolAvailable(inverseSymbol)) {
      const quote = this.#quote(inverseSymbol, nowMs);
      if (quote) return divideDecimal(amount, normalizeDecimal(String(positive ? quote.ask : quote.bid)), { scale: 12 });
    }
    return null;
  }
  #symbolAvailable(symbol) { return !this.symbols.size || this.symbols.has(symbol); }
  #quote(symbol, nowMs) {
    const quote = this.quoteStore?.get?.(symbol);
    if (!quote || quote.isStale) return null;
    const bid = Number(quote.bid); const ask = Number(quote.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    const receivedAtMs = Number(quote.receivedAtMs);
    if (!Number.isFinite(receivedAtMs) || Math.max(0, nowMs - receivedAtMs) > this.maxQuoteAgeMs) return null;
    return quote;
  }
}

function setDefaultCurrencyConversionEngine(engine) { defaultEngine = engine || null; return defaultEngine; }
function getDefaultCurrencyConversionEngine() { return defaultEngine; }
function normalizeCurrency(value) { const code = String(value || '').trim().toUpperCase(); return /^[A-Z]{3}$/.test(code) ? code : ''; }
function normalizePair(value) { return String(value || '').replace('/', '').trim().toUpperCase(); }
function conversionUnavailable(from, to) {
  return new AppError('Live currency conversion path is unavailable', { statusCode: 409, code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE', details: { fromCurrency: from || null, toCurrency: to || null } });
}

module.exports = { CurrencyConversionEngine, setDefaultCurrencyConversionEngine, getDefaultCurrencyConversionEngine, normalizeCurrency };
