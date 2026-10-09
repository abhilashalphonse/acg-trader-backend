'use strict';

const { Position } = require('./position.model');
const { detectProtectionTrigger } = require('./protection-trigger');

const RECOVERABLE_PROTECTION_CODES = new Set([
  'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  'ACCOUNT_VALUATION_NOT_LIVE',
  'CLOSE_PROJECTION_VALUATION_UNAVAILABLE',
  'EXECUTABLE_QUOTE_UNAVAILABLE',
  'QUOTE_STALE',
  'QUOTE_UNAVAILABLE',
  'STALE_VALUATION_REVISION',
]);

const TERMINAL_PROTECTION_CODES = new Set([
  'POSITION_NOT_OPEN',
  'POSITION_NOT_FOUND',
  'PROTECTION_TRIGGER_NO_LONGER_ACTIVE',
]);

const LATCH_KEYS = Object.freeze({
  id: 'protectionLatchId',
  reason: 'protectionLatchReason',
  protectionPrice: 'protectionLatchPrice',
  triggerPrice: 'protectionLatchTriggerPrice',
  quoteSequence: 'protectionLatchQuoteSequence',
  quoteReceivedAtMs: 'protectionLatchQuoteReceivedAtMs',
  clientOrderId: 'protectionLatchClientOrderId',
  attempts: 'protectionLatchAttempts',
  latchedAt: 'protectionLatchedAt',
});

class ProtectionTriggerEngine {
  constructor({
    eventBus,
    marketOrderService,
    logger,
    positionModel = Position,
    retryCheckMs = 1000,
  }) {
    this.eventBus = eventBus;
    this.marketOrderService = marketOrderService;
    this.logger = logger;
    this.positionModel = positionModel;
    this.retryCheckMs = Math.max(100, Number(retryCheckMs) || 1000);

    this.positions = new Map();
    this.positionsBySymbol = new Map();
    this.inFlight = new Map();
    this.latched = new Map();
    this.retryTimer = null;
    this.started = false;

    this.onTick = tick => this.#onTick(tick);
    this.onDependencyQuote = quote => {
      if (!quote?.isStale) this.#retryLatchedAll('dependency-quote');
    };
    this.onPositionOpened = position => this.#upsert(position);
    this.onPositionUpdated = position => this.#upsert(position);
    this.onPositionClosed = position => this.#remove(position);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.#attach();
    try {
      // Recover all open protected positions. Durable latches are stored on
      // the position itself so an FX-blocked stop survives process restart.
      const positions = await this.positionModel.find({ status: 'OPEN' }).lean();
      for (const position of positions) {
        this.#store(position);
        const latch = readProtectionLatch(position);
        if (latch) this.latched.set(String(position._id), latch);
      }
      this.#startRetryTimer();
      this.#retryLatchedAll('startup');
      this.logger?.info({
        protectedPositions: this.positions.size,
        latchedProtectionActions: this.latched.size,
      }, 'SL/TP protection engine recovered');
    } catch (error) {
      this.#detach();
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.started = false;
      throw error;
    }
  }

  async stop() {
    if (!this.started) return;
    this.#detach();
    clearInterval(this.retryTimer);
    this.retryTimer = null;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.latched.clear();
    this.positions.clear();
    this.positionsBySymbol.clear();
    this.started = false;
  }

  replaceAccountState(accountId, snapshot) {
    for (const item of [...this.positions.values()]) {
      if (String(item.accountId) === String(accountId)) this.#remove(item);
    }
    for (const item of snapshot.positions) this.#upsert(item);
  }

  health() {
    return {
      started: this.started,
      protectedPositions: this.positions.size,
      inFlight: this.inFlight.size,
      latchedProtectionActions: this.latched.size,
    };
  }

  #attach() {
    this.eventBus.on('market.tick', this.onTick);
    this.eventBus.on('market.quote', this.onDependencyQuote);
    this.eventBus.on('trading.position.opened', this.onPositionOpened);
    this.eventBus.on('trading.position.updated', this.onPositionUpdated);
    this.eventBus.on('trading.position.closed', this.onPositionClosed);
  }

  #detach() {
    this.eventBus.off('market.tick', this.onTick);
    this.eventBus.off('market.quote', this.onDependencyQuote);
    this.eventBus.off('trading.position.opened', this.onPositionOpened);
    this.eventBus.off('trading.position.updated', this.onPositionUpdated);
    this.eventBus.off('trading.position.closed', this.onPositionClosed);
  }

  #startRetryTimer() {
    clearInterval(this.retryTimer);
    this.retryTimer = setInterval(() => this.#retryLatchedAll('timer'), this.retryCheckMs);
    this.retryTimer.unref?.();
  }

  #onTick(tick) {
    if (!tick?.symbol || tick.isStale) return;
    const symbol = String(tick.symbol).toUpperCase();
    const ids = [...(this.positionsBySymbol.get(symbol) || [])];
    for (const id of ids) {
      if (this.inFlight.has(id) || this.latched.has(id)) continue;
      const position = this.positions.get(id);
      if (!position) continue;
      const detected = detectProtectionTrigger({ position, tick });
      if (!detected) continue;
      this.#launch(id, () => this.#latchAndExecute(position, detected, tick));
    }

    // FX dependencies normally have another symbol, so protection recovery
    // must not be indexed only by the underlying instrument.
    this.#retryLatchedAll('market-tick');
  }

  #retryLatchedAll(_reason) {
    if (!this.started) return;
    for (const [id, latch] of this.latched) {
      if (this.inFlight.has(id)) continue;
      const position = this.positions.get(id);
      if (!position) continue;
      this.#launch(id, () => this.#attemptLatched(position, latch, { retry: true }));
    }
  }

  #launch(id, work) {
    const promise = Promise.resolve()
      .then(work)
      .catch(error => {
        this.logger?.error({ err: error, positionId: id }, 'Protective close execution failed');
      })
      .finally(() => {
        if (this.inFlight.get(id) === promise) this.inFlight.delete(id);
      });
    this.inFlight.set(id, promise);
    return promise;
  }

  async #latchAndExecute(position, detected, tick) {
    const latch = {
      latchId: buildProtectionClientOrderId(position.id, detected.reason, tick),
      reason: detected.reason,
      protectionPrice: detected.reason === 'STOP_LOSS' ? position.stopLoss : position.takeProfit,
      triggerPrice: detected.triggerPrice,
      quoteSequence: detected.quoteSequence,
      quoteReceivedAtMs: detected.quoteReceivedAtMs,
      clientOrderId: buildProtectionClientOrderId(position.id, detected.reason, tick),
      attempts: 0,
      latchedAt: new Date().toISOString(),
    };

    // Persist before the close attempt where the production model supports it.
    // Test doubles without updateOne retain the existing immediate behavior.
    await this.#persistLatch(position.id, latch).catch(error => {
      this.logger?.error({ err: error, positionId: position.id }, 'Failed to persist protection latch before execution');
    });
    this.latched.set(position.id, latch);
    return this.#attemptLatched(position, latch, { retry: false });
  }

  async #attemptLatched(position, latch, { retry }) {
    const payload = {
      accountId: position.accountId,
      positionId: position.id,
      symbol: position.symbol,
      reason: latch.reason,
      triggerPrice: latch.triggerPrice,
      executablePrice: null,
      quoteSequence: latch.quoteSequence,
      quoteReceivedAtMs: latch.quoteReceivedAtMs,
      latchId: latch.latchId,
      timestamp: Date.now(),
    };
    this.eventBus.emit(retry ? 'protection.retrying' : 'protection.triggered', payload);

    const clientOrderId = retry
      ? buildProtectionRetryClientOrderId(position.id, latch.reason, latch.latchId)
      : latch.clientOrderId;

    try {
      const result = await this.marketOrderService.closeMarketPosition({
        accountId: position.accountId,
        positionId: position.id,
        clientOrderId,
        requestedPrice: latch.triggerPrice,
        source: 'SYSTEM',
        reason: latch.reason,
        latchedProtection: {
          latchId: latch.latchId,
          reason: latch.reason,
          protectionPrice: latch.protectionPrice,
        },
      });

      this.latched.delete(position.id);
      await this.#clearPersistedLatch(position.id).catch(() => {});
      this.eventBus.emit('protection.executed', {
        ...payload,
        orderId: result?.order?.orderId || null,
        dealId: result?.deal?.dealId || null,
        fillPrice: result?.deal?.price || null,
        idempotentReplay: Boolean(result?.idempotentReplay),
      });
      return result;
    } catch (error) {
      if (TERMINAL_PROTECTION_CODES.has(error?.code)) {
        this.latched.delete(position.id);
        await this.#clearPersistedLatch(position.id).catch(() => {});
        this.eventBus.emit('protection.skipped', { ...payload, code: error.code });
        return null;
      }

      latch.attempts = Number(latch.attempts || 0) + 1;
      this.latched.set(position.id, latch);
      await this.#persistLatch(position.id, latch).catch(persistError => {
        this.logger?.error({ err: persistError, positionId: position.id }, 'Failed to persist protection retry state');
      });
      this.eventBus.emit('protection.failed', {
        ...payload,
        code: error?.code || 'PROTECTIVE_CLOSE_FAILED',
        message: error?.message || 'Protective close failed',
        recoverable: RECOVERABLE_PROTECTION_CODES.has(error?.code),
      });

      if (RECOVERABLE_PROTECTION_CODES.has(error?.code)) return null;
      throw error;
    }
  }

  async #persistLatch(positionId, latch) {
    if (typeof this.positionModel?.updateOne !== 'function') return;
    await this.positionModel.updateOne(
      { _id: positionId, status: 'OPEN' },
      {
        $set: {
          [`metadata.${LATCH_KEYS.id}`]: String(latch.latchId),
          [`metadata.${LATCH_KEYS.reason}`]: String(latch.reason),
          [`metadata.${LATCH_KEYS.protectionPrice}`]: String(latch.protectionPrice),
          [`metadata.${LATCH_KEYS.triggerPrice}`]: String(latch.triggerPrice),
          [`metadata.${LATCH_KEYS.quoteSequence}`]: latch.quoteSequence == null ? '' : String(latch.quoteSequence),
          [`metadata.${LATCH_KEYS.quoteReceivedAtMs}`]: latch.quoteReceivedAtMs == null ? '' : String(latch.quoteReceivedAtMs),
          [`metadata.${LATCH_KEYS.clientOrderId}`]: String(latch.clientOrderId),
          [`metadata.${LATCH_KEYS.attempts}`]: String(Number(latch.attempts || 0)),
          [`metadata.${LATCH_KEYS.latchedAt}`]: String(latch.latchedAt || new Date().toISOString()),
        },
      },
    );
  }

  async #clearPersistedLatch(positionId) {
    if (typeof this.positionModel?.updateOne !== 'function') return;
    const unset = {};
    for (const key of Object.values(LATCH_KEYS)) unset[`metadata.${key}`] = '';
    await this.positionModel.updateOne({ _id: positionId }, { $unset: unset });
  }

  #upsert(position) {
    const normalized = normalizeProtectionPosition(position);
    if (!normalized.id || normalized.status !== 'OPEN' || (!normalized.stopLoss && !normalized.takeProfit)) {
      this.#remove(position);
      return;
    }
    this.#store(normalized);
    const durableLatch = readProtectionLatch(position);
    if (durableLatch) this.latched.set(normalized.id, durableLatch);
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
    this.latched.delete(id);
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

function readProtectionLatch(position) {
  const metadata = metadataObject(position?.metadata);
  const latchId = stringValue(metadata[LATCH_KEYS.id]);
  const reason = stringValue(metadata[LATCH_KEYS.reason]).toUpperCase();
  const protectionPrice = stringValue(metadata[LATCH_KEYS.protectionPrice]);
  const triggerPrice = stringValue(metadata[LATCH_KEYS.triggerPrice]);
  const clientOrderId = stringValue(metadata[LATCH_KEYS.clientOrderId]);
  if (!latchId || !['STOP_LOSS', 'TAKE_PROFIT'].includes(reason) || !protectionPrice || !triggerPrice) return null;
  return {
    latchId,
    reason,
    protectionPrice,
    triggerPrice,
    quoteSequence: nullableNumber(metadata[LATCH_KEYS.quoteSequence]),
    quoteReceivedAtMs: nullableNumber(metadata[LATCH_KEYS.quoteReceivedAtMs]),
    clientOrderId: clientOrderId || latchId,
    attempts: Number(metadata[LATCH_KEYS.attempts] || 0),
    latchedAt: stringValue(metadata[LATCH_KEYS.latchedAt]) || null,
  };
}

function metadataObject(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === 'object' ? value : {};
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function nullableNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function buildProtectionRetryClientOrderId(positionId, reason, latchId) {
  const shortReason = reason === 'STOP_LOSS' ? 'sl' : 'tp';
  const nonce = Date.now();
  const compactLatch = String(latchId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24);
  return `protect:${shortReason}:${positionId}:retry:${compactLatch}:${nonce}`.slice(0, 128);
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
  buildProtectionRetryClientOrderId,
  readProtectionLatch,
};
