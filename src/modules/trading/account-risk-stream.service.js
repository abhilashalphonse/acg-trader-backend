'use strict';

const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountRiskEvent } = require('./account-risk-event.model');
const { assertFinancialRevision, financialRevisionOf } = require('./account-revision');
const { dayKeyInTimezone } = require('./risk-day-engine');

const APPENDED_EVENT = 'risk.stream.appended';

class AccountRiskStreamService {
  constructor({
    eventBus = null,
    logger = null,
    accountModel = TradingAccount,
    eventModel = AccountRiskEvent,
    runTransaction,
    now = () => new Date(),
  } = {}) {
    if (typeof runTransaction !== 'function') throw new TypeError('runTransaction is required');
    Object.assign(this, {
      eventBus,
      logger,
      accountModel,
      eventModel,
      runTransaction,
      now,
    });
  }

  async ingestValuation(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') {
      return { accepted: false, reason: 'VALUATION_NOT_LIVE', duplicate: false, events: [] };
    }

    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId) throw new TypeError('valuation.accountId is required');
    const sourceEventId = valuationSourceEventId(valuation);
    const valuedAt = valuationDate(valuation, this.now());

    const result = await this.runTransaction(async session => {
      const duplicate = await sessionQuery(
        this.eventModel.findOne({ accountId, sourceEventId }),
        session,
      );
      if (duplicate) {
        return {
          accepted: true,
          duplicate: true,
          events: [duplicate],
          account: null,
        };
      }

      const account = await sessionQuery(this.accountModel.findById(accountId), session);
      if (!account) {
        throw new AppError('Trading account was not found', {
          statusCode: 404,
          code: 'ACCOUNT_NOT_FOUND',
        });
      }

      assertFinancialRevision(account, valuation.financialRevision);

      const timezone = String(account.riskTimezone || 'UTC');
      const valuationDayKey = dayKeyInTimezone(valuedAt, timezone);
      const currentDayKey = String(account.riskDayKey || valuationDayKey);
      if (currentDayKey && valuationDayKey < currentDayKey) {
        throw new AppError('Valuation belongs to an already closed risk day', {
          statusCode: 409,
          code: 'STALE_RISK_DAY_VALUATION',
          details: {
            valuationRiskDayKey: valuationDayKey,
            currentRiskDayKey: currentDayKey,
          },
        });
      }

      const events = [];
      if (currentDayKey !== valuationDayKey) {
        const previous = {
          riskDayKey: currentDayKey,
          dailyStartEquity: value(account.state?.dailyStartEquity, account.state?.initialBalance ?? '0'),
          realizedPnlToday: value(account.state?.realizedPnlToday, '0'),
        };

        account.riskDayKey = valuationDayKey;
        account.state.dailyStartEquity = value(valuation.equity, account.state?.equity ?? account.state?.balance ?? '0');
        account.state.realizedPnlToday = '0';

        events.push(await this.appendEventInSession({
          account,
          eventType: 'RISK_DAY_ROLLOVER',
          sourceEventId: `risk-day:${valuationDayKey}:${sourceEventId}`,
          effectiveAt: valuedAt,
          context: {
            previous,
            next: {
              riskDayKey: valuationDayKey,
              dailyStartEquity: value(account.state.dailyStartEquity, '0'),
              realizedPnlToday: '0',
            },
            triggerValuationEventId: sourceEventId,
          },
          session,
        }));
      }

      events.push(await this.appendEventInSession({
        account,
        eventType: 'VALUATION',
        sourceEventId,
        effectiveAt: valuedAt,
        context: valuationContext(account, valuation),
        session,
      }));

      await account.save({ session });
      return {
        accepted: true,
        duplicate: false,
        events,
        account,
      };
    });

    for (const event of result.events || []) this.emitAppended(event);
    return {
      accepted: result.accepted,
      duplicate: result.duplicate,
      events: (result.events || []).map(serializeRiskEvent),
      accountId,
    };
  }

  async appendPolicyTransitionInSession({
    account,
    before,
    after,
    session,
    sourceEventId = null,
    effectiveAt = this.now(),
  }) {
    if (!account) throw new TypeError('account is required');
    return this.appendEventInSession({
      account,
      eventType: 'POLICY_TRANSITION',
      sourceEventId,
      effectiveAt,
      context: {
        before: clone(before || {}),
        after: clone(after || {}),
      },
      session,
    });
  }

  async appendEventInSession({
    account,
    eventType,
    sourceEventId = null,
    effectiveAt = this.now(),
    context,
    session,
  }) {
    if (!account) throw new TypeError('account is required');
    if (!session) throw new TypeError('session is required');

    const nextSequence = safeSequence(account.riskSequence) + 1;
    account.riskSequence = nextSequence;

    const event = new this.eventModel({
      tenantId: account.tenantId,
      accountId: account._id,
      sequence: nextSequence,
      eventType,
      sourceEventId: sourceEventId || null,
      financialRevision: financialRevisionOf(account),
      accountRevision: safeSequence(account.__v),
      policyVersion: policyVersionOf(account),
      riskDayKey: String(account.riskDayKey || ''),
      riskTimezone: String(account.riskTimezone || 'UTC'),
      effectiveAt: effectiveAt instanceof Date ? effectiveAt : new Date(effectiveAt),
      context: clone(context || {}),
      processingState: 'PENDING',
    });
    await event.save({ session });
    return event;
  }

  async nextForProcessing(accountId) {
    const account = await leanQuery(
      this.accountModel.findById(String(accountId))
        .select('riskSequence riskProcessedSequence riskProcessingState riskExpectedSequence riskNextAvailableSequence status tradingEnabled'),
    );
    if (!account) return { state: 'MISSING_ACCOUNT' };

    const expected = safeSequence(account.riskProcessedSequence) + 1;
    const highest = safeSequence(account.riskSequence);
    if (expected > highest) return { state: 'EMPTY', account, expected, highest };

    const event = await leanQuery(this.eventModel.findOne({ accountId: String(accountId), sequence: expected }));
    if (event) return { state: 'EVENT', account, event, expected, highest };

    const later = await leanQuery(
      this.eventModel.findOne({
        accountId: String(accountId),
        sequence: mongoose.trusted({ $gt: expected }),
      }).sort({ sequence: 1 }),
    );

    return {
      state: 'GAP',
      account,
      expected,
      highest,
      nextAvailable: later ? Number(later.sequence) : null,
    };
  }

  async markUnresolved(accountId, {
    expectedSequence,
    nextAvailableSequence = null,
    reason = 'RISK_SEQUENCE_GAP',
  } = {}) {
    return this.runTransaction(async session => {
      const account = await sessionQuery(this.accountModel.findById(String(accountId)), session);
      if (!account) return null;
      account.riskProcessingState = 'RISK_UNRESOLVED';
      account.riskExpectedSequence = Number(expectedSequence) || (safeSequence(account.riskProcessedSequence) + 1);
      account.riskNextAvailableSequence = Number(nextAvailableSequence) || null;
      account.riskUnresolvedAt = this.now();
      account.riskUnresolvedReason = String(reason || 'RISK_SEQUENCE_GAP');
      await account.save({ session });
      return account;
    });
  }

  async markProcessed(accountId, sequence, {
    processingState = 'PROCESSED',
    processingResult = null,
  } = {}) {
    return this.runTransaction(async session => {
      const account = await sessionQuery(this.accountModel.findById(String(accountId)), session);
      if (!account) return { state: 'MISSING_ACCOUNT' };

      const expected = safeSequence(account.riskProcessedSequence) + 1;
      const requested = Number(sequence);
      if (requested !== expected) {
        account.riskProcessingState = 'RISK_UNRESOLVED';
        account.riskExpectedSequence = expected;
        account.riskNextAvailableSequence = Number.isFinite(requested) && requested > expected ? requested : null;
        account.riskUnresolvedAt = this.now();
        account.riskUnresolvedReason = 'RISK_PROCESSING_SEQUENCE_MISMATCH';
        await account.save({ session });
        return { state: 'GAP', expected, requested };
      }

      const event = await sessionQuery(
        this.eventModel.findOne({ accountId: String(accountId), sequence: requested }),
        session,
      );
      if (!event) {
        account.riskProcessingState = 'RISK_UNRESOLVED';
        account.riskExpectedSequence = expected;
        account.riskNextAvailableSequence = null;
        account.riskUnresolvedAt = this.now();
        account.riskUnresolvedReason = 'RISK_EVENT_MISSING';
        await account.save({ session });
        return { state: 'GAP', expected, requested };
      }

      event.processingState = processingState;
      event.processingResult = clone(processingResult);
      event.processedAt = this.now();
      account.riskProcessedSequence = requested;

      if (safeSequence(account.riskSequence) === requested) {
        account.riskProcessingState = 'READY';
        account.riskExpectedSequence = null;
        account.riskNextAvailableSequence = null;
        account.riskUnresolvedAt = null;
        account.riskUnresolvedReason = null;
      }

      await event.save({ session });
      await account.save({ session });
      return {
        state: 'PROCESSED',
        event: serializeRiskEvent(event),
        riskProcessedSequence: requested,
      };
    });
  }

  async pendingAccountIds() {
    const accounts = await leanQuery(
      this.accountModel.find({
        riskSequence: mongoose.trusted({ $gt: 0 }),
      }).select('_id riskSequence riskProcessedSequence riskProcessingState'),
    );
    return (accounts || [])
      .filter(account =>
        safeSequence(account.riskSequence) > safeSequence(account.riskProcessedSequence)
        || account.riskProcessingState === 'RISK_UNRESOLVED')
      .map(account => String(account._id));
  }

  emitAppended(event) {
    try {
      this.eventBus?.emit(APPENDED_EVENT, serializeRiskEvent(event));
    } catch (error) {
      this.logger?.error?.({ err: error, event: APPENDED_EVENT }, 'Risk stream appended event listener failed');
    }
  }
}

function valuationContext(account, valuation) {
  const policy = account.riskPolicy || {};
  const metadata = account.metadata instanceof Map
    ? Object.fromEntries(account.metadata)
    : (account.metadata || {});
  return {
    accountStatus: String(account.status || '').toUpperCase(),
    tradingEnabled: account.tradingEnabled === true,
    financialRevision: financialRevisionOf(account),
    policyVersion: metadata.riskPolicyVersion || null,
    riskDayKey: String(account.riskDayKey || ''),
    riskTimezone: String(account.riskTimezone || 'UTC'),
    initialBalance: value(account.state?.initialBalance, '0'),
    dailyStartEquity: value(account.state?.dailyStartEquity, account.state?.initialBalance ?? '0'),
    dailyLossLimit: value(policy.dailyLoss?.limit, '0'),
    maxLossLimit: value(policy.maxLoss?.limit, '0'),
    valuation: {
      sourceSequence: finiteNumber(valuation.sequence),
      valuedAtMs: finiteNumber(valuation.valuedAtMs),
      balance: value(valuation.balance, account.state?.balance ?? '0'),
      floatingPnl: value(valuation.floatingPnl, '0'),
      equity: value(valuation.equity, '0'),
      usedMargin: value(valuation.usedMargin, '0'),
      freeMargin: value(valuation.freeMargin, '0'),
      marginLevel: valuation.marginLevel == null ? null : value(valuation.marginLevel, null),
    },
  };
}

function policyVersionOf(account) {
  const metadata = account?.metadata instanceof Map
    ? Object.fromEntries(account.metadata)
    : (account?.metadata || {});
  return metadata.riskPolicyVersion || null;
}

function valuationSourceEventId(valuation) {
  const explicit = String(valuation?.eventId || '').trim();
  if (explicit) return explicit;
  const revision = Number(valuation?.financialRevision);
  const sequence = Number(valuation?.sequence);
  const valuedAtMs = Number(valuation?.valuedAtMs);
  return [
    'valuation',
    Number.isFinite(revision) ? revision : 'na',
    Number.isFinite(sequence) ? sequence : 'na',
    Number.isFinite(valuedAtMs) ? valuedAtMs : 'na',
  ].join(':');
}

function valuationDate(valuation, fallback) {
  const ms = Number(valuation?.valuedAtMs);
  return Number.isFinite(ms) ? new Date(ms) : new Date(fallback);
}

function serializeRiskEvent(event) {
  const row = typeof event?.toObject === 'function'
    ? event.toObject({ getters: false, virtuals: false })
    : event;
  if (!row) return null;
  return {
    id: row._id ? String(row._id) : null,
    tenantId: row.tenantId ? String(row.tenantId) : null,
    accountId: row.accountId ? String(row.accountId) : null,
    sequence: Number(row.sequence),
    eventType: row.eventType,
    sourceEventId: row.sourceEventId || null,
    financialRevision: Number(row.financialRevision ?? 0),
    accountRevision: Number(row.accountRevision ?? 0),
    policyVersion: row.policyVersion || null,
    riskDayKey: row.riskDayKey || null,
    riskTimezone: row.riskTimezone || 'UTC',
    effectiveAt: row.effectiveAt ? new Date(row.effectiveAt).toISOString() : null,
    context: clone(row.context || {}),
    processingState: row.processingState || 'PENDING',
    processedAt: row.processedAt ? new Date(row.processedAt).toISOString() : null,
    processingResult: clone(row.processingResult),
  };
}

function safeSequence(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function value(input, fallback) {
  if (input === null || input === undefined) return fallback == null ? null : String(fallback);
  return input?.toString ? input.toString() : String(input);
}

function clone(input) {
  return input == null ? input : JSON.parse(JSON.stringify(input));
}

async function sessionQuery(query, session) {
  if (query && typeof query.session === 'function') return query.session(session);
  return query;
}

async function leanQuery(query) {
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

module.exports = {
  AccountRiskStreamService,
  APPENDED_EVENT,
  valuationContext,
  valuationSourceEventId,
  serializeRiskEvent,
};
