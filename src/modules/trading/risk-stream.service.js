'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { normalizeDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountRiskEvent } = require('./account-risk-event.model');
const { runMongoTransaction } = require('./market-order.service');
const { dayKeyInTimezone } = require('./risk-day-engine');

class RiskStreamService {
  constructor({
    accountModel = TradingAccount,
    eventModel = AccountRiskEvent,
    runTransaction = runMongoTransaction,
    now = () => new Date(),
  } = {}) {
    this.accountModel = accountModel;
    this.eventModel = eventModel;
    this.runTransaction = runTransaction;
    this.now = now;
  }

  async ingestValuation(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') {
      return { accepted: false, ignored: true };
    }
    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId) return { accepted: false, ignored: true };

    return this.runTransaction(async session => {
      const account = await this.accountModel.findById(accountId).session(session);
      if (!account) return { accepted: false, ignored: true };

      const currentRevision = Number(account.financialRevision || 0);
      const valuationRevision = Number(valuation.financialRevision);
      if (!Number.isInteger(valuationRevision) || valuationRevision !== currentRevision) {
        return {
          accepted: false,
          stale: true,
          code: 'STALE_VALUATION_REVISION',
          accountId,
          valuationRevision: Number.isFinite(valuationRevision) ? valuationRevision : null,
          currentRevision,
        };
      }

      const timezone = String(account.riskTimezone || 'UTC');
      const currentDay = dayKeyInTimezone(this.now(), timezone);
      const created = [];

      if (String(account.riskDayKey || '') !== currentDay) {
        const rollover = await this.#appendWithinTransaction({
          account,
          session,
          type: 'RISK_DAY_ROLLOVER',
          eventKey: `RISK_DAY_ROLLOVER:${currentDay}`,
          financialRevision: currentRevision,
          policyVersion: policyVersionOf(account),
          riskDayKey: currentDay,
          riskTimezone: timezone,
          valuedAtMs: finiteNumber(valuation.valuedAtMs),
          sourceSequence: finiteNumber(valuation.sequence),
          context: {
            previousRiskDayKey: account.riskDayKey || null,
            nextRiskDayKey: currentDay,
            previousDailyStartEquity: scalar(account.state?.dailyStartEquity),
            nextDailyStartEquity: normalizeDecimal(valuation.equity),
            sourceFinancialRevision: currentRevision,
          },
        });
        if (rollover.created) created.push(rollover.event);
        account.riskDayKey = currentDay;
        account.state.dailyStartEquity = normalizeDecimal(valuation.equity);
        account.state.realizedPnlToday = '0';
      }

      const key = valuationEventKey(valuation, currentRevision, currentDay);
      const appended = await this.#appendWithinTransaction({
        account,
        session,
        type: 'VALUATION',
        eventKey: key,
        financialRevision: currentRevision,
        policyVersion: policyVersionOf(account),
        riskDayKey: currentDay,
        riskTimezone: timezone,
        valuedAtMs: finiteNumber(valuation.valuedAtMs),
        sourceSequence: finiteNumber(valuation.sequence),
        context: valuationContext(account, valuation, currentRevision, currentDay, timezone),
      });

      if (appended.created) created.push(appended.event);
      await account.save({ session });

      return {
        accepted: true,
        duplicate: !appended.created,
        accountId,
        created,
        event: appended.event,
      };
    });
  }

  async appendPolicyTransition(accountId, { migrationId, previousPolicy, newPolicy, nextPolicyVersion, effectiveAt = this.now() }) {
    const id = String(accountId || '').trim();
    if (!id) throw new TypeError('accountId is required');
    return this.runTransaction(async session => {
      const account = await this.accountModel.findById(id).session(session);
      if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
      const eventKey = `POLICY_TRANSITION:${String(migrationId || '').trim()}`;
      const appended = await this.#appendWithinTransaction({
        account,
        session,
        type: 'POLICY_TRANSITION',
        eventKey,
        financialRevision: Number(account.financialRevision || 0),
        policyVersion: nextPolicyVersion || null,
        riskDayKey: String(account.riskDayKey || dayKeyInTimezone(effectiveAt, account.riskTimezone || 'UTC')),
        riskTimezone: String(account.riskTimezone || 'UTC'),
        valuedAtMs: effectiveAt.getTime(),
        sourceSequence: null,
        context: { migrationId, previousPolicy, newPolicy, nextPolicyVersion },
      });
      await account.save({ session });
      return appended;
    });
  }

  async getNext(accountId) {
    const account = await this.accountModel.findById(String(accountId)).lean();
    if (!account) return { account: null, event: null };
    const next = Number(account.lastEvaluatedRiskSequence || 0) + 1;
    const event = await this.eventModel.findOne({ accountId: String(accountId), sequence: next }).lean();
    if (!event && Number(account.riskSequence || 0) >= next) {
      await this.markUnresolved(accountId, {
        reason: 'RISK_SEQUENCE_GAP',
        expectedSequence: next,
        observedRiskSequence: Number(account.riskSequence || 0),
      });
      return { account, event: null, gap: true, expectedSequence: next };
    }
    return { account, event };
  }

  async complete(accountId, sequence, { state = 'EVALUATED', result = null } = {}) {
    return this.runTransaction(async session => {
      const account = await this.accountModel.findById(String(accountId)).session(session);
      if (!account) return null;
      const expected = Number(account.lastEvaluatedRiskSequence || 0) + 1;
      if (Number(sequence) !== expected) {
        account.riskProcessingState = 'RISK_UNRESOLVED';
        account.riskUnresolvedReason = 'OUT_OF_ORDER_RISK_COMPLETION';
        account.riskUnresolvedSince = account.riskUnresolvedSince || this.now();
        await account.save({ session });
        throw new AppError('Risk event completion is out of order', {
          statusCode: 409,
          code: 'RISK_SEQUENCE_OUT_OF_ORDER',
          details: { expectedSequence: expected, receivedSequence: Number(sequence) },
        });
      }
      const event = await this.eventModel.findOne({ accountId: String(accountId), sequence: Number(sequence) }).session(session);
      if (!event) {
        account.riskProcessingState = 'RISK_UNRESOLVED';
        account.riskUnresolvedReason = 'RISK_SEQUENCE_GAP';
        account.riskUnresolvedSince = account.riskUnresolvedSince || this.now();
        await account.save({ session });
        throw new AppError('Risk event is missing', { statusCode: 409, code: 'RISK_SEQUENCE_GAP' });
      }
      if (event.state === 'RECEIVED') {
        event.state = state;
        event.result = result;
        event.evaluatedAt = this.now();
        await event.save({ session });
      }
      account.lastEvaluatedRiskSequence = Number(sequence);
      if (Number(account.lastEvaluatedRiskSequence) === Number(account.riskSequence || 0)) {
        account.riskProcessingState = 'RESOLVED';
        account.riskUnresolvedReason = null;
        account.riskUnresolvedSince = null;
      }
      await account.save({ session });
      return event;
    });
  }

  async markUnresolved(accountId, details = {}) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) return null;
    account.riskProcessingState = 'RISK_UNRESOLVED';
    account.riskUnresolvedReason = String(details.reason || 'RISK_UNRESOLVED');
    account.riskUnresolvedSince = account.riskUnresolvedSince || this.now();
    if (!(account.metadata instanceof Map)) account.metadata = new Map(Object.entries(account.metadata || {}));
    account.metadata.set('riskUnresolvedDetails', JSON.stringify(details).slice(0, 2000));
    await account.save();
    return account;
  }

  async pendingAccountIds() {
    const rows = await this.eventModel.find({ state: 'RECEIVED' }).select('accountId').lean();
    return [...new Set(rows.map(row => String(row.accountId)).filter(Boolean))];
  }

  async #appendWithinTransaction({ account, session, type, eventKey, financialRevision, policyVersion, riskDayKey, riskTimezone, valuedAtMs, sourceSequence, context }) {
    const existing = await this.eventModel.findOne({ accountId: account._id, eventKey }).session(session);
    if (existing) return { created: false, event: existing };

    const sequence = Number(account.riskSequence || 0) + 1;
    const event = new this.eventModel({
      accountId: account._id,
      sequence,
      eventKey,
      type,
      financialRevision,
      policyVersion,
      riskDayKey,
      riskTimezone,
      valuedAtMs,
      sourceSequence,
      context,
      state: 'RECEIVED',
    });
    await event.save({ session });
    account.riskSequence = sequence;
    account.riskProcessingState = 'RISK_UNRESOLVED';
    account.riskUnresolvedReason = 'PENDING_RISK_EVENTS';
    account.riskUnresolvedSince = account.riskUnresolvedSince || this.now();
    return { created: true, event };
  }
}

function valuationContext(account, valuation, financialRevision, riskDayKey, riskTimezone) {
  return Object.freeze({
    financialRevision,
    policyVersion: policyVersionOf(account),
    riskDayKey,
    riskTimezone,
    initialBalance: scalar(account.state?.initialBalance),
    dailyStartEquity: scalar(account.state?.dailyStartEquity),
    dailyLossLimit: scalar(account.riskPolicy?.dailyLoss?.limit),
    maxLossLimit: scalar(account.riskPolicy?.maxLoss?.limit),
    balance: scalar(valuation.balance),
    floatingPnl: scalar(valuation.floatingPnl),
    equity: scalar(valuation.equity),
    usedMargin: scalar(valuation.usedMargin),
    freeMargin: scalar(valuation.freeMargin),
    marginLevel: scalar(valuation.marginLevel),
    valuationSequence: finiteNumber(valuation.sequence),
    valuedAtMs: finiteNumber(valuation.valuedAtMs),
  });
}

function policyVersionOf(account) {
  const metadata = account?.metadata instanceof Map ? Object.fromEntries(account.metadata) : (account?.metadata || {});
  return metadata.riskPolicyVersion || null;
}

function valuationEventKey(valuation, financialRevision, riskDayKey) {
  const raw = [
    'VALUATION',
    String(valuation.sequence ?? ''),
    String(valuation.valuedAtMs ?? ''),
    String(financialRevision),
    String(riskDayKey),
    scalar(valuation.equity),
    scalar(valuation.usedMargin),
  ].join(':');
  return `VALUATION:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function scalar(value) {
  if (value === null || value === undefined || value === '') return null;
  return value?.toString ? value.toString() : String(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  RiskStreamService,
  valuationContext,
  valuationEventKey,
};
