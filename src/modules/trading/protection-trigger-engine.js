'use strict';

const { Position } = require('./position.model');
const { detectProtectionTrigger } = require('./protection-trigger');

class ProtectionTriggerEngine {
  constructor({
    eventBus,
    marketOrderService,
    logger,
    positionModel = Position,
  }) {
    this.eventBus = eventBus;
    this.marketOrderService = marketOrderService;
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
      // Avoid querying nullable Decimal128 fields with `$ne: null`. Some
      // Mongoose versions can attempt to cast the operator object itself as a
      // Decimal128 value. Recover all open positions and let #store decide
      // whether SL/TP protection is present.
      const positions = await this.positionModel.find({ status: 'OPEN' }).lean();
      for (const position of positions) this.#store(position);
      this.logger?.info({ protectedPositions: this.positions.size }, 'SL/TP protection engine recovered');
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
      protectedPositions: this.positions.size,
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
      const detected = detectProtectionTrigger({ position, tick });
      if (!detected) continue;

      const promise = this.#execute(position, detected, tick)
        .catch(error => {
          this.logger?.error({ err: error, positionId: id, reason: detected.reason }, 'Protective close execution failed');
        })
        .finally(() => {
          if (this.inFlight.get(id) === promise) this.inFlight.delete(id);
        });
      this.inFlight.set(id, promise);
    }
  }

  async #execute(position, detected, tick) {
    const payload = {
      accountId: position.accountId,
      positionId: position.id,
      symbol: position.symbol,
      reason: detected.reason,
      triggerPrice: detected.triggerPrice,
      executablePrice: detected.executablePrice,
      quoteSequence: detected.quoteSequence,
      quoteReceivedAtMs: detected.quoteReceivedAtMs,
      timestamp: Date.now(),
    };
    this.eventBus.emit('protection.triggered', payload);

    const clientOrderId = buildProtectionClientOrderId(position.id, detected.reason, tick);
    try {
      const result = await this.marketOrderService.closeMarketPosition({
        accountId: position.accountId,
        positionId: position.id,
        clientOrderId,
        requestedPrice: detected.triggerPrice,
        source: 'SYSTEM',
        reason: detected.reason,
      });
      this.eventBus.emit('protection.executed', {
        ...payload,
        orderId: result?.order?.orderId || null,
        dealId: result?.deal?.dealId || null,
        fillPrice: result?.deal?.price || null,
        idempotentReplay: Boolean(result?.idempotentReplay),
      });
      return result;
    } catch (error) {
      if (['POSITION_NOT_OPEN', 'POSITION_NOT_FOUND'].includes(error?.code)) {
        this.eventBus.emit('protection.skipped', { ...payload, code: error.code });
        return null;
      }
      this.eventBus.emit('protection.failed', {
        ...payload,
        code: error?.code || 'PROTECTIVE_CLOSE_FAILED',
        message: error?.message || 'Protective close failed',
      });
      throw error;
    }
  }

  #upsert(position) {
    const normalized = normalizeProtectionPosition(position);
    if (!normalized.id || normalized.status !== 'OPEN' || (!normalized.stopLoss && !normalized.takeProfit)) {
      this.#remove(position);
      return;
    }
    this.#store(normalized);
  }

  #store(position) {
    const normalized = normalizeProtectionPosition(position);
    if (!normalized.id || normalized.status !== 'OPEN' || (!normalized.stopLoss && !normalized.takeProfit)) return;
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

function normalizeProtectionPosition(position) {
  return {
    id: String(position?.id || position?._id || ''),
    positionId: String(position?.positionId || ''),
    accountId: String(position?.accountId || ''),
    symbol: String(position?.symbol || '').toUpperCase(),
    side: String(position?.side || '').toUpperCase(),
    status: String(position?.status || 'OPEN').toUpperCase(),
    stopLoss: decimalOrNull(position?.stopLoss),
    takeProfit: decimalOrNull(position?.takeProfit),
  };
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return value.toString();
}

function buildProtectionClientOrderId(positionId, reason, tick) {
  const shortReason = reason === 'STOP_LOSS' ? 'sl' : 'tp';
  const sequence = tick?.sequence ?? 'na';
  const receivedAtMs = tick?.receivedAtMs ?? Date.now();
  return `protect:${shortReason}:${positionId}:${sequence}:${receivedAtMs}`.slice(0, 128);
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

module.exports = {
  ProtectionTriggerEngine,
  normalizeProtectionPosition,
  buildProtectionClientOrderId,
};
