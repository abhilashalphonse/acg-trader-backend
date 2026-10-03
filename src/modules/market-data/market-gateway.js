'use strict';

const { normalizeSymbol } = require('./market.utils');
const { MARKET_CONNECTION_STATES } = require('./market.constants');
const { ExecutionPricingService } = require('./execution-pricing');
const { TickSanityFilter } = require('./tick-sanity-filter');
const { isInstrumentSessionOpen } = require('../instruments/session-calendar');

const RECOVERY_COOLDOWN_MS = 2500;

class MarketGateway {
  constructor({
    adapter,
    instrumentRegistry,
    quoteStore,
    candleEngine,
    eventBus,
    dayChangeService = null,
    symbols,
    staleCheckMs,
    logger,
    executionPricing = null,
    tickSanityFilter = null,
    onStreamRecovered = null,
  }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.quoteStore = quoteStore;
    this.candleEngine = candleEngine;
    this.eventBus = eventBus;
    this.dayChangeService = dayChangeService;
    this.symbols = symbols.map(normalizeSymbol);
    this.staleCheckMs = staleCheckMs;
    this.logger = logger;
    this.executionPricing = executionPricing || new ExecutionPricingService();
    this.tickSanityFilter = tickSanityFilter || new TickSanityFilter();
    this.onStreamRecovered = typeof onStreamRecovered === 'function' ? onStreamRecovered : null;
    this.streamOutage = false;
    this.providerOutages = new Set();
    this.subscriptionErrors = new Map();

    this.connectionState = MARKET_CONNECTION_STATES.DISCONNECTED;
    this.symbolStates = new Map(this.symbols.map(symbol => [symbol, 'WAITING']));
    this.sessionStates = new Map();
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
    this.onProviderConnection = event => this.#onProviderConnection(event);
  }

  async start() {
    await this.instrumentRegistry.load();
    this.startedAtMs = Date.now();
    this.candleEngine.start();

    this.adapter.on('price', this.onPrice);
    this.adapter.on('connection', this.onConnection);
    this.adapter.on('adapter-error', this.onAdapterError);
    this.adapter.on('subscription-status', this.onSubscriptionStatus);
    this.adapter.on?.('provider-connection', this.onProviderConnection);

    await this.adapter.start(this.instrumentRegistry.providerSubscriptions());
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
    this.adapter.off?.('provider-connection', this.onProviderConnection);

    await Promise.allSettled([...this.recoveryInFlight.values()]);
    this.recoveryInFlight.clear();
    this.priorityRefs.clear();
    this.subscriptionErrors.clear();
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

    if (this.subscriptionErrors.has(canonical)) {
      this.#setSymbolState(canonical, 'SUBSCRIPTION_ERROR');
      return count;
    }

    const quote = this.quoteStore.get(canonical);
    if (!quote || this.#quoteAgeMs(quote) > this.#softAgeMs(canonical)) {
      void this.ensureFreshQuote(canonical, { reason: 'priority-retained' }).catch(() => undefined);
    }
    void this.dayChangeService?.ensure?.(canonical).catch?.(() => undefined);
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
    const subscriptionError = this.subscriptionErrors.get(canonical);
    if (subscriptionError) {
      const staleQuote = this.quoteStore.markStale(canonical, true);
      if (staleQuote && current?.isStale !== true) this.eventBus.emit('market.quote', staleQuote);
      this.candleEngine.setSymbolLive(canonical, false);
      this.#setSymbolState(canonical, 'SUBSCRIPTION_ERROR');
      const error = new Error(subscriptionError);
      error.code = 'MARKET_SUBSCRIPTION_UNAVAILABLE';
      throw error;
    }

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
      .then(() => this.adapter.fetchLatestPrice({ provider: instrument.provider || 'twelve-data', providerSymbol: instrument.providerSymbol }))
      .then(raw => {
        this.#onPrice({
          ...raw,
          symbol: canonical,
          providerSymbol: instrument.providerSymbol,
          source: raw?.source || ((instrument.provider || 'twelve-data') + '-rest'),
          quoteOnly: true,
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
      provider: this.adapter.providerName || 'twelve-data',
      state: this.connectionState,
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      symbols: this.symbols.map(symbol => {
        const quote = this.quoteStore.get(symbol);
        const instrument = this.instrumentRegistry.get(symbol);
        return {
          symbol,
          state: this.symbolStates.get(symbol) || 'WAITING',
          provider: this.instrumentRegistry.provider?.(symbol) || 'twelve-data',
          providerSymbol: this.instrumentRegistry.providerSymbol(symbol),
          configured: Boolean(instrument?.configured),
          sessionOpen: this.#sessionOpenAt(instrument, now),
          lastReceivedAt: quote?.receivedAtMs ? new Date(quote.receivedAtMs).toISOString() : null,
          ageMs: quote?.receivedAtMs ? Math.max(0, now - quote.receivedAtMs) : null,
          softQuoteAgeMs: instrument?.softQuoteAgeMs ?? null,
          maxQuoteAgeMs: instrument?.maxQuoteAgeMs ?? null,
          priority: this.priorityCount(symbol) > 0,
          isStale: quote?.isStale ?? true,
          marketDataAvailable: !this.subscriptionErrors.has(symbol),
          subscriptionError: this.subscriptionErrors.get(symbol) || null,
          tickSanity: this.tickSanityFilter.snapshot(symbol),
        };
      }),
    };
  }

  #onConnection(event) {
    const previousState = this.connectionState;
    this.connectionState = event.state;
    let recovered = false;

    if (event.state === MARKET_CONNECTION_STATES.DISCONNECTED) {
      this.streamOutage = true;
      for (const symbol of this.symbols) {
        // A disconnected stream must never fabricate carry-forward chart bars.
        // Keep a still-fresh quote executable, but break candle continuity immediately.
        this.candleEngine.setSymbolLive(symbol, false);
        this.tickSanityFilter.resetPending(symbol);
        const quote = this.quoteStore.get(symbol);
        const instrument = this.instrumentRegistry.get(symbol);
        const ageMs = this.#quoteAgeMs(quote);
        if (!quote || !instrument || ageMs > instrument.maxQuoteAgeMs) {
          const staleQuote = this.quoteStore.markStale(symbol, true);
          if (staleQuote) this.eventBus.emit('market.quote', staleQuote);
          this.#setSymbolState(symbol, 'DISCONNECTED');
        }
        if (this.priorityCount(symbol) > 0) {
          void this.ensureFreshQuote(symbol, { reason: 'stream-disconnected' }).catch(() => undefined);
        }
      }
    } else if (event.state === MARKET_CONNECTION_STATES.LIVE && this.streamOutage) {
      recovered = true;
      this.streamOutage = false;
      try {
        this.onStreamRecovered?.({
          previousState,
          timestamp: Number(event.timestamp) || Date.now(),
        });
      } catch (error) {
        this.logger?.warn?.({ err: error }, 'Market stream recovery hook failed');
      }
    }

    this.#emitGatewayStatus({ code: event.code, reason: event.reason, recovered });
  }

  #onProviderConnection(event) {
    const provider = event?.provider;
    if (!provider || provider === 'multi-provider') return;

    const affectedSymbols = this.instrumentRegistry.providerSubscriptions()
      .filter(item => item.provider === provider)
      .map(item => item.symbol);

    if (!affectedSymbols.length) return;

    if (['DISCONNECTED', 'ERROR', 'STOPPED'].includes(event.state)) {
      this.providerOutages.add(provider);
      for (const symbol of affectedSymbols) {
        this.candleEngine.setSymbolLive(symbol, false);
        this.tickSanityFilter.resetPending(symbol);

        const quote = this.quoteStore.get(symbol);
        const instrument = this.instrumentRegistry.get(symbol);
        const ageMs = this.#quoteAgeMs(quote);
        if (!quote || !instrument || ageMs > instrument.maxQuoteAgeMs) {
          const staleQuote = this.quoteStore.markStale(symbol, true);
          if (staleQuote) this.eventBus.emit('market.quote', staleQuote);
          this.#setSymbolState(symbol, 'DISCONNECTED');
        }
      }
    } else if (event.state === 'LIVE' && this.providerOutages.has(provider)) {
      this.providerOutages.delete(provider);
      try {
        this.onStreamRecovered?.({
          provider,
          timestamp: Number(event.timestamp) || Date.now(),
        });
      } catch (error) {
        this.logger?.warn?.({ err: error, provider }, 'Market provider recovery hook failed');
      }
    }

    this.eventBus.emit('market.status', {
      scope: 'provider',
      provider,
      state: event.state,
      timestamp: Number(event.timestamp) || Date.now(),
      reason: event.reason || '',
    });
  }

  #onAdapterError(error) {
    const provider = error?.provider || this.adapter.providerName || 'twelve-data';
    this.logger.warn({ err: error, provider }, 'Market-data provider error');
    this.eventBus.emit('market.status', {
      scope: 'provider',
      provider,
      state: 'ERROR',
      message: error.message,
      timestamp: Date.now(),
    });
  }

  #onSubscriptionStatus(event) {
    const provider = event?.provider || this.adapter.providerName || 'twelve-data';
    this.logger.info({ provider, event: event.event, status: event.status, success: event.success, fails: event.fails }, 'Market-data subscription status');

    const subscriptions = this.instrumentRegistry.providerSubscriptions();
    const resolveSubscription = providerSymbol => subscriptions.find(item => (
      item.providerSymbol === providerSymbol
      && (!event?.provider || item.provider === event.provider)
    ));

    if (Array.isArray(event.fails)) {
      for (const failure of event.fails) {
        const providerSymbol = typeof failure === 'string' ? failure : (failure?.symbol || failure?.meta?.symbol);
        const subscription = resolveSubscription(providerSymbol);
        if (!subscription) continue;

        const canonical = normalizeSymbol(subscription.symbol);
        const message = typeof failure === 'string'
          ? `${providerSymbol} is unavailable from ${provider}`
          : (failure?.message || `${providerSymbol} is unavailable from ${provider}`);
        this.subscriptionErrors.set(canonical, message);
        this.candleEngine.setSymbolLive(canonical, false);
        const quote = this.quoteStore.markStale(canonical, true);
        if (quote) this.eventBus.emit('market.quote', quote);
        this.#setSymbolState(canonical, 'SUBSCRIPTION_ERROR');
      }
    }

    if (Array.isArray(event.success)) {
      for (const success of event.success) {
        const providerSymbol = typeof success === 'string' ? success : success?.symbol;
        const subscription = resolveSubscription(providerSymbol);
        if (!subscription) continue;

        const canonical = normalizeSymbol(subscription.symbol);
        const hadError = this.subscriptionErrors.delete(canonical);
        if (!hadError) continue;

        const quote = this.quoteStore.get(canonical);
        const instrument = this.instrumentRegistry.get(canonical);
        const ageMs = this.#quoteAgeMs(quote);
        const nextState = quote && instrument && ageMs <= instrument.maxQuoteAgeMs ? 'LIVE' : 'WAITING';
        this.#setSymbolState(canonical, nextState);
        if (this.priorityCount(canonical) > 0) {
          void this.ensureFreshQuote(canonical, { reason: 'subscription-recovered', force: true }).catch(() => undefined);
        }
      }
    }
  }

  #onPrice(raw) {
    const receivedAtMs = Date.now();
    const symbol = normalizeSymbol(raw.symbol);
    const instrument = this.instrumentRegistry.get(symbol);
    if (!instrument || !this.symbols.includes(symbol)) return;

    const lastPrice = Number(raw.price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      this.logger?.warn?.({ symbol, price: raw.price }, 'Ignoring non-positive market price');
      return;
    }

    const sanity = this.tickSanityFilter.inspect({
      symbol,
      raw: { ...raw, price: lastPrice },
      instrument,
      receivedAtMs,
    });

    if (!sanity.accepted.length) {
      if (sanity.reason === 'QUARANTINED' || sanity.reason === 'REPLACED_QUARANTINE') {
        this.logger?.debug?.({
          symbol,
          price: lastPrice,
          reason: sanity.reason,
          threshold: sanity.threshold,
        }, 'Quarantining suspicious market tick pending confirmation');
      } else if (sanity.reason === 'OUT_OF_ORDER') {
        this.logger?.debug?.({ symbol, price: lastPrice, providerTimestampMs: raw.providerTimestampMs }, 'Ignoring out-of-order market tick');
      }
      return;
    }

    if (sanity.reason === 'REJECTED_ISOLATED_SPIKE') {
      this.logger?.warn?.({
        symbol,
        price: lastPrice,
        threshold: sanity.threshold,
      }, 'Rejected isolated provider price spike');
    } else if (sanity.reason === 'CONFIRMED_JUMP') {
      this.logger?.info?.({
        symbol,
        price: lastPrice,
        threshold: sanity.threshold,
      }, 'Confirmed large provider price move');
    }

    for (const accepted of sanity.accepted) {
      this.#publishPrice(accepted.raw, accepted.receivedAtMs);
    }
  }

  #publishPrice(raw, receivedAtMs) {
    const symbol = normalizeSymbol(raw.symbol);
    const instrument = this.instrumentRegistry.get(symbol);
    if (!instrument || !this.symbols.includes(symbol)) return;

    const lastPrice = Number(raw.price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;

    const providerTimestampMs = Number(raw.providerTimestampMs);
    // Provider/event time is authoritative for chart construction whenever it
    // exists. Never rewrite an old provider event as "now": a stale Friday
    // tick received on Saturday must not become a Saturday candle.
    const marketTimeMs = Number.isFinite(providerTimestampMs) && providerTimestampMs > 0
      ? Math.trunc(providerTimestampMs)
      : receivedAtMs;

    const normalizedPrices = this.#normalizePrices({ ...raw, price: lastPrice }, instrument, receivedAtMs);
    const sequence = (this.sequences.get(symbol) || 0) + 1;
    this.sequences.set(symbol, sequence);

    // The quote carries the authoritative backend session state for the event
    // time. Frontends also receive wall-clock session transition events from
    // #checkQuoteFreshness(), so they do not need to infer exchange calendars.
    const sessionOpen = this.#sessionOpenAt(instrument, marketTimeMs);
    const baseTick = {
      symbol,
      sequence,
      price: lastPrice,
      last: lastPrice,
      bid: normalizedPrices.bid,
      ask: normalizedPrices.ask,
      mid: normalizedPrices.mid,
      spread: normalizedPrices.spread,
      spreadPoints: normalizedPrices.spreadPoints,
      providerSpreadPoints: normalizedPrices.providerSpreadPoints,
      referencePrice: normalizedPrices.referencePrice,
      pricingModel: normalizedPrices.pricingModel,
      spreadSource: normalizedPrices.spreadSource,
      volatilityMultiplier: normalizedPrices.volatilityMultiplier,
      sessionMultiplier: normalizedPrices.sessionMultiplier,
      providerTimestampMs: Number.isFinite(providerTimestampMs) ? Math.trunc(providerTimestampMs) : null,
      receivedAtMs,
      timeMs: marketTimeMs,
      source: raw.source || raw.provider || this.instrumentRegistry.provider?.(symbol) || 'twelve-data',
      providerSymbol: raw.providerSymbol,
      isSyntheticSpread: normalizedPrices.isSyntheticSpread,
      dayVolume: raw.dayVolume,
      isStale: false,
      sessionOpen,
    };
    const tick = Object.freeze(this.dayChangeService?.decorate?.(baseTick) || baseTick);

    const previousState = this.symbolStates.get(symbol);
    this.subscriptionErrors.delete(symbol);
    const quoteOnly = raw.quoteOnly === true;
    const quote = this.quoteStore.set(tick);
    this.#setSymbolState(symbol, 'LIVE');

    // Quotes may continue to arrive while the configured trading session is
    // closed. Keep the last quote visible/fresh, but never turn those messages
    // into market ticks or OHLC. The event timestamp is used deliberately so a
    // delayed in-session tick stays attached to its real market time.

    // REST latest-price recovery is also quote-only. Neither a REST snapshot
    // nor an out-of-session websocket message may reopen candle continuity.
    if (quoteOnly || !sessionOpen) {
      if (!sessionOpen) this.candleEngine.setSymbolLive(symbol, false);
      this.eventBus.emit('market.quote', quote);
      return;
    }

    this.candleEngine.setSymbolLive(symbol, true);
    this.eventBus.emit('market.tick', tick);
    this.eventBus.emit('market.quote', quote);
    this.candleEngine.processTick(tick);

    if (previousState !== 'LIVE' && previousState !== 'REFRESHING') {
      this.logger.info({ symbol, source: tick.source }, 'Market symbol is live');
    }
  }

  #normalizePrices(raw, instrument, nowMs = Date.now()) {
    return this.executionPricing.priceQuote({ raw, instrument, nowMs });
  }

  #checkQuoteFreshness() {
    const now = Date.now();
    for (const symbol of this.symbols) {
      const quote = this.quoteStore.get(symbol);
      const instrument = this.instrumentRegistry.get(symbol);
      if (!instrument) continue;

      this.#syncSessionState(symbol, instrument, now);

      if (this.subscriptionErrors.has(symbol)) {
        this.candleEngine.setSymbolLive(symbol, false);
        const staleQuote = this.quoteStore.markStale(symbol, true);
        if (staleQuote && quote?.isStale !== true) this.eventBus.emit('market.quote', staleQuote);
        this.#setSymbolState(symbol, 'SUBSCRIPTION_ERROR');
        continue;
      }

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

  #sessionOpenAt(instrument, timeMs = Date.now()) {
    if (!instrument) return false;
    try {
      return isInstrumentSessionOpen(instrument, timeMs);
    } catch (error) {
      this.logger?.warn?.({ err: error, symbol: instrument?.symbol, timeMs }, 'Market-session validation failed; treating session as closed');
      return false;
    }
  }

  #syncSessionState(symbol, instrument, nowMs = Date.now()) {
    const sessionOpen = this.#sessionOpenAt(instrument, nowMs);
    const previous = this.sessionStates.get(symbol);
    if (previous === sessionOpen) return sessionOpen;

    this.sessionStates.set(symbol, sessionOpen);
    if (!sessionOpen) this.candleEngine.setSymbolLive(symbol, false);
    this.eventBus.emit('market.status', {
      scope: 'symbol',
      symbol,
      state: this.symbolStates.get(symbol) || 'WAITING',
      sessionOpen,
      timestamp: nowMs,
      reason: 'session-transition',
    });
    return sessionOpen;
  }

  #setSymbolState(symbol, state) {
    const previous = this.symbolStates.get(symbol);
    if (previous === state) return;
    this.symbolStates.set(symbol, state);
    const instrument = this.instrumentRegistry.get(symbol);
    const now = Date.now();
    const sessionOpen = this.#sessionOpenAt(instrument, now);
    this.sessionStates.set(symbol, sessionOpen);
    this.eventBus.emit('market.status', {
      scope: 'symbol',
      symbol,
      state,
      sessionOpen,
      timestamp: now,
    });
  }

  #emitGatewayStatus(extra = {}) {
    this.eventBus.emit('market.status', {
      scope: 'gateway',
      provider: this.adapter.providerName || 'twelve-data',
      state: this.connectionState,
      timestamp: Date.now(),
      ...extra,
    });
  }
}

module.exports = { MarketGateway };
