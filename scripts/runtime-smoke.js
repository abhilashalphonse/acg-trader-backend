'use strict';

process.env.MARKET_GATEWAY_ENABLED = 'false';
process.env.PLATFORM_EVENTS_ENABLED = 'false';

const { connectDatabase, disconnectDatabase, verifyTransactionSupport } = require('../src/config/database');
const { ensureCriticalIndexes } = require('../src/config/indexes');
const { createMarketRuntime } = require('../src/modules/market-data/market.runtime');
const { createTradingRuntime } = require('../src/modules/trading/trading.runtime');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { runMongoTransaction } = require('../src/modules/trading/market-order.service');
const mongoose = require('mongoose');

async function run() {
  await connectDatabase();
  await verifyTransactionSupport();
  await ensureCriticalIndexes();
  await verifyConcurrentFinancialTransactions();

  const marketRuntime = createMarketRuntime();
  const tradingRuntime = createTradingRuntime({ marketRuntime });

  await tradingRuntime.start();
  const health = tradingRuntime.health();
  if (!health.started) throw new Error('Trading runtime did not start');

  await tradingRuntime.stop();
  await marketRuntime.stop();
  await disconnectDatabase();
  process.stdout.write('Runtime smoke test passed\n');
}

async function verifyConcurrentFinancialTransactions() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const account = await TradingAccount.create({
    tenantId: new mongoose.Types.ObjectId(),
    accountCode: `SMOKE-${suffix}`.slice(0, 48),
    ownerExternalRef: `runtime-smoke-${suffix}`,
    externalRef: `runtime-smoke-${suffix}`,
    accountType: 'DEMO',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    federationEnabled: true,
    financialRevision: 0,
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    state: {
      initialBalance: '100',
      balance: '100',
      equity: '100',
      floatingPnl: '0',
      realizedPnlToday: '0',
      usedMargin: '0',
      freeMargin: '100',
      dailyStartEquity: '100',
    },
    riskPolicy: {},
  });

  const spend = async () => runMongoTransaction(async session => {
    const current = await TradingAccount.findById(account._id).session(session);
    const free = Number(current.state.freeMargin.toString());
    if (free < 80) {
      const error = new Error('Insufficient test margin after concurrent retry');
      error.code = 'TEST_INSUFFICIENT_MARGIN';
      throw error;
    }
    current.state.usedMargin = String(Number(current.state.usedMargin.toString()) + 80);
    current.state.freeMargin = String(free - 80);
    current.financialRevision = Number(current.financialRevision || 0) + 1;
    await current.save({ session });
    return Number(current.financialRevision);
  });

  try {
    const outcomes = await Promise.allSettled([spend(), spend()]);
    const fulfilled = outcomes.filter(item => item.status === 'fulfilled');
    const rejected = outcomes.filter(item => item.status === 'rejected');
    if (fulfilled.length !== 1 || rejected.length !== 1) {
      throw new Error(`Concurrent transaction fence failed: fulfilled=${fulfilled.length}, rejected=${rejected.length}`);
    }
    if (rejected[0].reason?.code !== 'TEST_INSUFFICIENT_MARGIN') throw rejected[0].reason;

    const final = await TradingAccount.findById(account._id).lean();
    if (Number(final.financialRevision || 0) !== 1) throw new Error('Concurrent transaction revision advanced more than once');
    if (Number(final.state.usedMargin.toString()) !== 80 || Number(final.state.freeMargin.toString()) !== 20) {
      throw new Error('Concurrent transaction committed inconsistent margin state');
    }
  } finally {
    await TradingAccount.deleteOne({ _id: account._id });
  }
}

run().catch(async error => {
  console.error(error);
  try { await disconnectDatabase(); } catch {}
  process.exit(1);
});
