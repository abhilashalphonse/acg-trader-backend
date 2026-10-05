'use strict';
// Local integration fixture only. Never accepts a remote or general-purpose database.
const uri = process.env.TEST_MONGODB_URI;
const capacityMode = process.env.ACG_WEEKEND_CAPACITY_TEST === '1';
const databasePattern = capacityMode ? /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_socket_test(?:\?|$)/
  : /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_policy_test(?:\?|$)/;
if (!process.send || process.env.ACG_WEEKEND_WORKER_TEST !== '1'
  || !databasePattern.test(uri || '')
  || process.env.MONGODB_URI !== uri) throw new Error('Weekend worker fixture requires IPC and the dedicated local test database');

const mongoose = require('mongoose');
const EventEmitter = require('node:events');
const { MarketOrderService } = require('../../src/modules/trading/market-order.service');
const { PendingOrderService } = require('../../src/modules/trading/pending-order.service');
const { TradingPermissionPolicyService } = require('../../src/modules/trading/trading-permission-policy.service');
const { PolicyControlService } = require('../../src/modules/trading/policy-control.service');
const { ValuationEngine } = require('../../src/modules/trading/valuation-engine');
const { WeekendActionService } = require('../../src/modules/trading/weekend-action.service');
const { WeekendAccountAction } = require('../../src/modules/trading/weekend-action.model');
const { AccountStateSynchronizer } = require('../../src/modules/trading/account-state-synchronizer');

async function main() {
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(uri);
  const logger = { info() {}, warn() {}, error() {} };
  const eventBus = new EventEmitter();
  const quoteStore = { get: () => ({ symbol: 'EURUSD', bid: 1.101, ask: 1.1012,
    receivedAtMs: Date.now(), isStale: false, sequence: 1, source: 'test-process' }) };
  const policyService = new TradingPermissionPolicyService({ logger, controlService: new PolicyControlService(),
    config: { weekendEnforcementEnabled: true, weekendRolloutPercent: 100, newsEnforcementEnabled: false, shadowEnabled: false } });
  const valuationEngine = new ValuationEngine({ eventBus, quoteStore, logger });
  await valuationEngine.start();
  const dependencies = { eventBus, quoteStore, logger, valuationEngine, tradingPermissionPolicyService: policyService };
  const marketOrderService = new MarketOrderService(dependencies);
  const pendingOrderService = new PendingOrderService(dependencies);
  // A short lease keeps this failure-injection test quick. Runtime's default is 30 seconds.
  const worker = new WeekendActionService({ policyService, marketOrderService, pendingOrderService, logger,
    concurrency: capacityMode ? 4 : 1, jobsPerWorker: capacityMode ? 32 : 1, leaseMs: capacityMode ? 30000 : 5000 });
  marketOrderService.weekendActionService = worker;
  pendingOrderService.weekendActionService = worker;
  const synchronizer = capacityMode ? new AccountStateSynchronizer({ eventBus, valuationEngine, logger }) : null;
  await synchronizer?.start();
  if (process.env.ACG_WEEKEND_PAUSE_AFTER_CLOSE === '1') {
    const close = marketOrderService.closeMarketPosition.bind(marketOrderService);
    marketOrderService.closeMarketPosition = async (...args) => {
      const result = await close(...args);
      process.send({ event: 'closeCommitted', pid: process.pid });
      await new Promise(() => {}); // Parent terminates this process before verification.
      return result;
    };
  }
  try {
    const deadline = Date.now() + (capacityMode ? 120000 : 20000);
    let firstPoll = true;
    while (Date.now() < deadline) {
      await worker.runDue();
      if (capacityMode) {
        const confirmed = await WeekendAccountAction.countDocuments({ state: 'CONFIRMED' });
        if (confirmed === 500) { process.send({ event: 'confirmed', confirmed, pid: process.pid }); return; }
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      const job = await WeekendAccountAction.findOne({ accountId: process.env.ACG_WEEKEND_TEST_ACCOUNT }).lean();
      if (firstPoll) {
        process.send({ event: 'firstPoll', state: job?.state, generation: job?.generation });
        firstPoll = false;
      }
      if (job?.state === 'CONFIRMED') {
        process.send({ event: 'confirmed', generation: job.generation, pid: process.pid });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Worker did not confirm before the test deadline');
  } finally {
    await worker.stop();
    await synchronizer?.stop();
    await valuationEngine.stop();
    await mongoose.disconnect();
    process.disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exit(1); });
