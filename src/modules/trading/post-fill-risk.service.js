'use strict';

const { normalizeDecimal } = require('../../shared/decimal/decimal');
const { AccountLifecycleEvent } = require('../accounts/account-lifecycle-event.model');
const { AccountRiskEvent } = require('./account-risk-event.model');
const { AccountBreachCleanupJob } = require('./account-breach-cleanup-job.model');
const { evaluateRiskContext } = require('./challenge-risk-engine');

class PostFillRiskService {
  constructor({
    riskEventModel = AccountRiskEvent,
    lifecycleModel = AccountLifecycleEvent,
    cleanupJobModel = AccountBreachCleanupJob,
    platformEventRelay = null,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      riskEventModel,
      lifecycleModel,
      cleanupJobModel,
      platformEventRelay,
      now,
    });
  }

  async evaluateAndApply({ account, order, deal, session, now = this.now() }) {
    const context = buildPostFillRiskContext(account, {
      valuationSequence: deal?.quoteSequence ?? null,
      valuedAtMs: deal?.quoteReceivedAt ? new Date(deal.quoteReceivedAt).getTime() : now.getTime(),
    });
    const outcome = evaluateRiskContext(context);
    const sequence = Number(account.riskSequence || 0) + 1;
    const eventKey = `EXECUTION_RESULT:${String(order?.orderId || order?._id || '')}`;

    const event = new this.riskEventModel({
      accountId: account._id,
      sequence,
      eventKey,
      type: 'EXECUTION_RESULT',
      financialRevision: Number(account.financialRevision || 0),
      policyVersion: context.policyVersion,
      riskDayKey: context.riskDayKey,
      riskTimezone: context.riskTimezone,
      valuedAtMs: context.valuedAtMs,
      sourceSequence: context.valuationSequence,
      context,
      state: outcome.breached ? 'BREACHED' : 'EVALUATED',
      result: outcome,
      evaluatedAt: now,
    });
    await event.save({ session });

    account.riskSequence = sequence;
    if (Number(account.lastEvaluatedRiskSequence || 0) === sequence - 1) {
      account.lastEvaluatedRiskSequence = sequence;
    }

    if (!outcome.breached) return { breached: false, riskEvent: event, outcome };

    const fromStatus = account.status;
    const tradingEnabledBefore = account.tradingEnabled === true;
    const reason = outcome.reason;
    const breachAction = String(account.riskPolicy?.breachAction || 'LIQUIDATE_AND_LOCK').toUpperCase();

    account.status = 'BREACHED';
    account.tradingEnabled = false;
    if (!account.breachedAt) account.breachedAt = now;
    setControlMetadata(account, reason, now);

    const lifecycle = new this.lifecycleModel({
      tenantId: account.tenantId,
      accountId: account._id,
      type: 'BREACHED',
      fromStatus,
      toStatus: 'BREACHED',
      tradingEnabledBefore,
      tradingEnabledAfter: false,
      reason,
      actorType: 'SERVICE',
      actorRef: 'POST_FILL_RISK',
      metadata: {
        riskSequence: String(sequence),
        sourceOrderId: String(order?._id || ''),
        sourceDealId: String(deal?._id || ''),
      },
    });
    await lifecycle.save({ session });

    const cleanupJob = new this.cleanupJobModel({
      tenantId: account.tenantId,
      accountId: account._id,
      jobKey: `post-fill-breach:${String(order?.orderId || order?._id || '')}`,
      sourceOrderId: order._id,
      sourceDealId: deal._id,
      riskSequence: sequence,
      reason,
      breachAction,
      evidence: outcome.evidence,
      state: 'PENDING',
      nextAttemptAt: now,
    });
    await cleanupJob.save({ session });

    await this.platformEventRelay?.enqueueControl({
      account,
      sourceEvent: 'trading.account.breached',
      session,
      evidence: outcome.evidence,
    });

    return {
      breached: true,
      riskEvent: event,
      cleanupJob,
      lifecycle,
      outcome,
    };
  }
}

function buildPostFillRiskContext(account, { valuationSequence = null, valuedAtMs = Date.now() } = {}) {
  const metadata = account?.metadata instanceof Map ? Object.fromEntries(account.metadata) : (account?.metadata || {});
  return Object.freeze({
    financialRevision: Number(account?.financialRevision || 0),
    policyVersion: metadata.riskPolicyVersion || null,
    riskDayKey: account?.riskDayKey || null,
    riskTimezone: String(account?.riskTimezone || 'UTC'),
    initialBalance: decimal(account?.state?.initialBalance, '0'),
    dailyStartEquity: decimal(account?.state?.dailyStartEquity, account?.state?.initialBalance ?? '0'),
    dailyLossLimit: decimal(account?.riskPolicy?.dailyLoss?.limit, '0'),
    maxLossLimit: decimal(account?.riskPolicy?.maxLoss?.limit, '0'),
    balance: decimal(account?.state?.balance, '0'),
    floatingPnl: decimal(account?.state?.floatingPnl, '0'),
    equity: decimal(account?.state?.equity, '0'),
    usedMargin: decimal(account?.state?.usedMargin, '0'),
    freeMargin: decimal(account?.state?.freeMargin, '0'),
    marginLevel: account?.state?.marginLevel == null ? null : normalizeDecimal(account.state.marginLevel),
    valuationSequence: finiteNumber(valuationSequence),
    valuedAtMs: finiteNumber(valuedAtMs),
  });
}

function setControlMetadata(account, reason, now) {
  if (!(account.metadata instanceof Map)) account.metadata = new Map(Object.entries(account.metadata || {}));
  account.metadata.set('lastControlReason', String(reason));
  account.metadata.set('lastControlAt', now.toISOString());
}

function decimal(value, fallback = '0') {
  if (value === null || value === undefined || value === '') return normalizeDecimal(String(fallback));
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  PostFillRiskService,
  buildPostFillRiskContext,
};
