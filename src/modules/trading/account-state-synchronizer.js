'use strict';
const mongoose = require('mongoose');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Position } = require('./position.model');
const { Order } = require('./order.model');
const { serializeAccount } = require('./trading.serializer');

class AccountStateSynchronizer {
  constructor({ eventBus, valuationEngine, consumers = [], logger, accountModel = TradingAccount,
    positionModel = Position, orderModel = Order, concurrency = 4, sweepIntervalMs = 30000,
    readTransaction = work => mongoose.connection.transaction(work, { readConcern: { level: 'snapshot' }, readPreference: 'primary' }) }) {
    Object.assign(this, { eventBus, valuationEngine, consumers, logger, accountModel, positionModel, orderModel, concurrency, sweepIntervalMs, readTransaction });
    this.pending = new Set();
    this.inFlight = new Map();
    this.streams = [];
    this.documents = new Map();
    this.epochs = new Map();
    this.localListeners = [];
    this.started = false;
    this.lastSweepAt = null;
    this.lastError = null;
    this.sweepWork = null;
    this.failedAccounts = new Set();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    for (const name of ['trading.account.updated', 'trading.position.opened', 'trading.position.updated', 'trading.position.closed', 'trading.order.pending', 'trading.order.updated', 'trading.order.triggered', 'trading.order.filled', 'trading.order.cancelled']) {
      const listener = value => {
        const id = String(name === 'trading.account.updated' ? value.id || value._id : value.accountId);
        this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
      };
      this.localListeners.push([name, listener]);
      this.eventBus.on(name, listener);
    }
    for (const [kind, model] of [['account', this.accountModel], ['position', this.positionModel], ['order', this.orderModel]]) {
      const stream = model.watch([], { fullDocument: 'updateLookup' });
      stream.on('change', change => {
        if (kind === 'account' && change.operationType === 'update') {
          const keys = [...Object.keys(change.updateDescription?.updatedFields || {}), ...(change.updateDescription?.removedFields || [])];
          // Risk sequencing and snapshot delivery update accounts too; exclude them to avoid a feedback loop.
          if (!keys.some(key => /^(state\.|financialRevision$|status$|tradingEnabled$|riskPolicy|tradingPermissions|riskDayKey$|riskTimezone$|executionRestrictions)/.test(key))) return;
        }
        const id = kind === 'account' ? change.documentKey?._id : change.fullDocument?.accountId;
        if (id) this.schedule(id);
      });
      stream.on('error', error => { this.lastError = error.message; this.logger?.error?.({ err: error }, 'Account state change stream failed; reconciliation remains active'); });
      this.streams.push(stream);
    }
    await this.sweep();
    this.timer = setInterval(() => { void this.sweep().catch(error => {
      this.lastError = error.message;
      this.logger?.error?.({ err: error }, 'Account state reconciliation failed');
    }); }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    for (const [name, listener] of this.localListeners) this.eventBus.off(name, listener);
    this.localListeners = [];
    clearInterval(this.timer);
    await Promise.allSettled(this.streams.map(stream => stream.close()));
    this.streams = [];
    await this.sweepWork?.catch(() => {});
    await Promise.allSettled([...this.inFlight.values()]);
    this.pending.clear();
  }

  health() {
    return { started: this.started, pending: this.pending.size, inFlight: this.inFlight.size,
      lastSweepAt: this.lastSweepAt, lastError: this.lastError,
      failedAccounts: this.failedAccounts.size,
      ready: this.started && this.failedAccounts.size === 0 && this.lastSweepAt != null && Date.now() - this.lastSweepAt < this.sweepIntervalMs * 3 };
  }

  schedule(accountId) {
    if (!this.started) return;
    this.pending.add(String(accountId));
    this.epochs.set(String(accountId), (this.epochs.get(String(accountId)) || 0) + 1);
    this.#pump();
  }

  #pump() {
    if (!this.started) return;
    for (const id of this.pending) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(id)) continue;
      this.pending.delete(id);
      const work = this.reload(id).catch(error => {
        this.lastError = error.message;
        this.failedAccounts.add(id);
        this.logger?.error?.({ err: error, accountId: id }, 'Account state reload failed');
        // The periodic sweep retries failed accounts, without an immediate failure loop.
        this.documents.clear();
      }).finally(() => { this.inFlight.delete(id); this.#pump(); });
      this.inFlight.set(id, work);
    }
  }

  async drain() {
    while (this.inFlight.size || this.pending.size) {
      this.#pump();
      if (!this.inFlight.size) break;
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  async reload(accountId) {
    const epoch = this.epochs.get(String(accountId)) || 0;
    const snapshot = await this.readTransaction(async session => {
      const account = await this.accountModel.findById(accountId).session(session).lean();
      if (!account) return null;
      const positions = await this.positionModel.find({ accountId, status: 'OPEN' }).session(session).lean();
      const orders = await this.orderModel.find({ accountId, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }).session(session).lean();
      return { account, positions, orders };
    });
    if (!snapshot || !this.started) return false;
    if ((this.epochs.get(String(accountId)) || 0) !== epoch) { this.pending.add(String(accountId)); return false; }
    if (!this.valuationEngine.replaceAccountState(snapshot.account, snapshot.positions)) return false;
    // Apply the complete snapshot synchronously before publishing one account valuation.
    for (const consumer of this.consumers) consumer.replaceAccountState(accountId, snapshot);
    this.eventBus.emit('trading.account.updated', serializeAccount(snapshot.account));
    this.eventBus.emit('trading.account.reconciled', { accountId: String(accountId), tenantId: String(snapshot.account.tenantId) });
    this.failedAccounts.delete(String(accountId));
    return true;
  }

  sweep() {
    if (this.sweepWork) return this.sweepWork;
    this.sweepWork = this.#sweep().finally(() => { this.sweepWork = null; });
    return this.sweepWork;
  }

  async #sweep() {
    const positions = await this.positionModel.find({ status: 'OPEN' }).select('_id accountId __v').lean();
    const orders = await this.orderModel.find({ status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }).select('_id accountId __v').lean();
    const next = new Map();
    const accounts = new Set(this.valuationEngine.accountBases.keys());
    for (const id of this.failedAccounts) { accounts.add(id); this.schedule(id); }
    for (const [kind, rows] of [['p', positions], ['o', orders]]) for (const row of rows) {
      const key = `${kind}:${row._id}`;
      const entry = { accountId: String(row.accountId), version: Number(row.__v || 0) };
      next.set(key, entry);
      accounts.add(entry.accountId);
      if (this.documents.get(key)?.version !== entry.version) this.schedule(entry.accountId);
    }
    for (const [key, entry] of this.documents) if (!next.has(key)) this.schedule(entry.accountId);
    this.documents = next;
    const ids = [...accounts];
    for (let index = 0; index < ids.length; index += 500) {
      const rows = await this.accountModel.find({ _id: mongoose.trusted({ $in: ids.slice(index, index + 500) }) }).select('_id financialRevision').lean();
      for (const row of rows) {
        const base = this.valuationEngine.accountBases.get(String(row._id));
        if (!base || Number(base.financialRevision || 0) !== Number(row.financialRevision || 0)) this.schedule(row._id);
      }
    }
    await this.drain();
    this.lastSweepAt = Date.now();
  }
}
module.exports = { AccountStateSynchronizer };
