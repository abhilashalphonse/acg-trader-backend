'use strict';
const { assertPermissionContract } = require('./trading-permission-contract');

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { normalizeDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountLifecycleEvent } = require('../accounts/account-lifecycle-event.model');
const { Order } = require('./order.model');
const { Position } = require('./position.model');
const { AccountLedger } = require('./account-ledger.model');
const { serializeAccount } = require('./trading.serializer');
const { AccountCommandQueue } = require('./account-command-queue');
const { runMongoTransaction } = require('./market-order.service');
const { dayKeyInTimezone } = require('./risk-day-engine');
const { AccountRiskEvent } = require('./account-risk-event.model');
const { AccountPolicyTransition } = require('./account-policy-transition.model');

const RESTRICTED_STATUSES = new Set(['BREACHED', 'DISABLED', 'CLOSED']);
const ACG_FUNDED_V1_POLICY_VERSION = 'ACG_FUNDED_V1';
const ACG_FUNDED_V2_POLICY_VERSION = 'ACG_FUNDED_V2';
const V2_DISABLED_EXECUTION_LIMITS = Object.freeze([
  'maxRiskPerTradePercent',
  'maxAggregateRiskPercent',
  'maxMarginUsagePercent',
  'maxSingleOrderMarginPercentOfFree',
  'maxSymbolMarginPercentOfPermitted',
]);

class AccountControlService {
  constructor({
    eventBus = null,
    logger = null,
    marketOrderService = null,
    platformEventRelay = null,
    accountModel = TradingAccount,
    orderModel = Order,
    positionModel = Position,
    ledgerModel = AccountLedger,
    lifecycleModel = AccountLifecycleEvent,
    riskEventModel = AccountRiskEvent,
    policyTransitionModel = AccountPolicyTransition,
    commandQueue = new AccountCommandQueue(),
    runTransaction = runMongoTransaction,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      eventBus,
      logger,
      marketOrderService,
      platformEventRelay,
      accountModel,
      orderModel,
      positionModel,
      ledgerModel,
      lifecycleModel,
      riskEventModel,
      policyTransitionModel,
      commandQueue,
      runTransaction,
      now,
    });
  }

  async provision(command) {
    const input = normalizeProvisionCommand(command);
    const queueKey = `provision:${input.tenantId}:${input.externalRef}`;

    return this.commandQueue.run(queueKey, async () => {
      const scope = { tenantId: input.tenantId, externalRef: input.externalRef };
      const existing = await this.accountModel.findOne(scope);
      if (existing) return provisionResult(assertProvisionReplay(existing, input), true);
      if (input.accountType !== 'DEMO') assertPermissionContract(command.tradingPermissions, command.tradingPermissionsVersion);

      try {
        const account = await this.runTransaction(async session => {
          const raced = await this.accountModel.findOne(scope).session(session);
          if (raced) return assertProvisionReplay(raced, input);

          const activateImmediately = input.activate !== false;
          const created = new this.accountModel({
            tenantId: input.tenantId,
            accountCode: input.accountCode || generateAccountCode(),
            userId: input.userId,
            ownerExternalRef: input.ownerExternalRef,
            externalRef: input.externalRef,
            accountType: input.accountType,
            currency: input.currency,
            leverage: input.leverage,
            status: activateImmediately ? 'ACTIVE' : 'PAUSED',
            tradingEnabled: activateImmediately,
            federationEnabled: activateImmediately,
            provisioningContractHash: input.provisioningContractHash,
            state: buildInitialState(input.initialBalance),
            riskPolicy: input.riskPolicy,
            tradingPermissions: input.tradingPermissions,
            tradingPermissionsVersion: input.tradingPermissionsVersion,
            riskDayKey: input.riskDayKey,
            riskTimezone: input.riskTimezone,
            metadata: input.metadata,
          });

          await created.save({ session });

          const openingLedger = new this.ledgerModel({
            tenantId: created.tenantId,
            accountId: created._id,
            type: 'DEPOSIT',
            amount: input.initialBalance,
            balanceBefore: '0',
            balanceAfter: input.initialBalance,
            currency: created.currency,
            referenceType: 'SYSTEM',
            referenceId: `provision:${input.externalRef}`,
            idempotencyKey: `provision:${input.externalRef}`,
            reason: 'Initial account funding',
            metadata: { source: 'ACCOUNT_PROVISIONING' },
          });
          await openingLedger.save({ session });

          await this.#recordLifecycle(created, {
            type: 'PROVISIONED',
            fromStatus: null,
            toStatus: activateImmediately ? 'ACTIVE' : 'PAUSED',
            tradingEnabledBefore: null,
            tradingEnabledAfter: activateImmediately,
            reason: activateImmediately ? 'ACCOUNT_PROVISIONED' : 'ACCOUNT_PROVISIONED_STAGED',
          }, session);

          return created;
        });

        this.#emit('trading.account.provisioned', serializeControlledAccount(account));
        return provisionResult(account, false);
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const raced = await this.accountModel.findOne(scope);
        if (!raced) throw error;
        return provisionResult(assertProvisionReplay(raced, input), true);
      }
    });
  }

  async getById(accountId) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    return serializeControlledAccount(account);
  }

  async transitionRiskPolicy(accountId, command = {}) {
    const input = normalizePolicyTransitionCommand(command);
    const key = String(accountId);

    return this.commandQueue.run(key, async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(key).session(session);
        if (!account) throw accountNotFound();

        const existing = await this.policyTransitionModel
          .findOne({ accountId: account._id, migrationId: input.migrationId })
          .session(session);

        if (existing) {
          if (
            String(existing.fromVersion) !== input.fromVersion
            || String(existing.toVersion) !== input.toVersion
          ) {
            throw new AppError('Policy migration id was already used with different versions', {
              statusCode: 409,
              code: 'POLICY_TRANSITION_ID_REUSED',
              details: {
                migrationId: input.migrationId,
                fromVersion: existing.fromVersion,
                toVersion: existing.toVersion,
              },
            });
          }
          assertAuthorizedTransitionReplay(account, existing);
          return { account, transition: existing, idempotentReplay: true };
        }

        if (!['DEMO', 'CHALLENGE', 'FUNDED'].includes(String(account.accountType || '').toUpperCase())) {
          throw new AppError('Account type is not eligible for Funded V2 policy transition', {
            statusCode: 409,
            code: 'POLICY_TRANSITION_ACCOUNT_INELIGIBLE',
            details: { accountType: account.accountType || null },
          });
        }

        const metadata = account.metadata instanceof Map
          ? account.metadata
          : new Map(Object.entries(account.metadata || {}));
        const currentVersion = String(metadata.get('riskPolicyVersion') || '').trim();
        if (currentVersion !== input.fromVersion) {
          throw new AppError('Account policy version does not match the expected migration source version', {
            statusCode: 409,
            code: 'POLICY_TRANSITION_VERSION_MISMATCH',
            details: {
              expectedVersion: input.fromVersion,
              actualVersion: currentVersion || null,
              targetVersion: input.toVersion,
            },
          });
        }

        const previousPolicy = normalizeExistingRiskPolicy(account.riskPolicy || {});
        const nextPolicy = {
          ...previousPolicy,
          ...Object.fromEntries(V2_DISABLED_EXECUTION_LIMITS.map(field => [field, null])),
        };
        const beforeHash = policyTransitionInvariantHash(account);
        const oldRiskSequence = Number(account.riskSequence || 0);
        const effectiveRiskSequence = oldRiskSequence + 1;
        const effectiveFinancialRevision = Number(account.financialRevision || 0);
        const now = this.now();

        for (const field of V2_DISABLED_EXECUTION_LIMITS) {
          account.riskPolicy[field] = null;
        }
        metadata.set('riskPolicyVersion', input.toVersion);
        metadata.set('policyTransitionMigrationId', input.migrationId);
        metadata.set('policyTransitionFromVersion', input.fromVersion);
        metadata.set('policyTransitionToVersion', input.toVersion);
        metadata.set('policyTransitionOriginalProvisioningHash', String(account.provisioningContractHash || ''));
        metadata.set('policyTransitionEffectiveRiskSequence', String(effectiveRiskSequence));
        account.metadata = metadata;
        account.riskSequence = effectiveRiskSequence;
        if (Number(account.lastEvaluatedRiskSequence || 0) === oldRiskSequence) {
          account.lastEvaluatedRiskSequence = effectiveRiskSequence;
        }

        const riskEvent = new this.riskEventModel({
          accountId: account._id,
          sequence: effectiveRiskSequence,
          eventKey: `POLICY_TRANSITION:${input.migrationId}`,
          type: 'POLICY_TRANSITION',
          financialRevision: effectiveFinancialRevision,
          policyVersion: input.toVersion,
          riskDayKey: String(account.riskDayKey || dayKeyInTimezone(now, account.riskTimezone || 'UTC')),
          riskTimezone: String(account.riskTimezone || 'UTC'),
          valuedAtMs: now.getTime(),
          sourceSequence: null,
          context: {
            migrationId: input.migrationId,
            fromVersion: input.fromVersion,
            toVersion: input.toVersion,
            previousPolicy,
            newPolicy: nextPolicy,
            originalProvisioningContractHash: account.provisioningContractHash || null,
            preservedRiskProcessingState: account.riskProcessingState || 'RESOLVED',
            preservedMarginStopOutState: account.marginStopOutState || 'NONE',
          },
          state: 'EVALUATED',
          result: {
            applied: true,
            migrationId: input.migrationId,
            fromVersion: input.fromVersion,
            toVersion: input.toVersion,
          },
          evaluatedAt: now,
        });

        await riskEvent.save({ session });
        await account.save({ session });

        const afterHash = policyTransitionInvariantHash(account);
        if (beforeHash !== afterHash) {
          throw new AppError('Policy transition changed protected account state', {
            statusCode: 409,
            code: 'POLICY_TRANSITION_INVARIANT_VIOLATION',
            details: { migrationId: input.migrationId },
          });
        }

        const transition = new this.policyTransitionModel({
          tenantId: account.tenantId,
          accountId: account._id,
          migrationId: input.migrationId,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          effectiveRiskSequence,
          effectiveFinancialRevision,
          originalProvisioningContractHash: account.provisioningContractHash || null,
          previousPolicy,
          newPolicy: nextPolicy,
          preservedStateHashBefore: beforeHash,
          preservedStateHashAfter: afterHash,
          status: 'COMPLETED',
          verifiedAt: now,
        });
        await transition.save({ session });

        return { account, transition, idempotentReplay: false };
      });

      const serialized = serializeControlledAccount(result.account);
      this.#emit('trading.account.updated', serialized);
      return {
        operation: 'POLICY_TRANSITION',
        account: serialized,
        transition: serializePolicyTransition(result.transition),
        idempotentReplay: result.idempotentReplay,
      };
    });
  }

  async pause(accountId, { reason = 'MANUAL_PAUSE', cancelPending = false } = {}) {
    return this.#restrict(accountId, {
      status: 'PAUSED',
      reason,
      cancelPending,
      event: 'trading.account.paused',
      lifecycleType: 'PAUSED',
    });
  }

  async stage(accountId, { reason = 'ACCOUNT_STAGED', cancelPending = true } = {}) {
    return this.#restrict(accountId, {
      status: 'PAUSED',
      reason,
      cancelPending,
      federationEnabled: false,
      event: 'trading.account.paused',
      lifecycleType: 'PAUSED',
    });
  }

  async activate(accountId, { reason = 'ACCOUNT_ACTIVATED' } = {}) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(String(accountId)).session(session);
        if (!account) throw accountNotFound();
        if (RESTRICTED_STATUSES.has(account.status)) {
          throw new AppError('Terminal trading account cannot be activated', {
            statusCode: 409,
            code: 'ACCOUNT_ACTIVATION_FORBIDDEN',
            details: { status: account.status },
          });
        }
        if (account.status === 'ACTIVE' && account.tradingEnabled === true && account.federationEnabled !== false) {
          return { account, changed: false };
        }

        const fromStatus = account.status;
        const tradingEnabledBefore = account.tradingEnabled;
        account.status = 'ACTIVE';
        account.tradingEnabled = true;
        account.federationEnabled = true;
        setControlMetadata(account, reason, this.now());
        await account.save({ session });
        await this.#recordLifecycle(account, {
          type: 'RESUMED',
          fromStatus,
          toStatus: 'ACTIVE',
          tradingEnabledBefore,
          tradingEnabledAfter: true,
          reason,
        }, session);
        await this.platformEventRelay?.enqueueControl({ account, sourceEvent: 'trading.account.resumed', session });
        return { account, changed: true };
      });

      if (result.changed) this.#emit('trading.account.resumed', serializeControlledAccount(result.account));
      return controlResult(result.account, { changed: result.changed });
    });
  }

  async resume(accountId, { reason = 'MANUAL_RESUME' } = {}) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(String(accountId)).session(session);
        if (!account) throw accountNotFound();
        if (
          account.status === 'ACTIVE'
          && account.tradingEnabled === true
          && account.federationEnabled !== false
        ) {
          return { account, changed: false };
        }
        if (RESTRICTED_STATUSES.has(account.status)) {
          throw new AppError('Restricted trading account cannot be resumed', {
            statusCode: 409,
            code: 'ACCOUNT_RESUME_FORBIDDEN',
            details: { status: account.status },
          });
        }
        if (account.federationEnabled === false) {
          throw new AppError('Staged trading account requires lifecycle activation', {
            statusCode: 409,
            code: 'ACCOUNT_ACTIVATION_REQUIRED',
          });
        }

        const fromStatus = account.status;
        const tradingEnabledBefore = account.tradingEnabled;
        account.status = 'ACTIVE';
        account.tradingEnabled = true;
        setControlMetadata(account, reason, this.now());
        await account.save({ session });
        await this.#recordLifecycle(account, {
          type: 'RESUMED',
          fromStatus,
          toStatus: 'ACTIVE',
          tradingEnabledBefore,
          tradingEnabledAfter: true,
          reason,
        }, session);
        await this.platformEventRelay?.enqueueControl({ account, sourceEvent: 'trading.account.resumed', session });
        return { account, changed: true };
      });

      if (result.changed) this.#emit('trading.account.resumed', serializeControlledAccount(result.account));
      return controlResult(result.account, { changed: result.changed });
    });
  }

  async disable(accountId, { reason = 'ACCOUNT_DISABLED', cancelPending = true, liquidate = false } = {}) {
    const restricted = await this.#restrict(accountId, {
      status: 'DISABLED',
      reason,
      cancelPending,
      event: 'trading.account.disabled',
      lifecycleType: 'DISABLED',
    });
    const liquidation = liquidate ? await this.#liquidate(accountId) : [];
    return { ...restricted, liquidation };
  }

  async breach(accountId, { reason = 'RISK_BREACH', action = null, evidence = null } = {}) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    const breachAction = action || account.riskPolicy?.breachAction || 'LIQUIDATE_AND_LOCK';
    if (!['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK'].includes(breachAction)) {
      throw new AppError('Invalid breach action', { statusCode: 400, code: 'INVALID_BREACH_ACTION' });
    }

    const restricted = await this.#restrict(accountId, {
      status: 'BREACHED',
      reason,
      cancelPending: breachAction !== 'LOCK_ONLY',
      breach: true,
      event: 'trading.account.breached',
      lifecycleType: 'BREACHED',
      controlEvidence: evidence,
    });
    const liquidation = breachAction === 'LIQUIDATE_AND_LOCK' ? await this.#liquidate(accountId) : [];
    return { ...restricted, breachAction, liquidation };
  }

  async flatten(accountId, { reason = 'ACCOUNT_FLATTENED_FOR_REVIEW' } = {}) {
    const paused = await this.pause(accountId, { reason, cancelPending: true });
    const liquidation = await this.#liquidate(accountId);
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    return { ...controlResult(account, { changed: paused.changed }), liquidation };
  }

  async close(accountId, { reason = 'ACCOUNT_CLOSED', liquidate = true } = {}) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    if (account.status === 'CLOSED') {
      return { ...controlResult(account, { changed: false }), liquidation: [] };
    }

    if (!liquidate) {
      const openCount = await this.positionModel.countDocuments({ accountId: String(accountId), status: 'OPEN' });
      if (openCount > 0) {
        throw new AppError('Account has open positions and cannot be closed without liquidation', {
          statusCode: 409,
          code: 'ACCOUNT_HAS_OPEN_POSITIONS',
          details: { openPositions: openCount },
        });
      }
    }

    await this.#restrict(accountId, {
      status: 'DISABLED',
      reason: `${reason}:PRE_CLOSE`,
      cancelPending: true,
      event: 'trading.account.closing',
      lifecycleType: 'CLOSING',
    });

    const liquidation = liquidate ? await this.#liquidate(accountId) : [];

    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const current = await this.accountModel.findById(String(accountId)).session(session);
        if (!current) throw accountNotFound();
        if (current.status === 'CLOSED') return { account: current, changed: false };

        const fromStatus = current.status;
        const tradingEnabledBefore = current.tradingEnabled;
        current.status = 'CLOSED';
        current.tradingEnabled = false;
        current.closedAt = this.now();
        setControlMetadata(current, reason, this.now());
        await current.save({ session });
        await this.#recordLifecycle(current, {
          type: 'CLOSED',
          fromStatus,
          toStatus: 'CLOSED',
          tradingEnabledBefore,
          tradingEnabledAfter: false,
          reason,
        }, session);
        await this.platformEventRelay?.enqueueControl({ account: current, sourceEvent: 'trading.account.closed', session });
        return { account: current, changed: true };
      });

      if (result.changed) this.#emit('trading.account.closed', serializeControlledAccount(result.account));
      return { ...controlResult(result.account, { changed: result.changed }), liquidation };
    });
  }

  async #restrict(accountId, { status, reason, cancelPending, breach = false, federationEnabled = null, event, lifecycleType, controlEvidence = null }) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(String(accountId)).session(session);
        if (!account) throw accountNotFound();
        const now = this.now();
        const terminalPreserved = RESTRICTED_STATUSES.has(account.status) && account.status !== status;
        let cancelledPending = 0;
        if (terminalPreserved) {
          if (cancelPending) cancelledPending = await this.#cancelPending(account._id, reason, now, session);
          return { account, changed: false, cancelledPending, terminalPreserved: true };
        }

        const federationAlreadyApplied = federationEnabled === null
          || account.federationEnabled === federationEnabled;
        const alreadyApplied = account.status === status
          && account.tradingEnabled === false
          && federationAlreadyApplied;
        const fromStatus = account.status;
        const tradingEnabledBefore = account.tradingEnabled;

        account.status = status;
        account.tradingEnabled = false;
        if (federationEnabled !== null) account.federationEnabled = federationEnabled;
        if (breach && !account.breachedAt) account.breachedAt = now;
        setControlMetadata(account, reason, now);
        await account.save({ session });

        if (cancelPending) cancelledPending = await this.#cancelPending(account._id, reason, now, session);

        if (!alreadyApplied) {
          await this.#recordLifecycle(account, {
            type: lifecycleType,
            fromStatus,
            toStatus: status,
            tradingEnabledBefore,
            tradingEnabledAfter: false,
            reason,
          }, session);
          await this.platformEventRelay?.enqueueControl({ account, sourceEvent: event, session, evidence: controlEvidence });
        }

        return { account, changed: !alreadyApplied, cancelledPending };
      });

      if (result.changed) this.#emit(event, serializeControlledAccount(result.account));
      return controlResult(result.account, {
        changed: result.changed,
        cancelledPending: result.cancelledPending,
        terminalPreserved: result.terminalPreserved === true,
      });
    });
  }

  async #cancelPending(accountId, reason, now, session) {
    const result = await this.orderModel.updateMany(
      { accountId, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          rejectCode: null,
          rejectMessage: null,
          'metadata.controlCancellationReason': String(reason),
        },
      },
      { session },
    );
    return result.modifiedCount ?? result.nModified ?? 0;
  }

  async #recordLifecycle(account, event, session) {
    const record = new this.lifecycleModel({
      tenantId: account.tenantId,
      accountId: account._id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      tradingEnabledBefore: event.tradingEnabledBefore,
      tradingEnabledAfter: event.tradingEnabledAfter,
      reason: String(event.reason),
      actorType: 'SERVICE',
    });
    await record.save({ session });
    return record;
  }

  async #liquidate(accountId) {
    if (!this.marketOrderService) {
      throw new AppError('Account liquidation service is unavailable', {
        statusCode: 503,
        code: 'ACCOUNT_LIQUIDATION_UNAVAILABLE',
      });
    }

    const positions = await this.positionModel.find({ accountId: String(accountId), status: 'OPEN' }).select('_id').lean();
    const results = [];
    for (const position of positions) {
      const positionId = String(position._id);
      try {
        const result = await this.marketOrderService.closeMarketPosition({
          accountId: String(accountId),
          positionId,
          clientOrderId: `control-liquidation:${positionId}`,
          source: 'SYSTEM',
          reason: 'ACCOUNT_LIQUIDATION',
        });
        results.push({ positionId, status: 'CLOSED', result });
      } catch (error) {
        this.logger?.error({ err: error, accountId: String(accountId), positionId }, 'Account liquidation failed');
        results.push({
          positionId,
          status: 'FAILED',
          error: {
            code: error?.code || 'COMMAND_FAILED',
            message: error?.message || 'Position liquidation failed',
            statusCode: Number(error?.statusCode) || 500,
          },
        });
      }
    }

    const failed = results.filter(item => item.status === 'FAILED');
    if (failed.length) {
      throw new AppError('Failed to liquidate all open positions', {
        statusCode: 409,
        code: 'ACCOUNT_LIQUIDATION_FAILED',
        details: {
          requestedPositions: positions.length,
          closedPositions: results.length - failed.length,
          failedPositions: failed.map(item => ({
            positionId: item.positionId,
            causeCode: item.error.code,
          })),
        },
      });
    }
    return results;
  }

  #emit(name, payload) {
    try {
      this.eventBus?.emit(name, payload);
    } catch (error) {
      this.logger?.error({ err: error, event: name }, 'Account control event listener failed');
    }
  }
}

function normalizePolicyTransitionCommand(command = {}) {
  const migrationId = requiredString(command.migrationId, 'migrationId');
  const fromVersion = requiredString(command.fromVersion, 'fromVersion');
  const toVersion = requiredString(command.toVersion, 'toVersion');

  if (fromVersion !== ACG_FUNDED_V1_POLICY_VERSION || toVersion !== ACG_FUNDED_V2_POLICY_VERSION) {
    throw new AppError('Only the authorized ACG Funded V1 to V2 transition is supported', {
      statusCode: 400,
      code: 'POLICY_TRANSITION_UNSUPPORTED',
      details: { fromVersion, toVersion },
    });
  }

  const policy = command.riskPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new AppError('riskPolicy is required for policy transition', {
      statusCode: 400,
      code: 'INVALID_ACCOUNT_CONTROL_COMMAND',
    });
  }

  const keys = Object.keys(policy).sort();
  const expected = [...V2_DISABLED_EXECUTION_LIMITS].sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || V2_DISABLED_EXECUTION_LIMITS.some(key => policy[key] !== null)
  ) {
    throw new AppError('V2 policy transition may only clear the five authorized execution restrictions', {
      statusCode: 400,
      code: 'POLICY_TRANSITION_SCOPE_VIOLATION',
      details: { allowedFields: V2_DISABLED_EXECUTION_LIMITS },
    });
  }

  return { migrationId, fromVersion, toVersion, riskPolicy: policy };
}

function policyTransitionInvariantHash(account) {
  const state = account?.state || {};
  const protectedState = {
    status: String(account?.status || ''),
    tradingEnabled: Boolean(account?.tradingEnabled),
    federationEnabled: account?.federationEnabled !== false,
    provisioningContractHash: String(account?.provisioningContractHash || ''),
    financialRevision: Number(account?.financialRevision || 0),
    riskDayKey: account?.riskDayKey || null,
    riskTimezone: account?.riskTimezone || 'UTC',
    riskProcessingState: account?.riskProcessingState || 'RESOLVED',
    riskUnresolvedReason: account?.riskUnresolvedReason || null,
    riskUnresolvedSince: account?.riskUnresolvedSince ? new Date(account.riskUnresolvedSince).toISOString() : null,
    marginStopOutState: account?.marginStopOutState || 'NONE',
    marginStopOutEpisodeId: account?.marginStopOutEpisodeId || null,
    marginStopOutStartedAt: account?.marginStopOutStartedAt ? new Date(account.marginStopOutStartedAt).toISOString() : null,
    breachedAt: account?.breachedAt ? new Date(account.breachedAt).toISOString() : null,
    closedAt: account?.closedAt ? new Date(account.closedAt).toISOString() : null,
    state: {
      initialBalance: state.initialBalance == null ? null : normalizeDecimal(state.initialBalance),
      balance: state.balance == null ? null : normalizeDecimal(state.balance),
      equity: state.equity == null ? null : normalizeDecimal(state.equity),
      floatingPnl: state.floatingPnl == null ? null : normalizeDecimal(state.floatingPnl),
      realizedPnlToday: state.realizedPnlToday == null ? null : normalizeDecimal(state.realizedPnlToday),
      usedMargin: state.usedMargin == null ? null : normalizeDecimal(state.usedMargin),
      freeMargin: state.freeMargin == null ? null : normalizeDecimal(state.freeMargin),
      marginLevel: state.marginLevel == null ? null : normalizeDecimal(state.marginLevel),
      dailyStartEquity: state.dailyStartEquity == null ? null : normalizeDecimal(state.dailyStartEquity),
    },
  };
  return crypto.createHash('sha256').update(canonicalJson(protectedState)).digest('hex');
}

function assertAuthorizedTransitionReplay(account, transition) {
  const metadata = account.metadata instanceof Map
    ? Object.fromEntries(account.metadata)
    : (account.metadata || {});
  if (
    String(metadata.riskPolicyVersion || '') !== String(transition.toVersion)
    || String(metadata.policyTransitionMigrationId || '') !== String(transition.migrationId)
    || String(metadata.policyTransitionOriginalProvisioningHash || '') !== String(account.provisioningContractHash || '')
    || canonicalJson(normalizeExistingRiskPolicy(account.riskPolicy || {})) !== canonicalJson(transition.newPolicy || {})
  ) {
    throw new AppError('Recorded policy transition no longer matches the account state', {
      statusCode: 409,
      code: 'POLICY_TRANSITION_REPLAY_CONFLICT',
      details: { migrationId: transition.migrationId },
    });
  }
}

function serializePolicyTransition(transition) {
  if (!transition) return null;
  return {
    id: String(transition._id || transition.transitionId || ''),
    transitionId: transition.transitionId || null,
    migrationId: transition.migrationId,
    fromVersion: transition.fromVersion,
    toVersion: transition.toVersion,
    effectiveRiskSequence: Number(transition.effectiveRiskSequence),
    effectiveFinancialRevision: Number(transition.effectiveFinancialRevision),
    originalProvisioningContractHash: transition.originalProvisioningContractHash || null,
    preservedStateHashBefore: transition.preservedStateHashBefore,
    preservedStateHashAfter: transition.preservedStateHashAfter,
    status: transition.status,
    verifiedAt: transition.verifiedAt ? new Date(transition.verifiedAt).toISOString() : null,
    createdAt: transition.createdAt ? new Date(transition.createdAt).toISOString() : null,
  };
}

function normalizeProvisionCommand(command) {
  const tenantId = requiredString(command?.tenantId, 'tenantId');
  const externalRef = requiredString(command?.externalRef, 'externalRef');
  const ownerExternalRef = command?.ownerExternalRef == null
    ? null
    : requiredString(command.ownerExternalRef, 'ownerExternalRef');
  const userId = command?.userId == null ? null : String(command.userId).trim();

  if (!ownerExternalRef && !userId) {
    throw new AppError('Either ownerExternalRef or userId is required', {
      statusCode: 400,
      code: 'ACCOUNT_OWNER_REQUIRED',
    });
  }

  const initialBalance = normalizeDecimal(command?.initialBalance ?? '0');
  if (compareDecimal(initialBalance, '0') <= 0) {
    throw new AppError('initialBalance must be greater than zero', {
      statusCode: 400,
      code: 'INVALID_INITIAL_BALANCE',
    });
  }

  const leverage = Number(command?.leverage ?? 100);
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new AppError('leverage must be a positive integer', {
      statusCode: 400,
      code: 'INVALID_LEVERAGE',
    });
  }

  const accountType = String(command?.accountType || 'CHALLENGE').toUpperCase();
  if (!['DEMO', 'CHALLENGE', 'FUNDED'].includes(accountType)) {
    throw new AppError('Invalid accountType', { statusCode: 400, code: 'INVALID_ACCOUNT_TYPE' });
  }

  const riskTimezone = String(command?.riskTimezone || 'UTC').trim() || 'UTC';
  const provisionDayKey = dayKeyInTimezone(new Date(), riskTimezone);
  const riskPolicy = normalizeRiskPolicy(command?.riskPolicy);
  const tradingPermissions = normalizeTradingPermissions(command?.tradingPermissions);
  const metadata = normalizeMetadata(command?.metadata);
  const input = {
    tenantId,
    externalRef,
    ownerExternalRef,
    userId: userId || null,
    accountCode: command?.accountCode ? requiredString(command.accountCode, 'accountCode').toUpperCase() : null,
    accountType,
    currency: String(command?.currency || 'USD').toUpperCase(),
    leverage,
    initialBalance,
    activate: command?.activate !== false,
    riskPolicy,
    tradingPermissions,
    tradingPermissionsVersion: Number(command?.tradingPermissionsVersion || 0),
    riskDayKey: String(command?.riskDayKey || provisionDayKey).trim(),
    riskTimezone,
    metadata,
  };
  input.provisioningContractHash = provisioningContractHash(input);
  return input;
}
function normalizeTradingPermissions(value = {}) {
  return {
    newsTrading: value?.newsTrading !== false,
    weekendHolding: value?.weekendHolding !== false,
    highImpactOnly: true,
    newsRestrictionBeforeMinutes: 5,
    newsRestrictionAfterMinutes: 5,
    closeReduceAlwaysAllowed: true,
    pendingEntriesBlocked: true,
    weekendCloseBufferMinutes: 5,
    weekendBreach: false,
    carryToMaster: true,
  };
}

function normalizeRiskPolicy(policy = {}) {
  const dailyLimit = normalizeDecimal(policy?.dailyLoss?.limit ?? '0');
  const maxLimit = normalizeDecimal(policy?.maxLoss?.limit ?? '0');
  const profitTarget = normalizeDecimal(policy?.profitTarget ?? '0');
  const maxPositionVolume = policy?.maxPositionVolume == null ? null : normalizeDecimal(policy.maxPositionVolume);
  const maxSymbolVolume = policy?.maxSymbolVolume == null ? null : normalizeDecimal(policy.maxSymbolVolume);
  const maxTotalVolume = policy?.maxTotalVolume == null ? null : normalizeDecimal(policy.maxTotalVolume);
  const maxRiskPerTradePercent = policy?.maxRiskPerTradePercent == null ? null : normalizeDecimal(policy.maxRiskPerTradePercent);
  const maxAggregateRiskPercent = policy?.maxAggregateRiskPercent == null ? null : normalizeDecimal(policy.maxAggregateRiskPercent);
  const maxMarginUsagePercent = policy?.maxMarginUsagePercent == null ? null : normalizeDecimal(policy.maxMarginUsagePercent);
  const maxSingleOrderMarginPercentOfFree = policy?.maxSingleOrderMarginPercentOfFree == null ? null : normalizeDecimal(policy.maxSingleOrderMarginPercentOfFree);
  const maxSymbolMarginPercentOfPermitted = policy?.maxSymbolMarginPercentOfPermitted == null ? null : normalizeDecimal(policy.maxSymbolMarginPercentOfPermitted);

  for (const [field, value] of [
    ['dailyLoss.limit', dailyLimit],
    ['maxLoss.limit', maxLimit],
    ['profitTarget', profitTarget],
    ['maxPositionVolume', maxPositionVolume],
    ['maxSymbolVolume', maxSymbolVolume],
    ['maxTotalVolume', maxTotalVolume],
    ['maxRiskPerTradePercent', maxRiskPerTradePercent],
    ['maxAggregateRiskPercent', maxAggregateRiskPercent],
    ['maxMarginUsagePercent', maxMarginUsagePercent],
    ['maxSingleOrderMarginPercentOfFree', maxSingleOrderMarginPercentOfFree],
    ['maxSymbolMarginPercentOfPermitted', maxSymbolMarginPercentOfPermitted],
  ]) {
    if (value != null && compareDecimal(value, '0') < 0) {
      throw new AppError(`${field} cannot be negative`, {
        statusCode: 400,
        code: 'INVALID_RISK_POLICY',
      });
    }
  }

  return {
    dailyLoss: {
      limit: dailyLimit,
      reference: String(policy?.dailyLoss?.reference || 'DAILY_START_EQUITY'),
    },
    maxLoss: {
      limit: maxLimit,
      reference: String(policy?.maxLoss?.reference || 'INITIAL_BALANCE'),
    },
    profitTarget,
    breachAction: String(policy?.breachAction || 'LIQUIDATE_AND_LOCK').toUpperCase(),
    maxOpenPositions: policy?.maxOpenPositions ?? null,
    maxPositionsPerSymbol: policy?.maxPositionsPerSymbol ?? null,
    maxPendingOrders: policy?.maxPendingOrders ?? null,
    maxPendingOrdersPerSymbol: policy?.maxPendingOrdersPerSymbol ?? null,
    maxPositionVolume,
    maxSymbolVolume,
    maxTotalVolume,
    maxRiskPerTradePercent,
    maxAggregateRiskPercent,
    maxMarginUsagePercent,
    maxSingleOrderMarginPercentOfFree,
    maxSymbolMarginPercentOfPermitted,
    allowedSymbols: Array.isArray(policy?.allowedSymbols)
      ? policy.allowedSymbols.map(value => String(value).replace('/', '').toUpperCase())
      : [],
  };
}

function buildInitialState(initialBalance) {
  return {
    initialBalance,
    balance: initialBalance,
    equity: initialBalance,
    floatingPnl: '0',
    realizedPnlToday: '0',
    usedMargin: '0',
    freeMargin: initialBalance,
    dailyStartEquity: initialBalance,
  };
}

function assertProvisionReplay(account, input) {
  const mismatches = [];
  if (input.tradingPermissionsVersion > 0 && Number(account.tradingPermissionsVersion || 0) > 0) {
    if (input.tradingPermissionsVersion !== account.tradingPermissionsVersion
      || input.tradingPermissions.newsTrading !== account.tradingPermissions?.newsTrading
      || input.tradingPermissions.weekendHolding !== account.tradingPermissions?.weekendHolding) mismatches.push('tradingPermissions');
  }
  if (String(account.tenantId || '') !== String(input.tenantId || '')) mismatches.push('tenantId');
  if (String(account.ownerExternalRef || '') !== String(input.ownerExternalRef || '')) mismatches.push('ownerExternalRef');
  if (String(account.userId || '') !== String(input.userId || '')) mismatches.push('userId');
  if (String(account.accountType || '') !== input.accountType) mismatches.push('accountType');
  if (String(account.currency || '') !== input.currency) mismatches.push('currency');
  if (Number(account.leverage) !== input.leverage) mismatches.push('leverage');
  if (normalizeDecimal(account.state?.initialBalance ?? '0') !== input.initialBalance) mismatches.push('initialBalance');
  if (input.accountCode && String(account.accountCode || '') !== input.accountCode) mismatches.push('accountCode');

  const storedContractHash = String(account.provisioningContractHash || '').trim();
  if (storedContractHash && storedContractHash !== input.provisioningContractHash) {
    // ACG Funded account policies were repaired in place after an earlier
    // migration incorrectly cleared official account-level limits. Preserve
    // immutable provisioning hashes, but allow an idempotent replay when the
    // live account state now exactly matches the incoming Funded contract.
    if (!isCompatibleFundedPolicyRepairReplay(account, input)) {
      mismatches.push('provisioningContract');
    }
  } else if (!storedContractHash) {
    if (
      input.riskPolicy
      && canonicalJson(normalizeExistingRiskPolicy(account.riskPolicy || {})) !== canonicalJson(input.riskPolicy)
    ) {
      mismatches.push('riskPolicy');
    }
    const currentMetadata = account.metadata instanceof Map ? Object.fromEntries(account.metadata) : (account.metadata || {});
    for (const [key, value] of Object.entries(input.metadata || {})) {
      if (String(currentMetadata[key] ?? '') !== String(value)) mismatches.push(`metadata.${key}`);
    }
    if (
      input.riskTimezone
      && String(account.riskTimezone || 'UTC') !== String(input.riskTimezone)
    ) mismatches.push('riskTimezone');
  }

  if (mismatches.length) {
    throw new AppError('externalRef is already provisioned with different account parameters', {
      statusCode: 409,
      code: 'ACCOUNT_PROVISIONING_CONFLICT',
      details: { externalRef: input.externalRef, mismatches: [...new Set(mismatches)] },
    });
  }
  return account;
}

function isCompatibleFundedPolicyRepairReplay(account, input) {
  const currentMetadata = account.metadata instanceof Map
    ? Object.fromEntries(account.metadata)
    : (account.metadata || {});
  const storedFundedAccountId = String(currentMetadata.fundedAccountId ?? '').trim();
  const incomingFundedAccountId = String(input?.metadata?.fundedAccountId ?? '').trim();
  if (!storedFundedAccountId || storedFundedAccountId !== incomingFundedAccountId) return false;

  if (
    canonicalJson(normalizeExistingRiskPolicy(account.riskPolicy || {}))
    !== canonicalJson(input.riskPolicy || {})
  ) return false;

  for (const [key, value] of Object.entries(input.metadata || {})) {
    if (String(currentMetadata[key] ?? '') !== String(value)) return false;
  }

  if (
    input.riskTimezone
    && String(account.riskTimezone || 'UTC') !== String(input.riskTimezone)
  ) return false;

  const incomingVersion = String(input?.metadata?.riskPolicyVersion || '').trim();
  if (incomingVersion === ACG_FUNDED_V2_POLICY_VERSION) {
    const storedHash = String(account.provisioningContractHash || '').trim();
    return Boolean(
      storedHash
      && String(currentMetadata.policyTransitionToVersion || '') === ACG_FUNDED_V2_POLICY_VERSION
      && String(currentMetadata.policyTransitionFromVersion || '') === ACG_FUNDED_V1_POLICY_VERSION
      && String(currentMetadata.policyTransitionMigrationId || '').trim()
      && String(currentMetadata.policyTransitionOriginalProvisioningHash || '') === storedHash
    );
  }

  // Preserve the historical V1 repair replay only for non-V2 contracts.
  return incomingVersion !== ACG_FUNDED_V2_POLICY_VERSION;
}

function provisioningContractHash(input) {
  const contract = {
    tenantId: String(input.tenantId || ''),
    ownerExternalRef: String(input.ownerExternalRef || ''),
    userId: String(input.userId || ''),
    accountType: String(input.accountType || ''),
    currency: String(input.currency || ''),
    leverage: Number(input.leverage || 0),
    initialBalance: normalizeDecimal(input.initialBalance ?? '0'),
    riskPolicy: input.riskPolicy || {},
    riskTimezone: String(input.riskTimezone || 'UTC'),
    metadata: input.metadata || {},
  };
  return crypto.createHash('sha256').update(canonicalJson(contract)).digest('hex');
}

function normalizeExistingRiskPolicy(policy = {}) {
  const read = value => value == null ? null : normalizeDecimal(value);
  return {
    dailyLoss: {
      limit: read(policy?.dailyLoss?.limit ?? '0'),
      reference: String(policy?.dailyLoss?.reference || 'DAILY_START_EQUITY'),
    },
    maxLoss: {
      limit: read(policy?.maxLoss?.limit ?? '0'),
      reference: String(policy?.maxLoss?.reference || 'INITIAL_BALANCE'),
    },
    profitTarget: read(policy?.profitTarget ?? '0'),
    breachAction: String(policy?.breachAction || 'LIQUIDATE_AND_LOCK').toUpperCase(),
    maxOpenPositions: policy?.maxOpenPositions ?? null,
    maxPositionsPerSymbol: policy?.maxPositionsPerSymbol ?? null,
    maxPendingOrders: policy?.maxPendingOrders ?? null,
    maxPendingOrdersPerSymbol: policy?.maxPendingOrdersPerSymbol ?? null,
    maxPositionVolume: read(policy?.maxPositionVolume),
    maxSymbolVolume: read(policy?.maxSymbolVolume),
    maxTotalVolume: read(policy?.maxTotalVolume),
    maxRiskPerTradePercent: read(policy?.maxRiskPerTradePercent),
    maxAggregateRiskPercent: read(policy?.maxAggregateRiskPercent),
    maxMarginUsagePercent: read(policy?.maxMarginUsagePercent),
    maxSingleOrderMarginPercentOfFree: read(policy?.maxSingleOrderMarginPercentOfFree),
    maxSymbolMarginPercentOfPermitted: read(policy?.maxSymbolMarginPercentOfPermitted),
    allowedSymbols: Array.isArray(policy?.allowedSymbols)
      ? policy.allowedSymbols.map(value => String(value).replace('/', '').toUpperCase())
      : [],
  };
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const plain = value instanceof Map ? Object.fromEntries(value) : value;
  return `{${Object.keys(plain).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(plain[key])}`).join(',')}}`;
}
function setControlMetadata(account, reason, at) {
  if (!(account.metadata instanceof Map)) account.metadata = new Map(Object.entries(account.metadata || {}));
  account.metadata.set('lastControlReason', String(reason));
  account.metadata.set('lastControlAt', at.toISOString());
}

function serializeControlledAccount(account) {
  return {
    ...serializeAccount(account),
    tenantId: account.tenantId ? String(account.tenantId) : null,
    ownerExternalRef: account.ownerExternalRef || null,
    externalRef: account.externalRef || null,
    riskDayKey: account.riskDayKey || null,
    riskTimezone: account.riskTimezone || 'UTC',
    federationEnabled: account.federationEnabled !== false,
    provisioningContractHash: account.provisioningContractHash || null,
    breachedAt: account.breachedAt ? new Date(account.breachedAt).toISOString() : null,
    closedAt: account.closedAt ? new Date(account.closedAt).toISOString() : null,
  };
}

function provisionResult(account, idempotentReplay) {
  return { account: serializeControlledAccount(account), idempotentReplay };
}

function controlResult(account, extra = {}) {
  return { account: serializeControlledAccount(account), ...extra };
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new AppError(`${field} is required`, {
      statusCode: 400,
      code: 'INVALID_ACCOUNT_CONTROL_COMMAND',
    });
  }
  return text;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [String(key), String(value)]));
}

function generateAccountCode() {
  return `ACG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function accountNotFound() {
  return new AppError('Trading account was not found', {
    statusCode: 404,
    code: 'ACCOUNT_NOT_FOUND',
  });
}

module.exports = {
  AccountControlService,
  normalizeProvisionCommand,
  buildInitialState,
  assertProvisionReplay,
  normalizePolicyTransitionCommand,
  policyTransitionInvariantHash,
  serializePolicyTransition,
  V2_DISABLED_EXECUTION_LIMITS,
  ACG_FUNDED_V1_POLICY_VERSION,
  ACG_FUNDED_V2_POLICY_VERSION,
};
