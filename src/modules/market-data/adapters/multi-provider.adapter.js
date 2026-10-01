'use strict';

const EventEmitter = require('events');

class MultiProviderAdapter extends EventEmitter {
  constructor({ adapters, logger = null }) {
    super();
    this.adapters = new Map(Object.entries(adapters || {}).filter(([, adapter]) => adapter));
    this.logger = logger;
    this.bound = new Map();
    this.activeProviders = new Set();
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
    this.#unbindAll();
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
      connection: event => this.emit('connection', { provider, ...event }),
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
