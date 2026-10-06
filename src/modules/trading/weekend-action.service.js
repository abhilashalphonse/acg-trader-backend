'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { scheduleHash } = require('../instruments/schedule-identity');
const { Position } = require('./position.model');
const { Order } = require('./order.model');
const { WeekendDeadline, WeekendAccountAction } = require('./weekend-action.model');
const { runMongoTransaction } = require('./market-order.service');
const ACTIVE_STATES = ['PLANNED', 'LOCKED', 'CANCELLING', 'CLOSING', 'VERIFYING', 'RETRYING'];

class WeekendActionService {
  constructor({ policyService, marketOrderService, pendingOrderService, logger, now = Date.now,
    actionModel = WeekendAccountAction, deadlineModel = WeekendDeadline, accountModel = TradingAccount,
    instrumentModel = Instrument, positionModel = Position, orderModel = Order, runTransaction = runMongoTransaction,
    concurrency = 4, leaseMs = 30000, jobsPerWorker = 32 }) {
    Object.assign(this, { policyService, marketOrderService, pendingOrderService, logger, now, actionModel, deadlineModel,
      accountModel, instrumentModel, positionModel, orderModel, runTransaction, concurrency, leaseMs, jobsPerWorker });
    this.owner = crypto.randomUUID();
    this.work = null;
    this.timer = null;
    this.stopping = false;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.runDue().catch(error => this.logger?.error?.({ err: error }, 'Weekend action worker failed')); }, 1000);
    this.timer.unref?.();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; await this.work; }

  async listActions(accountId, { limit = 100 } = {}) {
    return this.actionModel.find({ accountId }).sort({ processingStartAt: -1, _id: -1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
      .select('-leaseOwner').lean();
  }

  async summary(tenantId) {
    const now = new Date(this.now());
    const [summary] = await this.actionModel.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(String(tenantId)), mode: 'ENFORCED', marketCloseAt: { $gte: new Date(this.now() - 7 * 86400000) } } },
      { $facet: {
        states: [{ $group: { _id: '$state', count: { $sum: 1 } } }],
        overdueFlat: [{ $match: { state: { $in: ACTIVE_STATES }, marketCloseAt: { $lte: now } } }, { $count: 'count' }],
        lateConfirmed: [{ $match: { state: 'CONFIRMED', late: true } }, { $count: 'count' }],
      } },
    ]);
    const states = Object.fromEntries((summary?.states || []).map(item => [item._id, item.count]));
    const overdueFlat = summary?.overdueFlat?.[0]?.count || 0;
    const lateConfirmed = summary?.lateConfirmed?.[0]?.count || 0;
    return { states, overdueFlat, lateConfirmed, attentionRequired: overdueFlat > 0 || lateConfirmed > 0 || (states.MISSED || 0) > 0,
      generatedAt: now.toISOString(), lookbackDays: 7 };
  }

  async plan({ account, instrument, weekend, enforced }) {
    if (!weekend.marketCloseAt || !weekend.reopenAt) return;
    const hash = scheduleHash(instrument);
    const deadlineId = `${instrument.symbol}:${instrument.scheduleVersion || 1}:${hash}:${weekend.marketCloseAt}`;
    const dates = { marketCloseAt: new Date(weekend.marketCloseAt), processingStartAt: new Date(weekend.autoCloseAt),
      requiredFlatAt: new Date(weekend.requiredFlatAt), reopenAt: new Date(weekend.reopenAt) };
    await this.deadlineModel.updateOne({ _id: deadlineId }, { $setOnInsert: { symbol: instrument.symbol, scheduleVersion: instrument.scheduleVersion || 1, scheduleHash: hash, ...dates } }, { upsert: true });
    const id = crypto.createHash('sha256').update(`${deadlineId}:${account._id}:${account.tradingPermissionsVersion || 0}`).digest('hex');
    await this.actionModel.updateOne({ _id: id }, {
      $setOnInsert: { deadlineId, tenantId: account.tenantId, accountId: account._id, symbol: instrument.symbol,
        permissionVersion: account.tradingPermissionsVersion || 0, scheduleVersion: instrument.scheduleVersion || 1,
        scheduleHash: hash,
        ...dates, nextAttemptAt: dates.processingStartAt, state: 'PLANNED', leaseUntil: new Date(0), generation: 0, attempt: 0 },
      $set: { mode: enforced ? 'ENFORCED' : 'SHADOW' },
    }, { upsert: true });
  }

  runDue() {
    if (this.work) return this.work;
    if (this.stopping) return Promise.resolve([]);
    this.work = Promise.allSettled(Array.from({ length: this.concurrency }, async () => {
      // Drain bounded batches without a one-second idle period after every account.
      // One worker still holds only one account job/lease at a time.
      for (let index = 0; index < this.jobsPerWorker && !this.stopping; index++) if (!await this.#next()) break;
    })).then(results => {
      for (const result of results) if (result.status === 'rejected') this.logger?.error?.({ err: result.reason }, 'Weekend claim failed');
      return results;
    }).finally(() => { this.work = null; });
    return this.work;
  }

  async #next() {
    if (!this.policyService.config.weekendEnforcementEnabled) return false;
    const now = new Date(this.now());
    const job = await this.actionModel.findOneAndUpdate({ mode: 'ENFORCED', state: mongoose.trusted({ $in: ACTIVE_STATES }),
      nextAttemptAt: mongoose.trusted({ $lte: now }), leaseUntil: mongoose.trusted({ $lte: now }),
    }, { $set: { leaseOwner: this.owner, leaseUntil: new Date(this.now() + this.leaseMs) }, $inc: { generation: 1, attempt: 1 } },
    { new: true, sort: { processingStartAt: 1, _id: 1 } }).lean();
    if (!job) return false;
    const claim = { _id: job._id, leaseOwner: this.owner, generation: job.generation };
    try {
      if (this.now() >= new Date(job.marketCloseAt).getTime()) throw actionError('WEEKEND_DEADLINE_MISSED');
      await this.runTransaction(async session => {
        const account = await this.accountModel.findById(job.accountId).session(session);
        await this.fenceExecution(claim, account, session);
        const restrictions = (account.executionRestrictions || []).filter(item => new Date(item.expiresAt).getTime() > this.now() && item.deadlineId !== job.deadlineId);
        account.executionRestrictions = [...restrictions, { deadlineId: job.deadlineId, symbol: job.symbol,
          startsAt: job.processingStartAt, expiresAt: job.reopenAt, permissionVersion: job.permissionVersion, scheduleVersion: job.scheduleVersion, scheduleHash: job.scheduleHash }];
        await account.save({ session });
        await this.actionModel.updateOne(claim, { $set: { state: 'LOCKED' } }, { session });
      });
      await this.#progress(claim, 'CANCELLING');
      const orders = await this.orderModel.find({ accountId: job.accountId, symbol: job.symbol, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }).select('_id').lean();
      for (const order of orders) {
        await this.#renew(claim);
        await this.pendingOrderService.cancelPendingOrder({ accountId: String(job.accountId), orderId: String(order._id),
          clientRequestId: `weekend-cancel:${job._id.slice(0, 32)}:${order._id}:${job.generation}` }, { weekendClaim: claim });
      }
      await this.#progress(claim, 'CLOSING');
      if (process.env.NODE_ENV !== 'production'
        && String(job.accountId) === '6ac454bffcacdce0f3b0f2cc'
        && Number(job.generation) === 1) {
        this.logger?.warn?.({
          actionId: job._id,
          accountId: String(job.accountId),
          generation: job.generation,
          leaseUntil: new Date(this.now() + this.leaseMs).toISOString(),
        }, 'STAGING_SIGKILL_CANARY_PAUSED_AFTER_CANCEL');
        await new Promise(resolve => setTimeout(resolve, 180000));
      }
      const positions = await this.positionModel.find({ accountId: job.accountId, symbol: job.symbol, status: 'OPEN' }).select('_id').lean();
      if (positions.length) {
        // Quote outages are retriable policy failures, not trading commands. Check
        // executable pricing before creating per-close idempotency reservations so
        // a provider outage cannot create one failed trading record on every retry.
        await this.#renew(claim);
        await this.marketOrderService.ensureExecutableQuote(job.symbol, { reason: 'weekend-policy-preflight' });
      }
      for (const position of positions) {
        await this.#renew(claim);
        await this.marketOrderService.closeMarketPosition({ accountId: String(job.accountId), positionId: String(position._id),
          clientOrderId: `weekend-close:${job._id.slice(0, 32)}:${position._id}:${job.generation}`, volume: null, source: 'SYSTEM', reason: 'WEEKEND_HOLDING_POLICY' }, { weekendClaim: claim });
      }
      await this.#progress(claim, 'VERIFYING');
      await this.runTransaction(async session => {
        const account = await this.accountModel.findById(job.accountId).session(session);
        await this.fenceExecution(claim, account, session);
        // The account write conflicts with concurrent exposure transactions before confirming flat.
        account.policyExecutionRevision = Number(account.policyExecutionRevision || 0) + 1;
        await account.save({ session });
        const positions = await this.positionModel.countDocuments({ accountId: job.accountId, symbol: job.symbol, status: 'OPEN' }).session(session);
        const orders = await this.orderModel.countDocuments({ accountId: job.accountId, symbol: job.symbol, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }).session(session);
        if (positions || orders) throw actionError('WEEKEND_NOT_FLAT');
        const confirmedAt = new Date(this.now());
        await this.actionModel.updateOne(claim, { $set: { state: 'CONFIRMED', confirmedAt,
          late: confirmationIsLate(confirmedAt, job.marketCloseAt), leaseUntil: new Date(0), lastError: null } }, { session });
      });
    } catch (error) {
      const state = error.code === 'WEEKEND_DEADLINE_MISSED' ? 'MISSED' : error.code === 'WEEKEND_POLICY_CHANGED' ? 'OBSOLETE' : 'RETRYING';
      await this.actionModel.updateOne(claim, { $set: { state, leaseUntil: new Date(0),
        nextAttemptAt: new Date(this.now() + 2000), lastError: error.code || error.message } });
      this.logger?.error?.({ err: error, actionId: job._id, state }, 'Weekend action incomplete');
    }
    return true;
  }

  async fenceExecution(claim, account, session) {
    const job = await this.actionModel.findOneAndUpdate({ ...claim, leaseUntil: mongoose.trusted({ $gt: new Date(this.now()) }) },
      { $inc: { operationRevision: 1 } }, { new: true, session }).lean();
    if (!job) throw actionError('WEEKEND_LEASE_LOST');
    if (this.now() >= new Date(job.marketCloseAt).getTime()) throw actionError('WEEKEND_DEADLINE_MISSED');
    if (!account || account.tradingPermissions?.weekendHolding !== false || Number(account.tradingPermissionsVersion || 0) !== job.permissionVersion) throw actionError('WEEKEND_POLICY_CHANGED');
    const instrument = await this.instrumentModel.findOne({ symbol: job.symbol }).session(session).lean();
    if (!instrument || Number(instrument.scheduleVersion || 1) !== job.scheduleVersion || scheduleHash(instrument) !== job.scheduleHash) throw actionError('WEEKEND_POLICY_CHANGED');
    const status = await this.policyService.policyStatus(account._id, job.symbol, { account, instrument, nowMs: this.now() });
    if (!status.enforcement.weekendEnabled) throw actionError('WEEKEND_ENFORCEMENT_DISABLED');
    return job;
  }

  async #renew(claim) {
    const result = await this.actionModel.updateOne({ ...claim, leaseUntil: mongoose.trusted({ $gt: new Date(this.now()) }) },
      { $set: { leaseUntil: new Date(this.now() + this.leaseMs) } });
    if (!result.matchedCount) throw actionError('WEEKEND_LEASE_LOST');
  }
  async #progress(claim, state) {
    await this.#renew(claim);
    await this.actionModel.updateOne(claim, { $set: { state } });
  }
}
function confirmationIsLate(confirmedAt, marketCloseAt) {
  return new Date(confirmedAt).getTime() > new Date(marketCloseAt).getTime();
}
function actionError(code) { return new AppError(code, { statusCode: 409, code }); }
module.exports = { WeekendActionService, confirmationIsLate };