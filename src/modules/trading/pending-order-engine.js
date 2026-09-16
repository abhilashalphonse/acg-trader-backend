'use strict';

const { Order } = require('./order.model');
const { detectPendingOrderAction } = require('./pending-order-planner');

class PendingOrderEngine {
  constructor({
    eventBus,
    pendingOrderService,
    logger,
    orderModel = Order,
    expiryCheckMs = 1000,
  }) {
    this.eventBus = eventBus;
    this.pendingOrderService = pendingOrderService;
    this.logger = logger;
    this.orderModel = orderModel;
    this.expiryCheckMs = expiryCheckMs;

    this.orders = new Map();
    this.ordersBySymbol = new Map();
    this.inFlight = new Map();
    this.expiryTimer = null;
    this.started = false;

    this.onTick = tick => this.#onTick(tick);
    this.onPending = order => this.#upsert(order);
    this.onTriggered = order => this.#upsert(order);
    this.onTerminal = order => this.#remove(order);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.#attach();
    try {
      const orders = await this.orderModel.find({
        type: { $in: ['LIMIT', 'STOP', 'STOP_LIMIT'] },
        status: { $in: ['PENDING', 'TRIGGERED'] },
      }).lean();
      for (const order of orders) this.#store(order);
      this.#startExpiryTimer();
      this.logger?.info({ pendingOrders: this.orders.size }, 'Pending order engine recovered');
    } catch (error) {
      this.#detach();
      this.started = false;
      throw error;
    }
  }

  async stop() {
    if (!this.started) return;
    this.#detach();
    clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.orders.clear();
    this.ordersBySymbol.clear();
    this.started = false;
  }

  health() {
    let triggered = 0;
    for (const order of this.orders.values()) if (order.status === 'TRIGGERED') triggered += 1;
    return {
      started: this.started,
      pendingOrders: this.orders.size,
      triggeredStopLimits: triggered,
      inFlight: this.inFlight.size,
    };
  }

  #attach() {
    this.eventBus.on('market.tick', this.onTick);
    this.eventBus.on('trading.order.pending', this.onPending);
    this.eventBus.on('trading.order.triggered', this.onTriggered);
    this.eventBus.on('trading.order.cancelled', this.onTerminal);
    this.eventBus.on('trading.order.filled', this.onTerminal);
    this.eventBus.on('trading.order.expired', this.onTerminal);
    this.eventBus.on('trading.order.rejected', this.onTerminal);
  }

  #detach() {
    this.eventBus.off('market.tick', this.onTick);
    this.eventBus.off('trading.order.pending', this.onPending);
    this.eventBus.off('trading.order.triggered', this.onTriggered);
    this.eventBus.off('trading.order.cancelled', this.onTerminal);
    this.eventBus.off('trading.order.filled', this.onTerminal);
    this.eventBus.off('trading.order.expired', this.onTerminal);
    this.eventBus.off('trading.order.rejected', this.onTerminal);
  }

  #startExpiryTimer() {
    clearInterval(this.expiryTimer);
    this.expiryTimer = setInterval(() => this.#checkExpiries(), this.expiryCheckMs);
    this.expiryTimer.unref?.();
  }

  #onTick(tick) {
    if (!tick?.symbol || tick.isStale) return;
    const ids = [...(this.ordersBySymbol.get(String(tick.symbol).toUpperCase()) || [])];
    for (const id of ids) {
      if (this.inFlight.has(id)) continue;
      const order = this.orders.get(id);
      if (!order) continue;
      const detected = detectPendingOrderAction({ order, tick, nowMs: Date.now() });
      if (!detected) continue;
      this.#launch(id, () => this.#processAction(order, detected, tick));
    }
  }

  #checkExpiries() {
    const nowMs = Date.now();
    for (const [id, order] of this.orders) {
      if (this.inFlight.has(id) || !order.expiresAt) continue;
      const expiresAtMs = new Date(order.expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs) || nowMs < expiresAtMs) continue;
      this.#launch(id, () => this.pendingOrderService.expirePendingOrder({
        accountId: order.accountId,
        orderId: order.id,
        nowMs,
      }));
    }
  }

  #launch(id, work) {
    const promise = Promise.resolve()
      .then(work)
      .catch(error => {
        this.logger?.error({ err: error, orderId: id }, 'Pending order engine action failed');
      })
      .finally(() => {
        if (this.inFlight.get(id) === promise) this.inFlight.delete(id);
      });
    this.inFlight.set(id, promise);
  }

  async #processAction(order, detected, tick) {
    if (detected.action === 'EXPIRE') {
      return this.pendingOrderService.expirePendingOrder({
        accountId: order.accountId,
        orderId: order.id,
        nowMs: Date.now(),
      });
    }

    if (detected.action === 'ACTIVATE') {
      const activated = await this.pendingOrderService.activateStopLimit({
        accountId: order.accountId,
        orderId: order.id,
        tick,
      });
      if (activated?.skipped || !activated?.order) return activated;
      const sameTickAction = detectPendingOrderAction({ order: activated.order, tick, nowMs: Date.now() });
      if (sameTickAction?.action !== 'FILL') return activated;
    }

    return this.pendingOrderService.executePendingOrder({
      accountId: order.accountId,
      orderId: order.id,
      tick,
    });
  }

  #upsert(order) {
    const normalized = normalizePendingOrder(order);
    if (!normalized.id || !['PENDING', 'TRIGGERED'].includes(normalized.status)) {
      this.#remove(order);
      return;
    }
    this.#store(normalized);
  }

  #store(order) {
    const normalized = normalizePendingOrder(order);
    if (!normalized.id || !['PENDING', 'TRIGGERED'].includes(normalized.status)) return;
    const previous = this.orders.get(normalized.id);
    if (previous) removeIndex(this.ordersBySymbol, previous.symbol, normalized.id);
    this.orders.set(normalized.id, normalized);
    addIndex(this.ordersBySymbol, normalized.symbol, normalized.id);
  }

  #remove(order) {
    const id = String(order?.id || order?._id || '');
    if (!id) return;
    const existing = this.orders.get(id);
    if (existing) removeIndex(this.ordersBySymbol, existing.symbol, id);
    this.orders.delete(id);
  }
}

function normalizePendingOrder(order) {
  return {
    id: String(order?.id || order?._id || ''),
    orderId: String(order?.orderId || ''),
    accountId: String(order?.accountId || ''),
    symbol: String(order?.symbol || '').toUpperCase(),
    side: String(order?.side || '').toUpperCase(),
    type: String(order?.type || '').toUpperCase(),
    status: String(order?.status || '').toUpperCase(),
    limitPrice: decimalOrNull(order?.limitPrice),
    stopPrice: decimalOrNull(order?.stopPrice),
    expiresAt: order?.expiresAt || null,
  };
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return value.toString();
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

module.exports = { PendingOrderEngine, normalizePendingOrder };
