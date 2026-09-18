'use strict';

const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');
const { TradingAccount } = require('./trading-account.model');
const { AccountLedger } = require('../trading/account-ledger.model');
const { AccountCommandQueue } = require('../trading/account-command-queue');
const { runMongoTransaction } = require('../trading/market-order.service');
const { serializeAccount } = require('../trading/trading.serializer');

const MUTATION_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT']);

class AccountLedgerService {
  constructor({
    accountModel = TradingAccount,
    ledgerModel = AccountLedger,
    commandQueue = new AccountCommandQueue(),
    runTransaction = runMongoTransaction,
    eventBus = null,
    logger = null,
  } = {}) {
    Object.assign(this, {
      accountModel,
      ledgerModel,
      commandQueue,
      runTransaction,
      eventBus,
      logger,
    });
  }

  async list(accountId, { tenantId, limit = 100, before = null } = {}) {
    const scope = { accountId: String(accountId) };
    if (tenantId) scope.tenantId = tenantId;
    if (before) scope.createdAt = mongoose.trusted({ $lt: new Date(before) });

    const entries = await this.ledgerModel.find(scope)
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
      .lean();

    return entries.map(serializeLedgerEntry);
  }

  async mutate(accountId, command) {
    const normalized = normalizeMutationCommand(command);

    return this.commandQueue.run(String(accountId), async () => {
      const existing = await this.ledgerModel.findOne({
        tenantId: normalized.tenantId,
        accountId: String(accountId),
        idempotencyKey: normalized.idempotencyKey,
      });

      if (existing) {
        assertLedgerReplay(existing, normalized);
        const account = await this.accountModel.findOne({ _id: String(accountId), tenantId: normalized.tenantId });
        if (!account) throw accountNotFound();
        return { account: serializeAccountState(account), ledger: serializeLedgerEntry(existing), idempotentReplay: true };
      }

      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findOne({ _id: String(accountId), tenantId: normalized.tenantId }).session(session);
        if (!account) throw accountNotFound();
        if (account.status === 'CLOSED') {
          throw new AppError('Closed trading account cannot receive balance mutations', {
            statusCode: 409,
            code: 'ACCOUNT_CLOSED',
          });
        }

        const balanceBefore = normalizeDecimal(account.state.balance);
        const signedAmount = signedMutationAmount(normalized.type, normalized.amount);
        const balanceAfter = addDecimal(balanceBefore, signedAmount);

        if (compareDecimal(balanceAfter, '0') < 0) {
          throw new AppError('Balance mutation would make the account balance negative', {
            statusCode: 409,
            code: 'INSUFFICIENT_ACCOUNT_BALANCE',
          });
        }

        const equityAfter = addDecimal(account.state.equity, signedAmount);
        const freeMarginAfter = subtractDecimal(equityAfter, account.state.usedMargin);
        if (normalized.type === 'WITHDRAWAL' && compareDecimal(freeMarginAfter, '0') < 0) {
          throw new AppError('Withdrawal exceeds available free margin', {
            statusCode: 409,
            code: 'INSUFFICIENT_FREE_MARGIN',
          });
        }

        account.state.balance = balanceAfter;
        account.state.equity = equityAfter;
        account.state.freeMargin = freeMarginAfter;

        const ledger = new this.ledgerModel({
          tenantId: account.tenantId,
          accountId: account._id,
          type: normalized.type,
          amount: signedAmount,
          balanceBefore,
          balanceAfter,
          currency: account.currency,
          referenceType: 'SYSTEM',
          referenceId: normalized.referenceId,
          idempotencyKey: normalized.idempotencyKey,
          reason: normalized.reason,
          metadata: normalized.metadata,
        });

        await ledger.save({ session });
        await account.save({ session });
        return { account, ledger };
      });

      const response = {
        account: serializeAccountState(result.account),
        ledger: serializeLedgerEntry(result.ledger),
        idempotentReplay: false,
      };
      this.#emit('trading.account.updated', serializeAccount(result.account));
      this.#emit('trading.account.balance.updated', response);
      return response;
    });
  }

  #emit(name, payload) {
    try {
      this.eventBus?.emit(name, payload);
    } catch (error) {
      this.logger?.error({ err: error, event: name }, 'Account ledger event listener failed');
    }
  }
}

function normalizeMutationCommand(command) {
  const tenantId = requiredString(command?.tenantId, 'tenantId');
  const type = String(command?.type || '').trim().toUpperCase();
  if (!MUTATION_TYPES.has(type)) {
    throw new AppError('Invalid account ledger mutation type', {
      statusCode: 400,
      code: 'INVALID_LEDGER_MUTATION_TYPE',
    });
  }

  const amount = normalizeDecimal(command?.amount ?? '0');
  if (compareDecimal(amount, '0') <= 0) {
    throw new AppError('amount must be greater than zero', {
      statusCode: 400,
      code: 'INVALID_LEDGER_AMOUNT',
    });
  }

  return {
    tenantId,
    type,
    amount,
    idempotencyKey: requiredString(command?.idempotencyKey, 'idempotencyKey'),
    referenceId: requiredString(command?.referenceId, 'referenceId'),
    reason: requiredString(command?.reason, 'reason'),
    metadata: normalizeMetadata(command?.metadata),
  };
}

function signedMutationAmount(type, amount) {
  return type === 'WITHDRAWAL' ? subtractDecimal('0', amount) : amount;
}

function assertLedgerReplay(entry, input) {
  const mismatches = [];
  if (String(entry.type) !== input.type) mismatches.push('type');
  if (normalizeDecimal(entry.amount) !== signedMutationAmount(input.type, input.amount)) mismatches.push('amount');
  if (String(entry.referenceId) !== input.referenceId) mismatches.push('referenceId');
  if (mismatches.length) {
    throw new AppError('idempotencyKey was already used for a different balance mutation', {
      statusCode: 409,
      code: 'LEDGER_IDEMPOTENCY_CONFLICT',
      details: { mismatches },
    });
  }
}

function serializeLedgerEntry(entry) {
  const metadata = entry.metadata instanceof Map ? Object.fromEntries(entry.metadata) : (entry.metadata || {});
  return {
    id: String(entry._id),
    entryId: entry.entryId,
    tenantId: String(entry.tenantId),
    accountId: String(entry.accountId),
    type: entry.type,
    amount: normalizeDecimal(entry.amount),
    balanceBefore: normalizeDecimal(entry.balanceBefore),
    balanceAfter: normalizeDecimal(entry.balanceAfter),
    currency: entry.currency,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    idempotencyKey: entry.idempotencyKey || null,
    reason: entry.reason || null,
    metadata,
    createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
  };
}

function serializeAccountState(account) {
  return {
    id: String(account._id),
    tenantId: String(account.tenantId),
    accountCode: account.accountCode,
    externalRef: account.externalRef,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    currency: account.currency,
    balance: normalizeDecimal(account.state.balance),
    equity: normalizeDecimal(account.state.equity),
    floatingPnl: normalizeDecimal(account.state.floatingPnl),
    usedMargin: normalizeDecimal(account.state.usedMargin),
    freeMargin: normalizeDecimal(account.state.freeMargin),
  };
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new AppError(`${field} is required`, {
      statusCode: 400,
      code: 'INVALID_LEDGER_COMMAND',
    });
  }
  return text;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [String(key), String(value)]));
}

function accountNotFound() {
  return new AppError('Trading account was not found', {
    statusCode: 404,
    code: 'ACCOUNT_NOT_FOUND',
  });
}

module.exports = {
  AccountLedgerService,
  normalizeMutationCommand,
  signedMutationAmount,
  assertLedgerReplay,
  serializeLedgerEntry,
};
