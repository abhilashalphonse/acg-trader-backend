'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountControlService, normalizeProvisionCommand, buildInitialState, assertProvisionReplay } = require('../../src/modules/trading/account-control.service');
const { dayKeyInTimezone } = require('../../src/modules/trading/risk-day-engine');
const { challengeSyncSchema } = require('../../src/modules/trading/account-control.routes');

const TENANT_ID = '64b000000000000000000001';

function query(value) {
  return {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value()).then(resolve, reject); },
  };
}

function createFakeModels() {
  const records = new Map();
  const ledgerRecords = [];
  const lifecycleRecords = [];
  let seq = 1;

  class FakeAccount {
    constructor(input) {
      Object.assign(this, input);
      this._id = input._id || String(seq++).padStart(24, '0');
      this.metadata = input.metadata instanceof Map ? input.metadata : new Map(Object.entries(input.metadata || {}));
    }
    async save() { records.set(String(this._id), this); return this; }
    static findOne(filter) {
      return query(() => [...records.values()].find(account => {
        if (filter._id && String(account._id) !== String(filter._id)) return false;
        if (filter.tenantId && String(account.tenantId) !== String(filter.tenantId)) return false;
        if (filter.externalRef && account.externalRef !== filter.externalRef) return false;
        return true;
      }) || null);
    }
    static findById(id) { return query(() => records.get(String(id)) || null); }
  }

  class FakeLedger {
    constructor(input) { Object.assign(this, input); }
    async save() { ledgerRecords.push(this); return this; }
  }

  class FakeLifecycle {
    constructor(input) { Object.assign(this, input); }
    async save() { lifecycleRecords.push(this); return this; }
  }

  const cancelled = [];
  const orderModel = {
    async updateMany(filter, update) {
      cancelled.push({ filter, update });
      return { modifiedCount: 2 };
    },
  };
  const positionModel = {
    find() { return { select() { return { async lean() { return []; } }; } }; },
    async countDocuments() { return 0; },
  };

  return {
    FakeAccount,
    FakeLedger,
    FakeLifecycle,
    orderModel,
    positionModel,
    records,
    ledgerRecords,
    lifecycleRecords,
    cancelled,
  };
}

function createService(models, overrides = {}) {
  return new AccountControlService({
    accountModel: models.FakeAccount,
    ledgerModel: models.FakeLedger,
    lifecycleModel: models.FakeLifecycle,
    orderModel: models.orderModel,
    positionModel: models.positionModel,
    runTransaction: async work => work(null),
    ...overrides,
  });
}

test('provisioning rejects commands without tenantId', () => {
  assert.throws(
    () => normalizeProvisionCommand({ externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000' }),
    error => error.code === 'INVALID_ACCOUNT_CONTROL_COMMAND' && /tenantId/.test(error.message),
  );
});

test('normalizeProvisionCommand builds a tenant-scoped challenge account safely', () => {
  const command = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'challenge-123',
    ownerExternalRef: 'user-9',
    initialBalance: '100000',
    leverage: 100,
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
      allowedSymbols: ['eur/usd', 'xauusd'],
    },
  });
  assert.equal(command.tenantId, TENANT_ID);
  assert.equal(command.accountType, 'CHALLENGE');
  assert.equal(command.initialBalance, '100000');
  assert.deepEqual(command.riskPolicy.allowedSymbols, ['EURUSD', 'XAUUSD']);
  assert.equal(buildInitialState('100000').freeMargin, '100000');
});

test('provision atomically creates opening ledger and lifecycle audit records', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const result = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-opening',
    ownerExternalRef: 'user-opening',
    initialBalance: '100000',
  });

  assert.equal(result.idempotentReplay, false);
  assert.equal(models.ledgerRecords.length, 1);
  assert.equal(models.ledgerRecords[0].type, 'DEPOSIT');
  assert.equal(models.ledgerRecords[0].balanceBefore, '0');
  assert.equal(models.ledgerRecords[0].balanceAfter, '100000');
  assert.equal(models.lifecycleRecords.length, 1);
  assert.equal(models.lifecycleRecords[0].type, 'PROVISIONED');
  assert.equal(models.lifecycleRecords[0].toStatus, 'ACTIVE');
});

test('provision is idempotent within a tenant without duplicating opening records', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const payload = { tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 };
  const first = await service.provision(payload);
  const second = await service.provision(payload);
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal(first.account.id, second.account.id);
  assert.equal(second.account.externalRef, 'challenge-123');
  assert.equal(second.account.tenantId, TENANT_ID);
  assert.equal(models.ledgerRecords.length, 1);
  assert.equal(models.lifecycleRecords.length, 1);
});

test('same externalRef can exist in different tenants', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const first = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-shared', ownerExternalRef: 'user-a', initialBalance: '10000' });
  const second = await service.provision({ tenantId: '64b000000000000000000002', externalRef: 'challenge-shared', ownerExternalRef: 'user-b', initialBalance: '10000' });
  assert.notEqual(first.account.id, second.account.id);
});

test('reusing an externalRef with different account parameters in the same tenant is rejected', async () => {
  const models = createFakeModels();
  const service = createService(models);
  await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 });
  await assert.rejects(
    () => service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '200000', leverage: 100 }),
    error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT',
  );
});

test('disable locks trading, cancels pending orders, and records lifecycle transition', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-456', ownerExternalRef: 'user-10', initialBalance: '50000' });
  const result = await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  assert.equal(result.account.status, 'DISABLED');
  assert.equal(result.account.tradingEnabled, false);
  assert.equal(result.cancelledPending, 2);
  assert.equal(models.cancelled.length, 1);
  assert.equal(models.lifecycleRecords.at(-1).type, 'DISABLED');
  assert.equal(models.lifecycleRecords.at(-1).reason, 'ADMIN_LOCK');
});

test('replaying the same lifecycle state is idempotent and does not duplicate lifecycle audit', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-idempotent-disable', ownerExternalRef: 'user-10', initialBalance: '50000' });
  await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  const afterFirst = models.lifecycleRecords.length;
  const second = await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  assert.equal(second.changed, false);
  assert.equal(models.lifecycleRecords.length, afterFirst);
});

test('breached and disabled accounts cannot be resumed', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-789', ownerExternalRef: 'user-11', initialBalance: '25000' });
  await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  await assert.rejects(() => service.resume(created.account.id), error => error.code === 'ACCOUNT_RESUME_FORBIDDEN');
});


test('provisioning initializes risk day in the configured account timezone', () => {
  const before = new Date();
  const command = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'challenge-timezone',
    ownerExternalRef: 'user-timezone',
    initialBalance: '100000',
    riskTimezone: 'America/New_York',
  });
  const after = new Date();

  const validKeys = new Set([
    dayKeyInTimezone(before, 'America/New_York'),
    dayKeyInTimezone(after, 'America/New_York'),
  ]);
  assert.equal(command.riskTimezone, 'America/New_York');
  assert.ok(validKeys.has(command.riskDayKey));
});


test('partial challenge policy sync preserves omitted optional limits', () => {
  const parsed = challengeSyncSchema.parse({
    riskPolicy: {
      dailyLoss: { limit: '3000' },
    },
  });

  assert.equal(parsed.riskPolicy.dailyLoss.limit, '3000');
  assert.equal(parsed.riskPolicy.maxTotalVolume, undefined);
  assert.equal(parsed.riskPolicy.maxOpenPositions, undefined);
  assert.equal(parsed.riskPolicy.allowedSymbols, undefined);
});

test('challenge policy sync can explicitly clear nullable total-volume limit', () => {
  const parsed = challengeSyncSchema.parse({
    riskPolicy: {
      maxTotalVolume: null,
    },
  });
  assert.equal(parsed.riskPolicy.maxTotalVolume, null);
});


test('challenge policy sync accepts authoritative execution risk controls', () => {
  const parsed = challengeSyncSchema.parse({
    riskPolicy: {
      maxRiskPerTradePercent: '1',
      maxAggregateRiskPercent: '2',
      maxMarginUsagePercent: '50',
      maxSingleOrderMarginPercentOfFree: '20',
      maxSymbolMarginPercentOfPermitted: '30',
      maxPositionVolume: '5',
      maxSymbolVolume: '10',
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 3,
      maxPendingOrders: 10,
      maxPendingOrdersPerSymbol: 3,
    },
  });

  assert.equal(parsed.riskPolicy.maxRiskPerTradePercent, '1');
  assert.equal(parsed.riskPolicy.maxAggregateRiskPercent, '2');
  assert.equal(parsed.riskPolicy.maxMarginUsagePercent, '50');
  assert.equal(parsed.riskPolicy.maxSingleOrderMarginPercentOfFree, '20');
  assert.equal(parsed.riskPolicy.maxSymbolMarginPercentOfPermitted, '30');
  assert.equal(parsed.riskPolicy.maxPositionVolume, '5');
  assert.equal(parsed.riskPolicy.maxSymbolVolume, '10');
  assert.equal(parsed.riskPolicy.maxOpenPositions, 10);
  assert.equal(parsed.riskPolicy.maxPositionsPerSymbol, 3);
  assert.equal(parsed.riskPolicy.maxPendingOrders, 10);
  assert.equal(parsed.riskPolicy.maxPendingOrdersPerSymbol, 3);
});


test('flatten pauses the account, cancels pending orders, and remains reversible', async () => {
  const models = createFakeModels();
  const service = createService(models, {
    marketOrderService: { async closeMarketPosition() { throw new Error('No positions expected'); } },
  });
  const created = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-final-check',
    ownerExternalRef: 'user-final-check',
    initialBalance: '100000',
  });

  const flattened = await service.flatten(created.account.id, { reason: 'PHASE_COMPLETION_CHECK' });
  assert.equal(flattened.account.status, 'PAUSED');
  assert.equal(flattened.account.tradingEnabled, false);
  assert.equal(models.cancelled.length, 1);
  assert.equal(models.lifecycleRecords.at(-1).type, 'PAUSED');

  const resumed = await service.resume(created.account.id, { reason: 'PHASE_RECHECK_FAILED' });
  assert.equal(resumed.account.status, 'ACTIVE');
  assert.equal(resumed.account.tradingEnabled, true);
  assert.equal(models.lifecycleRecords.at(-1).type, 'RESUMED');
});


test('staged provisioning is non-tradable and hidden from federation until activation', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-staged',
    ownerExternalRef: 'user-staged',
    initialBalance: '100000',
    activate: false,
  });
  assert.equal(created.account.status, 'PAUSED');
  assert.equal(created.account.tradingEnabled, false);
  assert.equal(created.account.federationEnabled, false);

  await assert.rejects(
    () => service.resume(created.account.id, { reason: 'WRONG_ACTIVATION_PATH' }),
    error => error.code === 'ACCOUNT_ACTIVATION_REQUIRED',
  );

  const activated = await service.activate(created.account.id, { reason: 'LIFECYCLE_COMMITTED' });
  assert.equal(activated.account.status, 'ACTIVE');
  assert.equal(activated.account.tradingEnabled, true);
  assert.equal(activated.account.federationEnabled, true);
});

test('breached account remains breached when pause, stage, disable, or flatten is requested', async () => {
  const models = createFakeModels();
  models.positionModel.find = () => ({ select() { return { async lean() { return []; } }; } });
  const service = createService(models, {
    marketOrderService: { async closeMarketPosition() { throw new Error('No positions expected'); } },
  });
  const created = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-terminal-breach',
    ownerExternalRef: 'user-terminal',
    initialBalance: '100000',
  });
  await service.breach(created.account.id, { reason: 'MAX_LOSS', action: 'LOCK_ONLY' });

  for (const operation of [
    () => service.pause(created.account.id, { reason: 'PAUSE_AFTER_BREACH' }),
    () => service.stage(created.account.id, { reason: 'STAGE_AFTER_BREACH' }),
    () => service.disable(created.account.id, { reason: 'DISABLE_AFTER_BREACH' }),
    () => service.flatten(created.account.id, { reason: 'FLATTEN_AFTER_BREACH' }),
  ]) {
    const result = await operation();
    assert.equal(result.account.status, 'BREACHED');
    assert.equal(result.account.tradingEnabled, false);
  }

  await assert.rejects(
    () => service.resume(created.account.id, { reason: 'RESUME_AFTER_BREACH' }),
    error => error.code === 'ACCOUNT_RESUME_FORBIDDEN',
  );
});

test('provision replay rejects immutable risk-policy contract drift', () => {
  const first = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-risk',
    ownerExternalRef: 'user-risk',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
    },
    metadata: { fundedAccountId: 'F-1', phase: 1 },
  });
  const existing = {
    tenantId: TENANT_ID,
    ownerExternalRef: 'user-risk',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    state: { initialBalance: '100000' },
    riskTimezone: 'UTC',
    riskPolicy: first.riskPolicy,
    metadata: first.metadata,
    provisioningContractHash: first.provisioningContractHash,
  };

  const changed = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-risk',
    ownerExternalRef: 'user-risk',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '5000' },
      maxLoss: { limit: '10000' },
      profitTarget: '10000',
    },
    metadata: { fundedAccountId: 'F-1', phase: 1 },
  });

  assert.throws(
    () => assertProvisionReplay(existing, changed),
    error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT'
      && error.details.mismatches.includes('provisioningContract'),
  );
});

test('Funded provision replay accepts the repaired official policy without rewriting the immutable legacy hash', () => {
  const legacy = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-funded-repair',
    ownerExternalRef: 'user-funded-repair',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
      maxRiskPerTradePercent: null,
      maxAggregateRiskPercent: null,
      maxMarginUsagePercent: null,
      maxSingleOrderMarginPercentOfFree: null,
      maxSymbolMarginPercentOfPermitted: null,
      maxOpenPositions: null,
      maxPositionsPerSymbol: null,
      maxPendingOrders: null,
      maxPendingOrdersPerSymbol: null,
    },
    metadata: { fundedAccountId: 'F-REPAIR', phase: 1, challengeType: 'ONE_STEP', accountType: 'CHALLENGE' },
  });

  const repaired = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-funded-repair',
    ownerExternalRef: 'user-funded-repair',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
      maxRiskPerTradePercent: 1,
      maxAggregateRiskPercent: 2,
      maxMarginUsagePercent: 50,
      maxSingleOrderMarginPercentOfFree: 20,
      maxSymbolMarginPercentOfPermitted: 30,
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 3,
      maxPendingOrders: 10,
      maxPendingOrdersPerSymbol: 3,
    },
    metadata: { fundedAccountId: 'F-REPAIR', phase: 1, challengeType: 'ONE_STEP', accountType: 'CHALLENGE' },
  });

  const existing = {
    tenantId: TENANT_ID,
    ownerExternalRef: 'user-funded-repair',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    state: { initialBalance: '100000' },
    riskTimezone: 'UTC',
    riskPolicy: repaired.riskPolicy,
    metadata: repaired.metadata,
    provisioningContractHash: legacy.provisioningContractHash,
  };

  assert.notEqual(existing.provisioningContractHash, repaired.provisioningContractHash);
  assert.equal(assertProvisionReplay(existing, repaired), existing);
});

test('stale provisioning hash remains strict when a Funded account does not match the incoming repaired policy', () => {
  const legacy = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-funded-strict',
    ownerExternalRef: 'user-funded-strict',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
    },
    metadata: { fundedAccountId: 'F-STRICT', phase: 1 },
  });
  const incoming = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'contract-funded-strict',
    ownerExternalRef: 'user-funded-strict',
    initialBalance: '100000',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
      maxRiskPerTradePercent: 1,
      maxAggregateRiskPercent: 2,
      maxMarginUsagePercent: 50,
      maxSingleOrderMarginPercentOfFree: 20,
      maxSymbolMarginPercentOfPermitted: 30,
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 3,
      maxPendingOrders: 10,
      maxPendingOrdersPerSymbol: 3,
    },
    metadata: { fundedAccountId: 'F-STRICT', phase: 1 },
  });

  const existing = {
    tenantId: TENANT_ID,
    ownerExternalRef: 'user-funded-strict',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    state: { initialBalance: '100000' },
    riskTimezone: 'UTC',
    riskPolicy: legacy.riskPolicy,
    metadata: legacy.metadata,
    provisioningContractHash: legacy.provisioningContractHash,
  };

  assert.throws(
    () => assertProvisionReplay(existing, incoming),
    error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT'
      && error.details.mismatches.includes('provisioningContract'),
  );
});



test('breach liquidation retries use stable position idempotency keys and only retry remaining open positions', async () => {
  const models = createFakeModels();
  let remaining = ['position-a', 'position-b'];
  models.positionModel.find = () => ({
    select() {
      return {
        async lean() {
          return remaining.map(_id => ({ _id }));
        },
      };
    },
  });

  const calls = [];
  let failB = true;
  const service = createService(models, {
    marketOrderService: {
      async closeMarketPosition(command) {
        calls.push({ ...command });
        if (command.positionId === 'position-b' && failB) {
          failB = false;
          throw Object.assign(new Error('temporary close failure'), { code: 'TEMPORARY_CLOSE_FAILURE' });
        }
        remaining = remaining.filter(id => id !== command.positionId);
        return { operation: 'CLOSE', idempotentReplay: calls.filter(item => item.clientOrderId === command.clientOrderId).length > 1 };
      },
    },
  });

  const created = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-liquidation-retry',
    ownerExternalRef: 'user-liquidation-retry',
    initialBalance: '100000',
  });

  await assert.rejects(
    () => service.breach(created.account.id, { reason: 'DAILY_LOSS_LIMIT_REACHED' }),
    error => error.code === 'ACCOUNT_LIQUIDATION_FAILED',
  );

  assert.deepEqual(
    calls.map(item => item.clientOrderId),
    ['control-liquidation:position-a', 'control-liquidation:position-b'],
  );
  assert.deepEqual(remaining, ['position-b']);

  await service.breach(created.account.id, { reason: 'DAILY_LOSS_LIMIT_REACHED' });

  assert.deepEqual(
    calls.map(item => item.clientOrderId),
    [
      'control-liquidation:position-a',
      'control-liquidation:position-b',
      'control-liquidation:position-b',
    ],
  );
  assert.deepEqual(remaining, []);
});
