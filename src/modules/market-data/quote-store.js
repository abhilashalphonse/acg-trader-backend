'use strict';

const { normalizeSymbol } = require('./market.utils');

class QuoteStore {
  constructor() {
    this.quotes = new Map();
  }

  set(quote) {
    const symbol = normalizeSymbol(quote.symbol);
    const stored = Object.freeze({ ...quote, symbol });
    this.quotes.set(symbol, stored);
    return stored;
  }

  get(symbol) {
    return this.quotes.get(normalizeSymbol(symbol)) || null;
  }

  getMany(symbols) {
    return symbols.map(symbol => this.get(symbol)).filter(Boolean);
  }

  snapshot() {
    return [...this.quotes.values()];
  }

  markStale(symbol, isStale = true) {
    const current = this.get(symbol);
    if (!current || current.isStale === isStale) return current;
    return this.set({ ...current, isStale });
  }

  clear() {
    this.quotes.clear();
  }
}

module.exports = { QuoteStore };
