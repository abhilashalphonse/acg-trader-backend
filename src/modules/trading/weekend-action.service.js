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
    this.workerHealth = {
      startedAt: null,
      lastSweepAt: null,
      lastClaimedAt: null,
      lastConfirmedAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      claimed: 0,
      confirmed: 0,
      retried: 0,
      missed: 0,
      obsolete: 0,
    };
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.workerHealth.startedAt = new Date(this.now()).toISOString();
    this.timer = setInterval(() => { void this.runDue().catch(error => this.logger?.error?.({ err: error }, 'Weekend action worker failed')); }, 1000);
    this.timer.unref?.();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; await this.work; }

  async listActions(accountId, { limit = 100 } = {}) {
    return this.actionModel.find({ accountId }).sort({ processingStartAt: -1, _id: -1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
      .select('-leaseOwner').lean();
  }

  async summary(tenantId, { lookbackHours = 168, retryAttentionAttempt = 5 } = {}) {
    const now = new Date(this.now());
    const lookbackStart = new Date(this.now() - Math.max(1, Number(lookbackHours) || 168) * 3600000);
    const retryThreshold = Math.max(2, Number(retryAttentionAttempt) || 5);
    const [summary] = await this.actionModel.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(String(tenantId)), mode: 'ENFORCED', marketCloseAt: { $gte: lookbackStart } } },
      { $facet: {
        states: [{ $group: { _id: '$state', count: { $sum: 1 } } }],
        overdueFlat: [{ $match: { state: { $in: ACTIVE_STATES }, marketCloseAt: { $lte: now } } }, { $count: 'count' }],
        lateConfirmed: [{ $match: { state: 'CONFIRMED', late: true } }, { $count: 'count' }],
        highRetry: [{ $match: { state: 'RETRYING', attempt: { $gte: retryThreshold } } }, { $count: 'count' }],
        attemptStats: [{ $group: { _id: null, maxAttempt: { $max: '$attempt' }, avgAttempt: { $avg: '$attempt' } } }],
      } },
    ]);
    const states = Object.fromEntries((summary?.states || []).map(item => [item._id, item.count]));
    const overdueFlat = summary?.overdueFlat?.[0]?.count || 0;
    const lateConfirmed = summary?.lateConfirmed?.[0]?.count || 0;
    const highRetry = summary?.highRetry?.[0]?.count || 0;
    const maxAttempt = Number(summary?.attemptStats?.[0]?.maxAttempt || 0);
    const avgAttempt = Number(summary?.attemptStats?.[0]?.avgAttempt || 0);
    const missed = Number(states.MISSED || 0);
    const attentionRequired = overdueFlat > 0 || lateConfirmed > 0 || missed > 0 || highRetry > 0;
    return {
      status: attentionRequired ? 'ATTENTION' : 'OK',
      states,
      overdueFlat,
      lateConfirmed,
      missed,
      highRetry,
      retryAttentionAttempt: retryThreshold,
      maxAttempt,
      avgAttempt,
      attentionRequired,
      generatedAt: now.toISOString(),
      lookbackHours: Math.max(1, Number(lookbackHours) || 168),
    };
  }

  health() {
    return {
      running: Boolean(this.timer) && !this.stopping,
      inFlight: Boolean(this.work),
      leaseMs: this.leaseMs,
      jobsPerWorker: this.jobsPerWorker,
      concurrency: this.concurrency,
      ...this.workerHealth,
    };
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
    this.workerHealth.lastSweepAt = new Date(this.now()).toISOString();
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
    this.workerHealth.claimed += 1;
    this.workerHealth.lastClaimedAt = new Date(this.now()).toISOString();
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
        const late = confirmationIsLate(confirmedAt, job.marketCloseAt);
        await this.actionModel.updateOne(claim, { $set: { state: 'CONFIRMED', confirmedAt,
          late, leaseUntil: new Date(0), lastError: null } }, { session });
        this.workerHealth.confirmed += 1;
        this.workerHealth.lastConfirmedAt = confirmedAt.toISOString();
        if (late) this.logger?.error?.({ actionId: job._id, confirmedAt, marketCloseAt: job.marketCloseAt }, 'Weekend action confirmed after hard deadline');
      });
    } catch (error) {
      const state = error.code === 'WEEKEND_DEADLINE_MISSED' ? 'MISSED' : error.code === 'WEEKEND_POLICY_CHANGED' ? 'OBSOLETE' : 'RETRYING';
      await this.actionModel.updateOne(claim, { $set: { state, leaseUntil: new Date(0),
        nextAttemptAt: new Date(this.now() + 2000), lastError: error.code || error.message } });
      this.workerHealth.lastFailureAt = new Date(this.now()).toISOString();
      this.workerHealth.lastFailureCode = error.code || error.message;
      if (state === 'MISSED') this.workerHealth.missed += 1;
      else if (state === 'OBSOLETE') this.workerHealth.obsolete += 1;
      else this.workerHealth.retried += 1;
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