'use strict';

const { normalizeSymbol } = require('./market.utils');
const { MARKET_CONNECTION_STATES } = require('./market.constants');

const RECOVERY_COOLDOWN_MS = 2500;

class MarketGateway {
  constructor({ adapter, instrumentRegistry, quoteStore, candleEngine, eventBus, symbols, staleCheckMs, logger }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.quoteStore = quoteStore;
    this.candleEngine = candleEngine;
    this.eventBus = eventBus;
    this.symbols = symbols.map(normalizeSymbol);
    this.staleCheckMs = staleCheckMs;
    this.logger = logger;

    this.connectionState = MARKET_CONNECTION_STATES.DISCONNECTED;
    this.symbolStates = new Map(this.symbols.map(symbol => [symbol, 'WAITING']));
    this.sequences = new Map(this.symbols.map(symbol => [symbol, 0]));
    this.priorityRefs = new Map();
    this.recoveryInFlight = new Map();
    this.lastRecoveryAttemptAt = new Map();
    this.startedAtMs = null;
    this.staleTimer = null;

    this.onPrice = raw => this.#onPrice(raw);
    this.onConnection = event => this.#onConnection(event);
    this.onAdapterError = error => this.#onAdapterError(error);
    this.onSubscriptionStatus = event => this.#onSubscriptionStatus(event);
  }

  async start() {
    await this.instrumentRegistry.load();
    this.startedAtMs = Date.now();
    this.candleEngine.start();

    this.adapter.on('price', this.onPrice);
    this.adapter.on('connection', this.onConnection);
    this.adapter.on('adapter-error', this.onAdapterError);
    this.adapter.on('subscription-status', this.onSubscriptionStatus);

    this.adapter.start(this.instrumentRegistry.providerSubscriptions());
    this.staleTimer = setInterval(() => this.#checkQuoteFreshness(), this.staleCheckMs);
    this.staleTimer.unref?.();
  }

  async stop() {
    clearInterval(this.staleTimer);
    this.staleTimer = null;

    this.adapter.off('price', this.onPrice);
    this.adapter.off('connection', this.onConnection);
    this.adapter.off('adapter-error', this.onAdapterError);
    this.adapter.off('subscription-status', this.onSubscriptionStatus);

    await Promise.allSettled([...this.recoveryInFlight.values()]);
    this.recoveryInFlight.clear();
    this.priorityRefs.clear();
    await this.adapter.stop();
    for (const symbol of this.symbols) this.candleEngine.setSymbolLive(symbol, false);
    await this.candleEngine.stop();
    this.connectionState = MARKET_CONNECTION_STATES.STOPPED;
    this.#emitGatewayStatus();
  }

  retainPriority(symbol) {
    const canonical = normalizeSymbol(symbol);
    if (!this.symbols.includes(canonical)) return 0;
    const count = (this.priorityRefs.get(canonical) || 0) + 1;
    this.priorityRefs.set(canonical, count);
    const quote = this.quoteStore.get(canonical);
    if (!quote || this.#quoteAgeMs(quote) > this.#softAgeMs(canonical)) {
      void this.ensureFreshQuote(canonical, { reason: 'priority-retained' }).catch(() => undefined);
    }
    return count;
  }

  releasePriority(symbol) {
    const canonical = normalizeSymbol(symbol);
    const previous = this.priorityRefs.get(canonical) || 0;
    if (previous <= 1) {
      this.priorityRefs.delete(canonical);
      return 0;
    }
    this.priorityRefs.set(canonical, previous - 1);
    return previous - 1;
  }

  priorityCount(symbol) {
    return this.priorityRefs.get(normalizeSymbol(symbol)) || 0;
  }

  async ensureFreshQuote(symbol, { reason = 'on-demand', force = false } = {}) {
    const canonical = normalizeSymbol(symbol);
    const instrument = this.instrumentRegistry.get(canonical);
    if (!instrument || !this.symbols.includes(canonical)) return null;

    const current = this.quoteStore.get(canonical);
    const ageMs = this.#quoteAgeMs(current);
    if (!force && current && !current.isStale && ageMs <= instrument.softQuoteAgeMs) return current;

    const existing = this.recoveryInFlight.get(canonical);
    if (existing) return existing;

    const now = Date.now();
    const lastAttempt = this.lastRecoveryAttemptAt.get(canonical) || 0;
    if (!force && current && now - lastAttempt < RECOVERY_COOLDOWN_MS) return current;
    this.lastRecoveryAttemptAt.set(canonical, now);

    if (current && ageMs <= instrument.maxQuoteAgeMs) this.#setSymbolState(canonical, 'REFRESHING');

    const task = Promise.resolve()
      .then(() => this.adapter.fetchLatestPrice({ providerSymbol: instrument.providerSymbol }))
      .then(raw => {
        this.#onPrice({
          ...raw,
          symbol: canonical,
          providerSymbol: instrument.providerSymbol,
          source: raw?.source || 'twelve-data-rest',
        });
        const recovered = this.quoteStore.get(canonical);
        this.logger?.debug?.({ symbol: canonical, reason }, 'Market quote recovered from latest-price endpoint');
        return recovered;
      })
      .catch(error => {
        const latest = this.quoteStore.get(canonical);
        const latestAge = this.#quoteAgeMs(latest);
        if (!latest || latestAge > instrument.maxQuoteAgeMs) {
          const staleQuote = this.quoteStore.markStale(canonical, true);
          if (staleQuote && latest?.isStale !== true) this.eventBus.emit('market.quote', staleQuote);
          this.candleEngine.setSymbolLive(canonical, false);
          this.#setSymbolState(canonical, 'UNAVAILABLE');
        } else {
          this.#setSymbolState(canonical, 'LIVE');
        }
        this.logger?.warn?.({ err: error, symbol: canonical, reason }, 'Market quote recovery failed');
        throw error;
      })
      .finally(() => {
        if (this.recoveryInFlight.get(canonical) === task) this.recoveryInFlight.delete(canonical);
      });

    this.recoveryInFlight.set(canonical, task);
    return task;
  }

  status() {
    const now = Date.now();
    return {
      provider: 'twelve-data',
      state: this.connectionState,
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      symbols: this.symbols.map(symbol => {
        const quote = this.quoteStore.get(symbol);
        const instrument = this.instrumentRegistry.get(symbol);
        return {
          symbol,
          state: this.symbolStates.get(symbol) || 'WAITING',
          providerSymbol: this.instrumentRegistry.providerSymbol(symbol),
          configured: Boolean(instrument?.configured),
          lastReceivedAt: quote?.receivedAtMs ? new Date(quote.receivedAtMs).toISOString() : null,
          ageMs: quote?.receivedAtMs ? Math.max(0, now - quote.receivedAtMs) : null,
          softQuoteAgeMs: instrument?.softQuoteAgeMs ?? null,
          maxQuoteAgeMs: instrument?.maxQuoteAgeMs ?? null,
          priority: this.priorityCount(symbol) > 0,
          isStale: quote?.isStale ?? true,
        };
      }),
    };
  }

  #onConnection(event) {
    this.connectionState = event.state;
    if (event.state === MARKET_CONNECTION_STATES.DISCONNECTED) {
      for (const symbol of this.symbols) {
        const quote = this.quoteStore.get(symbol);
        const instrument = this.instrumentRegistry.get(symbol);
        const ageMs = this.#quoteAgeMs(quote);
        if (!quote || !instrument || ageMs > instrument.maxQuoteAgeMs) {
          this.candleEngine.setSymbolLive(symbol, false);
          const staleQuote = this.quoteStore.markStale(symbol, true);
          if (staleQuote) this.eventBus.emit('market.quote', staleQuote);
          this.#setSymbolState(symbol, 'DISCONNECTED');
        }
        if (this.priorityCount(symbol) > 0) {
          void this.ensureFreshQuote(symbol, { reason: 'stream-disconnected' }).catch(() => undefined);
        }
      }
    }
    this.#emitGatewayStatus({ code: event.code, reason: event.reason });
  }

  #onAdapterError(error) {
    this.logger.warn({ err: error }, 'Market-data provider error');
    this.eventBus.emit('market.status', {
      scope: 'provider',
      provider: 'twelve-data',
      state: 'ERROR',
      message: error.message,
      timestamp: Date.now(),
    });
  }

  #onSubscriptionStatus(event) {
    this.logger.info({ event: event.event, status: event.status, success: event.success, fails: event.fails }, 'Twelve Data subscription status');
    if (Array.isArray(event.fails)) {
      for (const failure of event.fails) {
        const providerSymbol = failure.symbol || failure?.meta?.symbol;
        const subscription = this.instrumentRegistry.providerSubscriptions().find(item => item.providerSymbol === providerSymbol);
        if (subscription) this.#setSymbolState(subscription.symbol, 'SUBSCRIPTION_ERROR');
      }
    }
  }

  #onPrice(raw) {
    const receivedAtMs = Date.now();
    const symbol = normalizeSymbol(raw.symbol);
    const instrument = this.instrumentRegistry.get(symbol);
    if (!instrument || !this.symbols.includes(symbol)) return;

    const normalizedPrices = this.#normalizePrices(raw, instrument);
    const sequence = (this.sequences.get(symbol) || 0) + 1;
    this.sequences.set(symbol, sequence);

    const tick = Object.freeze({
      symbol,
      sequence,
      price: raw.price,
      last: raw.price,
      bid: normalizedPrices.bid,
      ask: normalizedPrices.ask,
      mid: normalizedPrices.mid,
      spread: normalizedPrices.spread,
      providerTimestampMs: raw.providerTimestampMs,
      receivedAtMs,
      timeMs: receivedAtMs,
      source: raw.source || 'twelve-data',
      providerSymbol: raw.providerSymbol,
      isSyntheticSpread: normalizedPrices.isSyntheticSpread,
      dayVolume: raw.dayVolume,
      isStale: false,
    });

    const previousState = this.symbolStates.get(symbol);
    this.candleEngine.setSymbolLive(symbol, true);
    const quote = this.quoteStore.set(tick);
    this.#setSymbolState(symbol, 'LIVE');

    this.eventBus.emit('market.tick', tick);
    this.eventBus.emit('market.quote', quote);
    this.candleEngine.processTick(tick);

    if (previousState !== 'LIVE' && previousState !== 'REFRESHING') {
      this.logger.info({ symbol, source: tick.source }, 'Market symbol is live');
    }
  }

  #normalizePrices(raw, instrument) {
    let bid = Number.isFinite(raw.bid) ? raw.bid : null;
    let ask = Number.isFinite(raw.ask) ? raw.ask : null;
    let isSyntheticSpread = false;
    const tickSize = instrument.tickSize;
    const markup = Number.isFinite(tickSize) ? Math.max(0, instrument.spread.markupPoints || 0) * tickSize : 0;

    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      if (markup > 0) {
        bid -= markup / 2;
        ask += markup / 2;
      }
    } else if (
      ['FIXED', 'SYNTHETIC'].includes(instrument.spread.mode)
      && Number.isFinite(tickSize)
      && Number.isFinite(instrument.spread.fixedPoints)
    ) {
      const spreadWidth = Math.max(0, instrument.spread.fixedPoints * tickSize + markup);
      bid = raw.price - spreadWidth / 2;
      ask = raw.price + spreadWidth / 2;
      isSyntheticSpread = true;
    } else {
      bid = null;
      ask = null;
    }

    const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.max(0, ask - bid) : null;
    const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : raw.price;
    return { bid, ask, mid, spread, isSyntheticSpread };
  }

  #checkQuoteFreshness() {
    const now = Date.now();
    for (const symbol of this.symbols) {
      const quote = this.quoteStore.get(symbol);
      const instrument = this.instrumentRegistry.get(symbol);
      if (!instrument) continue;

      if (!quote) {
        this.#setSymbolState(symbol, 'WAITING');
        if (this.priorityCount(symbol) > 0) {
          void this.ensureFreshQuote(symbol, { reason: 'missing-priority-quote' }).catch(() => undefined);
        }
        continue;
      }

      const ageMs = Math.max(0, now - quote.receivedAtMs);
      if (ageMs > instrument.maxQuoteAgeMs) {
        this.candleEngine.setSymbolLive(symbol, false);
        const staleQuote = this.quoteStore.markStale(symbol, true);
        if (staleQuote && quote.isStale !== true) this.eventBus.emit('market.quote', staleQuote);
        this.#setSymbolState(symbol, 'STALE');
        if (this.priorityCount(symbol) > 0) {
          void this.ensureFreshQuote(symbol, { reason: 'hard-stale-priority-quote' }).catch(() => undefined);
        }
        continue;
      }

      if (ageMs > instrument.softQuoteAgeMs) {
        this.#setSymbolState(symbol, 'REFRESHING');
        if (this.priorityCount(symbol) > 0) {
          void this.ensureFreshQuote(symbol, { reason: 'soft-stale-priority-quote' }).catch(() => undefined);
        }
        continue;
      }

      if (!quote.isStale) this.#setSymbolState(symbol, 'LIVE');
    }
  }

  #quoteAgeMs(quote) {
    const receivedAtMs = Number(quote?.receivedAtMs);
    return Number.isFinite(receivedAtMs) ? Math.max(0, Date.now() - receivedAtMs) : Number.POSITIVE_INFINITY;
  }

  #softAgeMs(symbol) {
    const instrument = this.instrumentRegistry.get(symbol);
    return instrument?.softQuoteAgeMs ?? instrument?.maxQuoteAgeMs ?? 5000;
  }

  #setSymbolState(symbol, state) {
    const previous = this.symbolStates.get(symbol);
    if (previous === state) return;
    this.symbolStates.set(symbol, state);
    this.eventBus.emit('market.status', {
      scope: 'symbol',
      symbol,
      state,
      timestamp: Date.now(),
    });
  }

  #emitGatewayStatus(extra = {}) {
    this.eventBus.emit('market.status', {
      scope: 'gateway',
      provider: 'twelve-data',
      state: this.connectionState,
      timestamp: Date.now(),
      ...extra,
    });
  }
}

module.exports = { MarketGateway };
