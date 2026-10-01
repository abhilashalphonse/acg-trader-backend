'use strict';

const EventEmitter = require('events');

class MultiProviderAdapter extends EventEmitter {
  constructor({ adapters, logger = null }) {
    super();
    this.adapters = new Map(Object.entries(adapters || {}).filter(([, adapter]) => adapter));
    this.logger = logger;
    this.bound = new Map();
    this.activeProviders = new Set();
    this.providerStates = new Map();
    this.lastAggregateState = null;
    this.providerName = 'multi-provider';
  }

  start(subscriptions) {
    const grouped = new Map();
    for (const subscription of Array.isArray(subscriptions) ? subscriptions : []) {
      const provider = subscription.provider || 'twelve-data';
      if (!grouped.has(provider)) grouped.set(provider, []);
      grouped.get(provider).push(subscription);
    }

    const tasks = [];
    for (const [provider, items] of grouped.entries()) {
      const adapter = this.adapters.get(provider);
      if (!adapter) {
        const error = new Error(`No market-data adapter configured for provider: ${provider}`);
        error.code = 'MARKET_PROVIDER_UNAVAILABLE';
        this.emit('adapter-error', Object.assign(error, { provider }));
        continue;
      }
      this.activeProviders.add(provider);
      this.#bind(provider, adapter);
      tasks.push(Promise.resolve(adapter.start(items)));
    }

    return Promise.all(tasks);
  }

  async stop() {
    const tasks = [];
    for (const provider of this.activeProviders) {
      const adapter = this.adapters.get(provider);
      if (adapter) tasks.push(Promise.resolve(adapter.stop()));
    }
    await Promise.allSettled(tasks);
    this.activeProviders.clear();
    this.providerStates.clear();
    this.lastAggregateState = null;
    this.#unbindAll();
    this.emit('connection', { state: 'STOPPED', timestamp: Date.now(), provider: 'multi-provider' });
  }

  async fetchLatestPrice({ provider = 'twelve-data', ...args }) {
    const adapter = this.#adapter(provider);
    return adapter.fetchLatestPrice({ provider, ...args });
  }

  supportsHistory(timeframe, provider = 'twelve-data') {
    const adapter = this.adapters.get(provider);
    return Boolean(adapter?.supportsHistory?.(timeframe));
  }

  async fetchHistorical({ provider = 'twelve-data', ...args }) {
    const adapter = this.#adapter(provider);
    return adapter.fetchHistorical({ provider, ...args });
  }

  #adapter(provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      const error = new Error(`No market-data adapter configured for provider: ${provider}`);
      error.code = 'MARKET_PROVIDER_UNAVAILABLE';
      throw error;
    }
    return adapter;
  }

  #bind(provider, adapter) {
    if (this.bound.has(provider)) return;

    const listeners = {
      price: event => this.emit('price', { provider, ...event }),
      connection: event => {
        const normalized = { provider, ...event };
        this.providerStates.set(provider, normalized.state);
        this.emit('provider-connection', normalized);
        this.#emitAggregateConnection(normalized);
      },
      error: error => {
        if (error && typeof error === 'object') error.provider = error.provider || provider;
        this.emit('adapter-error', error);
      },
      subscription: event => this.emit('subscription-status', { provider, ...event }),
    };

    adapter.on('price', listeners.price);
    adapter.on('connection', listeners.connection);
    adapter.on('adapter-error', listeners.error);
    adapter.on('subscription-status', listeners.subscription);
    this.bound.set(provider, { adapter, listeners });
  }

  #emitAggregateConnection(lastEvent = {}) {
    const states = [...this.activeProviders].map(provider => this.providerStates.get(provider) || 'CONNECTING');
    let state = 'CONNECTING';

    if (!states.length) state = 'STOPPED';
    else if (states.every(item => item === 'LIVE')) state = 'LIVE';
    else if (states.some(item => item === 'LIVE')) state = 'LIVE';
    else if (states.some(item => item === 'ERROR')) state = 'ERROR';
    else if (states.every(item => ['DISCONNECTED', 'STOPPED'].includes(item))) state = 'DISCONNECTED';

    if (state === this.lastAggregateState) return;
    this.lastAggregateState = state;
    this.emit('connection', {
      state,
      timestamp: Number(lastEvent.timestamp) || Date.now(),
      provider: 'multi-provider',
      providers: Object.fromEntries(this.providerStates),
    });
  }

  status() {
    return {
      provider: this.providerName,
      providers: Object.fromEntries(this.providerStates),
      activeProviders: [...this.activeProviders],
    };
  }

  #unbindAll() {
    for (const { adapter, listeners } of this.bound.values()) {
      adapter.off('price', listeners.price);
      adapter.off('connection', listeners.connection);
      adapter.off('adapter-error', listeners.error);
      adapter.off('subscription-status', listeners.subscription);
    }
    this.bound.clear();
  }
}

module.exports = { MultiProviderAdapter };
