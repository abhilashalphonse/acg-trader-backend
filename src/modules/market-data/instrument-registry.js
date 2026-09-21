'use strict';

const { Instrument } = require('../instruments/instrument.model');
const { normalizeSymbol, defaultTwelveDataSymbol, decimalToNumber, mapValue } = require('./market.utils');

class InstrumentRegistry {
  constructor({ symbols, defaultMaxQuoteAgeMs, logger }) {
    this.symbols = symbols.map(normalizeSymbol);
    this.defaultMaxQuoteAgeMs = defaultMaxQuoteAgeMs;
    this.logger = logger;
    this.items = new Map();
  }

  async load() {
    const documents = await Promise.all(
      this.symbols.map(symbol => Instrument.findOne({ symbol }).lean())
    ).then(items => items.filter(Boolean));

    this.items.clear();

    for (const symbol of this.symbols) {
      const doc = documents.find(item => normalizeSymbol(item.symbol) === symbol);
      this.items.set(symbol, this.#normalize(doc, symbol));
    }

    const configured = documents.length;
    if (configured < this.symbols.length) {
      const missing = this.symbols.filter(symbol => !documents.some(item => normalizeSymbol(item.symbol) === symbol));
      this.logger.warn({ missing }, 'Some market symbols have no Instrument document; chart feed will use safe provider mappings only and no synthetic spread');
    }

    return this.snapshot();
  }

  #normalize(doc, symbol) {
    if (!doc) {
      return Object.freeze({
        symbol,
        configured: false,
        providerSymbol: defaultTwelveDataSymbol(symbol),
        tickSize: null,
        assetClass: null,
        softQuoteAgeMs: Math.max(1000, Math.round(this.defaultMaxQuoteAgeMs * 0.4)),
        maxQuoteAgeMs: this.defaultMaxQuoteAgeMs,
        spread: Object.freeze({
          mode: 'MARKET',
          fixedPoints: null,
          markupPoints: 0,
          normalPoints: null,
          minimumPoints: null,
          maximumPoints: null,
          rolloverMultiplier: 1,
          rolloverStartUtcMinute: null,
          rolloverEndUtcMinute: null,
          volumeBands: Object.freeze([]),
        }),
        status: 'ACTIVE',
        chartEnabled: true,
        executionEnabled: false,
      });
    }

    const providerSymbol = mapValue(doc.providerMappings, 'twelveData')
      || mapValue(doc.providerMappings, 'twelve-data')
      || defaultTwelveDataSymbol(symbol);

    return Object.freeze({
      symbol,
      configured: true,
      providerSymbol,
      tickSize: decimalToNumber(doc.tickSize),
      assetClass: doc.assetClass || null,
      softQuoteAgeMs: Math.min(
        Number(doc.maxQuoteAgeMs) || this.defaultMaxQuoteAgeMs,
        Number(doc.softQuoteAgeMs) || Math.max(1000, Math.round((Number(doc.maxQuoteAgeMs) || this.defaultMaxQuoteAgeMs) * 0.4)),
      ),
      maxQuoteAgeMs: Number(doc.maxQuoteAgeMs) || this.defaultMaxQuoteAgeMs,
      spread: Object.freeze({
        mode: doc.spread?.mode || 'MARKET',
        fixedPoints: decimalToNumber(doc.spread?.fixedPoints),
        markupPoints: decimalToNumber(doc.spread?.markupPoints, 0) || 0,
        normalPoints: decimalToNumber(doc.spread?.normalPoints),
        minimumPoints: decimalToNumber(doc.spread?.minimumPoints),
        maximumPoints: decimalToNumber(doc.spread?.maximumPoints),
        rolloverMultiplier: decimalToNumber(doc.spread?.rolloverMultiplier, 1) || 1,
        rolloverStartUtcMinute: doc.spread?.rolloverStartUtcMinute ?? null,
        rolloverEndUtcMinute: doc.spread?.rolloverEndUtcMinute ?? null,
        volumeBands: Object.freeze((doc.spread?.volumeBands || []).map(item => Object.freeze({
          upTo: decimalToNumber(item?.upTo),
          extraPoints: decimalToNumber(item?.extraPoints, 0) || 0,
        }))),
      }),
      status: doc.status || 'ACTIVE',
      chartEnabled: doc.chartEnabled !== false,
      executionEnabled: doc.executionEnabled === true,
    });
  }

  get(symbol) {
    return this.items.get(normalizeSymbol(symbol)) || null;
  }

  providerSymbol(symbol) {
    return this.get(symbol)?.providerSymbol || defaultTwelveDataSymbol(symbol);
  }

  providerSubscriptions() {
    return this.symbols.map(symbol => ({ symbol, providerSymbol: this.providerSymbol(symbol) }));
  }

  snapshot() {
    return this.symbols.map(symbol => this.get(symbol));
  }
}

module.exports = { InstrumentRegistry };
