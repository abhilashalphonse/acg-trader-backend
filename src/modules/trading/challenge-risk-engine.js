'use strict';

const { addDecimal, subtractDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Position } = require('./position.model');
const { ChallengeRiskDecision } = require('./challenge-risk-decision.model');
const { serializeAccount } = require('./trading.serializer');

class ChallengeRiskEngine {
  constructor({ eventBus, valuationEngine, accountControlService, commandQueue, logger, accountModel = TradingAccount, positionModel = Position, decisionModel = ChallengeRiskDecision, now = () => new Date() }) {
    Object.assign(this, { eventBus, valuationEngine, accountControlService, commandQueue, logger, accountModel, positionModel, decisionModel, now });
    this.started = false;
    this.inFlight = new Set();
    this.onValuation = valuation => this.#schedule(valuation?.accountId, valuation);
    this.onAccount = account => this.#schedule(account?.id || account?._id || account?.accountId, null);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
    this.eventBus?.on('trading.account.updated', this.onAccount);
    const accounts = await this.accountModel.find({ accountType: { $in: ['CHALLENGE', 'FUNDED'] }, status: { $in: ['ACTIVE', 'PAUSED'] } }).select('_id').lean();
    for (const account of accounts) this.#schedule(String(account._id), null);
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.eventBus?.off('trading.account.updated', this.onAccount);
    this.started = false;
  }

  health() { return { started: this.started, evaluatingAccounts: this.inFlight.size }; }

  #schedule(accountId, valuation) {
    const id = String(accountId || '').trim();
    if (!id || this.inFlight.has(id)) return;
    this.inFlight.add(id);
    queueMicrotask(() => this.evaluateAccount(id, valuation)
      .catch(error => this.logger?.error({ err: error, accountId: id }, 'Challenge risk evaluation failed'))
      .finally(() => this.inFlight.delete(id)));
  }

  async evaluateAccount(accountId, valuationHint = null) {
    let account = await this.accountModel.findById(accountId);
    if (!account || !['CHALLENGE', 'FUNDED'].includes(account.accountType)) return null;
    if (['BREACHED', 'DISABLED', 'CLOSED'].includes(account.status)) return null;

    let valuation = valuationHint || await this.valuationEngine.getOrLoadAccountSnapshot(accountId);
    if (!valuation || valuation.complete !== true || !['LIVE', 'STALE'].includes(valuation.valuationStatus)) return null;
    if (valuation.valuationStatus !== 'LIVE') return null;

    const todayKey = riskDayKey(this.now(), account.riskTimezone || 'UTC');
    if (account.riskDayKey !== todayKey) {
      account = await this.#dailyReset(account, valuation, todayKey);
      valuation = await this.valuationEngine.getOrLoadAccountSnapshot(accountId) || valuation;
    }

    const metadata = metadataObject(account.metadata);
    const challengeStatus = String(metadata.challengeStatus || '').toUpperCase();
    if (['PASSED', 'BREACHED', 'FAILED', 'CLOSED'].includes(challengeStatus)) return null;

    const evidenceBase = {
      valuationStatus: valuation.valuationStatus,
      complete: valuation.complete,
      staleSymbols: valuation.staleSymbols || [],
      positionCount: valuation.positionCount ?? null,
      riskTimezone: account.riskTimezone || 'UTC',
    };

    const equity = String(valuation.equity);
    const balance = String(valuation.balance);
    const initialBalance = String(account.state.initialBalance);
    const dailyStartEquity = String(account.state.dailyStartEquity);
    const policy = account.riskPolicy || {};

    const dailyLimit = decimalString(policy.dailyLoss?.limit, '0');
    if (compareDecimal(dailyLimit, '0') > 0) {
      const floor = subtractDecimal(referenceValue(policy.dailyLoss?.reference, { initialBalance, dailyStartEquity, balance }), dailyLimit);
      if (compareDecimal(equity, floor) <= 0) return this.#breach(account, valuation, 'DAILY_LOSS', dailyLimit, floor, equity, { ...evidenceBase, reference: policy.dailyLoss?.reference || 'DAILY_START_EQUITY' });
    }

    const maxLimit = decimalString(policy.maxLoss?.limit, '0');
    if (compareDecimal(maxLimit, '0') > 0) {
      const reference = referenceValue(policy.maxLoss?.reference, { initialBalance, dailyStartEquity, balance });
      const floor = subtractDecimal(reference, maxLimit);
      if (compareDecimal(equity, floor) <= 0) return this.#breach(account, valuation, 'MAX_LOSS', maxLimit, floor, equity, { ...evidenceBase, reference: policy.maxLoss?.reference || 'INITIAL_BALANCE' });
    }

    if (policy.maxOpenPositions != null && Number(valuation.positionCount || 0) > Number(policy.maxOpenPositions)) {
      return this.#breach(account, valuation, 'MAX_OPEN_POSITIONS', String(policy.maxOpenPositions), String(policy.maxOpenPositions), String(valuation.positionCount || 0), evidenceBase);
    }

    if (policy.maxTotalVolume != null) {
      const maxVolume = decimalString(policy.maxTotalVolume, '0');
      if (compareDecimal(maxVolume, '0') > 0) {
        const openPositions = await this.positionModel.find({ accountId: account._id, status: 'OPEN' }).select('openVolume').lean();
        const totalVolume = openPositions.reduce((sum, position) => addDecimal(sum, decimalString(position.openVolume, '0')), '0');
        if (compareDecimal(totalVolume, maxVolume) > 0) return this.#breach(account, valuation, 'MAX_TOTAL_VOLUME', maxVolume, maxVolume, totalVolume, evidenceBase);
      }
    }

    if (account.accountType === 'CHALLENGE') {
      const target = decimalString(policy.profitTarget, '0');
      if (compareDecimal(target, '0') > 0) {
        const targetBalance = addDecimal(initialBalance, target);
        if (compareDecimal(balance, targetBalance) >= 0 && compareDecimal(equity, targetBalance) >= 0) {
          return this.#pass(account, valuation, target, targetBalance, balance, evidenceBase);
        }
      }
    }
    return null;
  }

  async #dailyReset(account, valuation, dayKey) {
    const updated = await this.commandQueue.run(String(account._id), async () => {
      const current = await this.accountModel.findById(account._id);
      if (!current || current.riskDayKey === dayKey) return current;
      current.riskDayKey = dayKey;
      current.state.dailyStartEquity = String(valuation.equity);
      current.state.realizedPnlToday = '0';
      await current.save();
      await this.#record(current, valuation, 'DAILY_RESET', 'DAILY_BASELINE', null, String(valuation.equity), String(valuation.equity), { previousRiskDayKey: account.riskDayKey });
      return current;
    });
    if (updated) this.eventBus?.emit('trading.account.updated', serializeAccount(updated));
    return updated || account;
  }

  async #breach(account, valuation, rule, threshold, referenceValueObserved, observedValue, evidence) {
    const decision = await this.#recordOnce(account, valuation, 'BREACH', rule, threshold, referenceValueObserved, observedValue, evidence);
    if (!decision) return null;
    await this.#setChallengeMetadata(account._id, { challengeStatus: 'BREACHED', challengeDecisionId: decision.decisionId, challengeDecisionRule: rule });
    let controlError = null;
    try {
      await this.accountControlService.breach(String(account._id), { reason: `CHALLENGE_${rule}`, action: account.riskPolicy?.breachAction || null });
    } catch (error) {
      controlError = error;
      this.logger?.error({ err: error, accountId: String(account._id), decisionId: decision.decisionId }, 'Risk breach control action failed after durable decision');
    }
    const payload = decisionPayload(account, valuation, decision, { status: 'BREACHED', controlErrorCode: controlError?.code || null });
    this.eventBus?.emit('challenge.breached', payload);
    if (controlError) throw controlError;
    return payload;
  }

  async #pass(account, valuation, threshold, referenceValueObserved, observedValue, evidence) {
    const decision = await this.#recordOnce(account, valuation, 'PASS', 'PROFIT_TARGET', threshold, referenceValueObserved, observedValue, evidence);
    if (!decision) return null;
    await this.accountControlService.pause(String(account._id), { reason: 'CHALLENGE_PASSED', cancelPending: true });
    const updated = await this.#setChallengeMetadata(account._id, { challengeStatus: 'PASSED', challengeDecisionId: decision.decisionId, challengeDecisionRule: 'PROFIT_TARGET' });
    const payload = decisionPayload(updated || account, valuation, decision, { status: 'PASSED' });
    this.eventBus?.emit('challenge.passed', payload);
    return payload;
  }

  async #setChallengeMetadata(accountId, patch) {
    const account = await this.commandQueue.run(String(accountId), async () => {
      const current = await this.accountModel.findById(accountId);
      if (!current) return null;
      const metadata = current.metadata || new Map();
      for (const [key, value] of Object.entries(patch)) metadata.set(key, String(value));
      current.metadata = metadata;
      await current.save();
      return current;
    });
    if (account) this.eventBus?.emit('trading.account.updated', serializeAccount(account));
    return account;
  }

  async #recordOnce(account, valuation, type, rule, threshold, referenceValueObserved, observedValue, evidence) {
    const existing = await this.decisionModel.findOne({ accountId: account._id, type: { $in: type === 'BREACH' ? ['BREACH'] : ['PASS'] } }).lean();
    if (existing) return null;
    try { return await this.#record(account, valuation, type, rule, threshold, referenceValueObserved, observedValue, evidence); }
    catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  }

  async #record(account, valuation, type, rule, threshold, referenceValueObserved, observedValue, evidence) {
    return this.decisionModel.create({
      tenantId: account.tenantId,
      accountId: account._id,
      challengeId: metadataObject(account.metadata).challengeId || null,
      type,
      rule,
      riskDayKey: account.riskDayKey,
      valuationSequence: valuation?.sequence ?? null,
      valuedAtMs: valuation?.valuedAtMs ?? null,
      balance: valuation?.balance == null ? null : String(valuation.balance),
      equity: valuation?.equity == null ? null : String(valuation.equity),
      threshold,
      referenceValue: referenceValueObserved,
      observedValue,
      evidence,
      createdAt: this.now(),
    });
  }
}

function riskDayKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function decimalString(value, fallback = null) { if (value == null) return fallback; return value?.toString ? value.toString() : String(value); }
function referenceValue(reference, values) { const key = String(reference || '').toUpperCase(); if (key === 'INITIAL_BALANCE') return values.initialBalance; if (key === 'BALANCE') return values.balance; return values.dailyStartEquity; }
function metadataObject(metadata) { if (!metadata) return {}; return metadata instanceof Map ? Object.fromEntries(metadata) : { ...metadata }; }
function decisionPayload(account, valuation, decision, extra = {}) { return { accountId: String(account._id || account.id), accountCode: account.accountCode || null, challengeId: metadataObject(account.metadata).challengeId || null, decisionId: decision.decisionId, type: decision.type, rule: decision.rule, riskDayKey: decision.riskDayKey, balance: String(valuation.balance), equity: String(valuation.equity), threshold: decision.threshold, referenceValue: decision.referenceValue, observedValue: decision.observedValue, decidedAt: decision.createdAt?.toISOString?.() || new Date(decision.createdAt).toISOString(), ...extra }; }

module.exports = { ChallengeRiskEngine, riskDayKey, referenceValue };
