'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const {
  ROUNDING,
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
  quantizeToStep,
} = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Position } = require('./position.model');
const { MarginStopOutJob } = require('./margin-stop-out-job.model');
const { runMongoTransaction } = require('./market-order.service');
const { planMarketClose } = require('./execution-planner');
const { calculatePositionValuation, convertPnl } = require('./valuation-calculator');
const { evaluateRiskContext } = require('./challenge-risk-engine');
const { dayKeyInTimezone } = require('./risk-day-engine');

const STOP_OUT_LEVEL_PERCENT = '50';
const MAX_VOLUME_STEPS = 100000;

class MarginStopOutEngine {
  constructor({
    eventBus,
    valuationEngine,
    quoteStore,
    currencyConverter = null,
    marketOrderService,
    accountControlService,
    accountModel = TradingAccount,
    positionModel = Position,
    instrumentModel = Instrument,
    jobModel = MarginStopOutJob,
    runTransaction = runMongoTransaction,
    logger = null,
    pollIntervalMs = 1000,
    leaseMs = 30000,
    batchSize = 10,
    maxCloseStepsPerClaim = 20,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      eventBus,
      valuationEngine,
      quoteStore,
      currencyConverter,
      marketOrderService,
      accountControlService,
      accountModel,
      positionModel,
      instrumentModel,
      jobModel,
      runTransaction,
      logger,
      pollIntervalMs,
      leaseMs,
      batchSize,
      maxCloseStepsPerClaim,
      now,
    });
    this.started = false;
    this.running = false;
    this.timer = null;
    this.onValuation = valuation => {
      void this.#handleValuation(valuation).catch(error => {
        this.logger?.error?.({ err: error, accountId: valuation?.accountId }, 'Margin stop-out trigger handling failed');
      });
    };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
    await this.flush();
    this.timer = setInterval(() => {
      void this.flush().catch(error => this.logger?.error?.({ err: error }, 'Margin stop-out flush failed'));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }

  health() {
    return {
      started: this.started,
      running: this.running,
      stopOutLevelPercent: STOP_OUT_LEVEL_PERCENT,
      strategy: 'SMART_PARTIAL_LARGEST_MARGIN_FIRST',
    };
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        const job = await this.#claimNext();
        if (!job) break;
        await this.#process(job);
      }
    } finally {
      this.running = false;
    }
  }

  async #handleValuation(valuation) {
    if (!shouldTriggerStopOut(valuation)) return { triggered: false };

    const activation = await this.#activate(valuation);
    if (activation?.challengeBreach) {
      await this.accountControlService?.breach?.(activation.accountId, {
        reason: activation.challengeBreach.reason,
        evidence: activation.challengeBreach.evidence,
      });
      return { triggered: false, challengeBreach: true };
    }
    if (activation?.triggered) void this.flush();
    return activation;
  }

  async #activate(valuation) {
    const accountId = String(valuation?.accountId || valuation?.id || '').trim();
    if (!accountId) return { triggered: false };

    try {
      return await this.runTransaction(async session => {
        const account = await this.accountModel.findById(accountId).session(session);
        if (!account) return { triggered: false };
        if (['BREACHED', 'CLOSED'].includes(String(account.status || '').toUpperCase())) {
          return { triggered: false };
        }

        const currentRevision = Number(account.financialRevision || 0);
        const valuationRevision = Number(valuation.financialRevision);
        if (!Number.isInteger(valuationRevision) || valuationRevision !== currentRevision) {
          return { triggered: false, stale: true };
        }

        const challenge = evaluateChallengePrecedence(account, valuation);
        if (challenge.breached) {
          return { triggered: false, accountId, challengeBreach: challenge };
        }

        const existing = await this.jobModel.findOne({ activeKey: accountId }).session(session);
        if (existing) return { triggered: true, accountId, job: existing, existing: true };

        const now = this.now();
        const jobId = crypto.randomUUID();
        const job = new this.jobModel({
          jobId,
          tenantId: account.tenantId,
          accountId: account._id,
          activeKey: accountId,
          triggerFinancialRevision: currentRevision,
          triggerValuationSequence: finiteNumber(valuation.sequence),
          triggerValuedAtMs: finiteNumber(valuation.valuedAtMs),
          triggerMarginLevel: normalizeDecimal(valuation.marginLevel),
          triggerEquity: normalizeDecimal(valuation.equity),
          triggerUsedMargin: normalizeDecimal(valuation.usedMargin),
          stopOutLevelPercent: STOP_OUT_LEVEL_PERCENT,
          state: 'PENDING',
          nextAttemptAt: now,
        });

        account.marginStopOutState = 'ACTIVE';
        account.marginStopOutEpisodeId = jobId;
        account.marginStopOutStartedAt = now;
        account.marginStopOutRecoveredAt = null;

        await job.save({ session });
        await account.save({ session });

        return { triggered: true, accountId, job, existing: false };
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await this.jobModel.findOne({ activeKey: accountId });
      return { triggered: Boolean(existing), accountId, job: existing, existing: true };
    }
  }

  async #claimNext() {
    const now = this.now();
    const filter = {
      $or: [
        {
          state: mongoose.trusted({ $in: ['PENDING', 'RETRY'] }),
          nextAttemptAt: mongoose.trusted({ $lte: now }),
        },
        {
          state: 'PROCESSING',
          leaseExpiresAt: mongoose.trusted({ $lte: now }),
        },
      ],
    };
    return this.jobModel.findOneAndUpdate(
      filter,
      {
        $set: {
          state: 'PROCESSING',
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          lastAttemptAt: now,
          lastError: null,
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1, _id: 1 }, new: true },
    );
  }

  async #process(job) {
    try {
      for (let count = 0; count < this.maxCloseStepsPerClaim; count += 1) {
        await this.#renewLease(job);

        const account = await this.accountModel.findById(job.accountId);
        if (!account) {
          await this.#complete(job, 'ACCOUNT_MISSING', { superseded: true });
          return;
        }

        if (String(account.status || '').toUpperCase() === 'BREACHED') {
          await this.#complete(job, 'SUPERSEDED_BY_CHALLENGE', { superseded: true });
          return;
        }
        if (String(account.status || '').toUpperCase() === 'CLOSED') {
          await this.#complete(job, 'ACCOUNT_CLOSED', { superseded: true });
          return;
        }

        const nowMs = this.now().getTime();
        const projection = this.valuationEngine?.overlayAccountDocument(account, { requireLive: true });
        if (!projection?.complete) {
          throw retryable('Account valuation is incomplete during margin stop-out', 'STOP_OUT_VALUATION_UNAVAILABLE');
        }

        const challenge = evaluateChallengePrecedence(account, {
          ...projection,
          financialRevision: Number(account.financialRevision || 0),
          valuedAtMs: nowMs,
        });
        if (challenge.breached) {
          await this.accountControlService.breach(String(account._id), {
            reason: challenge.reason,
            evidence: challenge.evidence,
          });
          await this.#complete(job, 'SUPERSEDED_BY_CHALLENGE', { superseded: true });
          return;
        }

        if (isRecovered(account.state)) {
          await this.#complete(job, compareDecimal(account.state.usedMargin, '0') <= 0 ? 'NO_REMAINING_MARGIN' : 'MARGIN_LEVEL_RECOVERED');
          return;
        }

        const positions = await this.positionModel.find({ accountId: account._id, status: 'OPEN' }).lean();
        if (!positions.length) {
          await this.#complete(job, 'NO_OPEN_POSITIONS');
          return;
        }

        const ranked = rankStopOutPositions({
          positions,
          account,
          quoteStore: this.quoteStore,
          currencyConverter: this.currencyConverter,
          nowMs,
        });
        const position = ranked[0];
        if (!position) throw retryable('No position has a live valuation for stop-out', 'STOP_OUT_POSITION_VALUATION_UNAVAILABLE');

        const instrument = await this.instrumentModel.findOne({ symbol: position.symbol }).lean();
        if (!instrument) throw retryable('Instrument is unavailable for stop-out liquidation', 'STOP_OUT_INSTRUMENT_UNAVAILABLE');

        const quote = this.quoteStore?.get?.(position.symbol);
        const selection = findMinimumStopOutClose({
          account,
          position,
          instrument,
          quote,
          currencyConverter: this.currencyConverter,
          nowMs,
          stopOutLevelPercent: STOP_OUT_LEVEL_PERCENT,
        });

        const step = Number(job.step || 1);
        const clientOrderId = stopOutClientOrderId(job.jobId, step);
        const result = await this.marketOrderService.closeMarketPosition({
          accountId: String(account._id),
          positionId: String(position._id),
          volume: selection.volume,
          clientOrderId,
          source: 'SYSTEM',
          reason: 'MARGIN_STOP_OUT',
        });

        const action = {
          step,
          clientOrderId,
          positionId: String(position._id),
          positionKey: String(position.positionId || position._id),
          requestedCloseVolume: selection.volume,
          projectedMarginLevel: selection.projection.marginLevel,
          projectedEquity: selection.projection.equity,
          projectedUsedMargin: selection.projection.usedMargin,
          fullClose: selection.plan.fullClose,
          actualFillPrice: result?.deal?.price || null,
          actualCommission: result?.deal?.commission || null,
          actualRealizedPnl: result?.deal?.realizedPnl || null,
          resultingMarginLevel: result?.account?.state?.marginLevel || result?.valuation?.marginLevel || null,
          idempotentReplay: result?.idempotentReplay === true,
          completedAt: this.now().toISOString(),
        };

        await this.jobModel.updateOne(
          { _id: job._id, state: 'PROCESSING', step },
          {
            $set: {
              lastAction: action,
              leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs),
            },
            $inc: { step: 1 },
          },
        );
        job.step = step + 1;
        job.lastAction = action;

        this.valuationEngine?.scheduleAccountRevalue?.(String(account._id));
        await immediate();
      }

      await this.#retry(job, retryable('Stop-out requires additional liquidation steps', 'STOP_OUT_MORE_WORK'), 0);
    } catch (error) {
      await this.#retry(job, error);
    }
  }

  async #renewLease(job) {
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseMs);
    await this.jobModel.updateOne(
      { _id: job._id, state: 'PROCESSING' },
      { $set: { leaseExpiresAt } },
    );
    job.leaseExpiresAt = leaseExpiresAt;
  }

  async #complete(job, reason, { superseded = false } = {}) {
    const now = this.now();
    await this.runTransaction(async session => {
      const account = await this.accountModel.findById(job.accountId).session(session);
      if (account && String(account.marginStopOutEpisodeId || '') === String(job.jobId)) {
        account.marginStopOutState = 'NONE';
        account.marginStopOutEpisodeId = null;
        account.marginStopOutRecoveredAt = now;
        await account.save({ session });
      }

      await this.jobModel.updateOne(
        { _id: job._id },
        {
          $set: {
            state: superseded ? 'SUPERSEDED' : 'COMPLETED',
            completionReason: reason,
            completedAt: now,
            leaseExpiresAt: null,
            lastError: null,
          },
          $unset: { activeKey: '' },
        },
        { session },
      );
    });
  }

  async #retry(job, error, explicitDelayMs = null) {
    const delay = explicitDelayMs == null ? retryDelayMs(Number(job.attempts || 1)) : explicitDelayMs;
    await this.jobModel.updateOne(
      { _id: job._id, state: 'PROCESSING' },
      {
        $set: {
          state: 'RETRY',
          nextAttemptAt: new Date(this.now().getTime() + delay),
          leaseExpiresAt: null,
          lastError: String(error?.message || error).slice(0, 2000),
        },
      },
    );
    this.logger?.warn?.({
      err: error,
      jobId: job.jobId,
      accountId: String(job.accountId),
    }, 'Margin stop-out will retry');
  }
}

function shouldTriggerStopOut(valuation, stopOutLevelPercent = STOP_OUT_LEVEL_PERCENT) {
  if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') return false;
  if (valuation.usedMargin == null || compareDecimal(valuation.usedMargin, '0') <= 0) return false;
  if (valuation.marginLevel == null) return false;
  return compareDecimal(valuation.marginLevel, stopOutLevelPercent) <= 0;
}

function isRecovered(state, stopOutLevelPercent = STOP_OUT_LEVEL_PERCENT) {
  const usedMargin = normalizeDecimal(state?.usedMargin ?? '0');
  if (compareDecimal(usedMargin, '0') <= 0) return true;
  if (state?.marginLevel == null) return false;
  return compareDecimal(state.marginLevel, stopOutLevelPercent) > 0;
}

function evaluateChallengePrecedence(account, valuation) {
  const valuedAtMs = finiteNumber(valuation?.valuedAtMs) ?? Date.now();
  const riskTimezone = String(account?.riskTimezone || 'UTC');
  const valuationRiskDay = dayKeyInTimezone(new Date(valuedAtMs), riskTimezone);
  const accountRiskDay = String(account?.riskDayKey || '');
  const dailyLimit = valuationRiskDay === accountRiskDay
    ? scalar(account?.riskPolicy?.dailyLoss?.limit, '0')
    : '0';

  return evaluateRiskContext({
    financialRevision: Number(account?.financialRevision || 0),
    policyVersion: metadataValue(account, 'riskPolicyVersion'),
    riskDayKey: accountRiskDay || valuationRiskDay,
    riskTimezone,
    initialBalance: scalar(account?.state?.initialBalance, '0'),
    dailyStartEquity: scalar(account?.state?.dailyStartEquity, account?.state?.initialBalance ?? '0'),
    dailyLossLimit: dailyLimit,
    maxLossLimit: scalar(account?.riskPolicy?.maxLoss?.limit, '0'),
    balance: scalar(valuation?.balance ?? account?.state?.balance, '0'),
    floatingPnl: scalar(valuation?.floatingPnl ?? account?.state?.floatingPnl, '0'),
    equity: scalar(valuation?.equity ?? account?.state?.equity, '0'),
    usedMargin: scalar(valuation?.usedMargin ?? account?.state?.usedMargin, '0'),
    freeMargin: scalar(valuation?.freeMargin ?? account?.state?.freeMargin, '0'),
    marginLevel: valuation?.marginLevel == null ? null : scalar(valuation.marginLevel, null),
    valuationSequence: finiteNumber(valuation?.sequence),
    valuedAtMs,
  });
}

function rankStopOutPositions({ positions, account, quoteStore, currencyConverter = null, nowMs = Date.now() }) {
  return positions.map(position => {
    const quote = quoteStore?.get?.(position.symbol);
    const valuation = calculatePositionValuation({ position, quote });
    if (valuation.valuationStatus !== 'LIVE' || valuation.floatingPnl == null) {
      throw retryable(`Position ${String(position.positionId || position._id)} does not have a live executable valuation`, 'STOP_OUT_POSITION_VALUATION_UNAVAILABLE');
    }
    const floatingPnl = convertPnl(
      valuation.floatingPnl,
      valuation.quoteCurrency,
      account.currency,
      currencyConverter,
      nowMs,
    );
    return { ...position, __stopOutFloatingPnl: floatingPnl };
  }).sort(compareStopOutPositions);
}

function compareStopOutPositions(left, right) {
  const marginOrder = compareDecimal(right.margin ?? '0', left.margin ?? '0');
  if (marginOrder !== 0) return marginOrder;

  const pnlOrder = compareDecimal(left.__stopOutFloatingPnl ?? '0', right.__stopOutFloatingPnl ?? '0');
  if (pnlOrder !== 0) return pnlOrder;

  const leftOpened = new Date(left.openedAt || 0).getTime();
  const rightOpened = new Date(right.openedAt || 0).getTime();
  if (leftOpened !== rightOpened) return leftOpened - rightOpened;

  return String(left.positionId || left._id).localeCompare(String(right.positionId || right._id));
}

function findMinimumStopOutClose({
  account,
  position,
  instrument,
  quote,
  currencyConverter = null,
  nowMs = Date.now(),
  stopOutLevelPercent = STOP_OUT_LEVEL_PERCENT,
}) {
  const openVolume = normalizeDecimal(position.openVolume);
  const step = normalizeDecimal(position.volumeStep || instrument.volumeStep);
  const minVolume = normalizeDecimal(instrument.minVolume || step);
  let candidate = quantizeToStep(
    compareDecimal(minVolume, step) >= 0 ? minVolume : step,
    step,
    ROUNDING.CEIL,
  );
  if (compareDecimal(candidate, openVolume) > 0) candidate = openVolume;

  let iterations = 0;
  while (iterations < MAX_VOLUME_STEPS) {
    iterations += 1;
    const remaining = subtractDecimal(openVolume, candidate);
    if (compareDecimal(remaining, '0') > 0 && compareDecimal(remaining, minVolume) < 0) {
      candidate = openVolume;
    }

    const planned = projectStopOutClose({
      account,
      position,
      instrument,
      quote,
      volume: candidate,
      currencyConverter,
      nowMs,
    });

    if (planned.plan.fullClose || isProjectedRecovered(planned.projection, stopOutLevelPercent)) {
      return {
        volume: planned.plan.volume,
        plan: planned.plan,
        projection: planned.projection,
        iterations,
      };
    }

    const next = addDecimal(candidate, step);
    candidate = compareDecimal(next, openVolume) >= 0 ? openVolume : next;
  }

  throw new AppError('Stop-out close-volume search exceeded the supported volume-step range', {
    statusCode: 500,
    code: 'STOP_OUT_VOLUME_SEARCH_EXHAUSTED',
  });
}

function projectStopOutClose({
  account,
  position,
  instrument,
  quote,
  volume,
  currencyConverter = null,
  nowMs = Date.now(),
}) {
  const plan = planMarketClose({
    account,
    instrument,
    quote,
    position,
    volume,
    nowMs,
    currencyConverter,
  });

  const mark = calculatePositionValuation({
    position: {
      ...position,
      openVolume: plan.volume,
    },
    quote,
  });
  if (mark.valuationStatus !== 'LIVE' || mark.floatingPnl == null) {
    throw retryable('Selected position cannot be marked for stop-out projection', 'STOP_OUT_POSITION_VALUATION_UNAVAILABLE');
  }
  const markedClosedPnl = convertPnl(
    mark.floatingPnl,
    mark.quoteCurrency,
    account.currency,
    currencyConverter,
    nowMs,
  );

  const balance = addDecimal(
    addDecimal(normalizeDecimal(account.state.balance), plan.realizedPnl),
    subtractDecimal('0', plan.commission),
  );
  const floatingPnl = subtractDecimal(normalizeDecimal(account.state.floatingPnl), markedClosedPnl);
  const equity = addDecimal(balance, floatingPnl);
  let usedMargin = subtractDecimal(normalizeDecimal(account.state.usedMargin), plan.releasedMargin);
  if (compareDecimal(usedMargin, '0') < 0) usedMargin = '0';
  const freeMargin = subtractDecimal(equity, usedMargin);
  const marginLevel = compareDecimal(usedMargin, '0') > 0
    ? multiplyDecimal(divideDecimal(equity, usedMargin, { scale: 8, rounding: ROUNDING.HALF_UP }), '100')
    : null;

  return {
    plan,
    markedClosedPnl,
    projection: {
      balance,
      floatingPnl,
      equity,
      usedMargin,
      freeMargin,
      marginLevel,
    },
  };
}

function isProjectedRecovered(projection, stopOutLevelPercent = STOP_OUT_LEVEL_PERCENT) {
  if (compareDecimal(projection.usedMargin, '0') <= 0) return true;
  if (projection.marginLevel == null) return false;
  return compareDecimal(projection.marginLevel, stopOutLevelPercent) > 0;
}

function stopOutClientOrderId(jobId, step) {
  const compact = String(jobId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return `margin-stop-out:${compact}:${Number(step)}`.slice(0, 128);
}

function retryDelayMs(attempt) {
  return Math.min(60000, 500 * (2 ** Math.max(0, Number(attempt || 1) - 1)));
}

function retryable(message, code) {
  const error = new AppError(message, { statusCode: 503, code });
  error.retryable = true;
  return error;
}

function metadataValue(account, key) {
  if (account?.metadata instanceof Map) return account.metadata.get(key) || null;
  return account?.metadata?.[key] || null;
}

function scalar(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback == null ? null : String(fallback);
  return value?.toString ? value.toString() : String(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve));
}

module.exports = {
  MarginStopOutEngine,
  STOP_OUT_LEVEL_PERCENT,
  shouldTriggerStopOut,
  isRecovered,
  evaluateChallengePrecedence,
  rankStopOutPositions,
  compareStopOutPositions,
  findMinimumStopOutClose,
  projectStopOutClose,
  isProjectedRecovered,
  stopOutClientOrderId,
  retryDelayMs,
};
