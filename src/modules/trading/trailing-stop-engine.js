'use strict';

const { Position } = require('./position.model');

class TrailingStopEngine {
  constructor({ eventBus, trailingStopService, logger, positionModel = Position }) {
    this.eventBus = eventBus;
    this.trailingStopService = trailingStopService;
    this.logger = logger;
    this.positionModel = positionModel;
    this.positions = new Map();
    this.positionsBySymbol = new Map();
    this.inFlight = new Map();
    this.started = false;

    this.onTick = tick => this.#onTick(tick);
    this.onPositionOpened = position => this.#upsert(position);
    this.onPositionUpdated = position => this.#upsert(position);
    this.onPositionClosed = position => this.#remove(position);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.#attach();
    try {
      const positions = await this.positionModel.find({ status: 'OPEN', 'trailing.enabled': true }).lean();
      for (const position of positions) this.#store(position);
      this.logger?.info({ trailingPositions: this.positions.size }, 'Trailing stop engine recovered');
    } catch (error) {
      this.#detach();
      this.started = false;
      throw error;
    }
  }

  async stop() {
    if (!this.started) return;
    this.#detach();
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.positions.clear();
    this.positionsBySymbol.clear();
    this.started = false;
  }

  health() {
    return {
      started: this.started,
      trailingPositions: this.positions.size,
      inFlight: this.inFlight.size,
    };
  }

  #attach() {
    this.eventBus.on('market.tick', this.onTick);
    this.eventBus.on('trading.position.opened', this.onPositionOpened);
    this.eventBus.on('trading.position.updated', this.onPositionUpdated);
    this.eventBus.on('trading.position.closed', this.onPositionClosed);
  }

  #detach() {
    this.eventBus.off('market.tick', this.onTick);
    this.eventBus.off('trading.position.opened', this.onPositionOpened);
    this.eventBus.off('trading.position.updated', this.onPositionUpdated);
    this.eventBus.off('trading.position.closed', this.onPositionClosed);
  }

  #onTick(tick) {
    if (!tick?.symbol || tick.isStale) return;
    const symbol = String(tick.symbol).toUpperCase();
    const ids = [...(this.positionsBySymbol.get(symbol) || [])];
    for (const id of ids) {
      if (this.inFlight.has(id)) continue;
      const position = this.positions.get(id);
      if (!position) continue;
      const promise = this.trailingStopService.advance({
        accountId: position.accountId,
        positionId: id,
        tick,
      }).catch(error => {
        this.logger?.error({ err: error, positionId: id }, 'Trailing stop advancement failed');
      }).finally(() => {
        if (this.inFlight.get(id) === promise) this.inFlight.delete(id);
      });
      this.inFlight.set(id, promise);
    }
  }

  #upsert(position) {
    const normalized = normalizeTrailingPosition(position);
    if (!normalized.id || normalized.status !== 'OPEN' || !normalized.trailingEnabled) {
      this.#remove(position);
      return;
    }
    this.#store(normalized);
  }

  #store(position) {
    const normalized = normalizeTrailingPosition(position);
    if (!normalized.id || normalized.status !== 'OPEN' || !normalized.trailingEnabled) return;
    const previous = this.positions.get(normalized.id);
    if (previous) removeIndex(this.positionsBySymbol, previous.symbol, normalized.id);
    this.positions.set(normalized.id, normalized);
    addIndex(this.positionsBySymbol, normalized.symbol, normalized.id);
  }

  #remove(position) {
    const id = String(position?.id || position?._id || '');
    if (!id) return;
    const existing = this.positions.get(id);
    if (existing) removeIndex(this.positionsBySymbol, existing.symbol, id);
    this.positions.delete(id);
  }
}

function normalizeTrailingPosition(position) {
  return {
    id: String(position?.id || position?._id || ''),
    accountId: String(position?.accountId || ''),
    symbol: String(position?.symbol || '').toUpperCase(),
    status: String(position?.status || 'OPEN').toUpperCase(),
    trailingEnabled: Boolean(position?.trailing?.enabled),
  };
}

function addIndex(map, key, value) {
  if (!key) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeIndex(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
}

module.exports = { TrailingStopEngine, normalizeTrailingPosition };
