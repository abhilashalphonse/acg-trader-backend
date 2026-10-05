'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

test('ecosystem Mongo/HTTP: Funded permission contract persists through Phase 1, Phase 2 and Master in Trader', {
  skip: !process.env.TEST_MONGODB_URI || !process.env.ACG_FUNDED_BACKEND_ROOT,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_lifecycle_test(?:\?|$)/.test(uri)) throw new Error('Dedicated local acg_lifecycle_test replica set required');
  const fundedRoot = path.resolve(process.env.ACG_FUNDED_BACKEND_ROOT);
  const load = file => import(pathToFileURL(path.join(fundedRoot, file)).href);
  const fundedRequire = createRequire(path.join(fundedRoot, 'package.json'));
  const fundedMongoose = fundedRequire('mongoose');
  const mongoose = require('mongoose');
  const express = require('express');
  const { default: Account } = await load('src/accounts/account.model.js');
  const { provisionTradingAccount } = await load('src/connectors/trading/account-provisioning.js');
  const { ACGTraderConnector } = await load('src/connectors/acg-trader/connector.js');
  const { AccountControlService } = require('../../src/modules/trading/account-control.service');
  const { createAccountControlRouter } = require('../../src/modules/trading/account-control.routes');
  const { TradingAccount } = require('../../src/modules/accounts/trading-account.model');
  const { ensureCriticalIndexes } = require('../../src/config/indexes');
  const { errorHandler } = require('../../src/shared/http/error-middleware');
  let server;
  try {
    await mongoose.connect(uri); await fundedMongoose.connect(uri);
    await ensureCriticalIndexes(); await Account.createIndexes();
    const tenantId = new mongoose.Types.ObjectId();
    const controls = new AccountControlService();
    const app = express(); app.use(express.json());
    app.use('/v1/internal/trading/accounts', createAccountControlRouter({ enabled: true, accountControlService: controls, commandQueue: controls.commandQueue }, {
      authenticateServiceKey: async ({ clientId, apiKey, requiredScope }) => {
        assert.equal(clientId, 'local-contract-client'); assert.equal(apiKey, 'local-contract-key'); assert.equal(requiredScope, 'accounts:write');
        return { tenantId, clientId };
      },
    }));
    app.use(errorHandler);
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const connector = new ACGTraderConnector({ baseUrl: `http://127.0.0.1:${server.address().port}`, clientId: 'local-contract-client', apiKey: 'local-contract-key' });
    let account = await Account.create({ accountId: 'ACG-lifecycle-contract', ownerExternalRef: 'local-purchaser', platform: 'acg-trader',
      challengeType: 'TWO_STEP', accountSize: 100000, initialDeposit: 100000, tradingPermissionsVersion: 7,
      commercialTerms: { newsTrading: false, weekendHolding: true },
      rules: { dailyDrawdown: 5, maxDrawdown: 10, minimumTradingDays: 0, phases: [{ phase: 1, profitTarget: 8 }, { phase: 2, profitTarget: 5 }] } });
    for (const [phase, accountType] of [[1, 'CHALLENGE'], [2, 'CHALLENGE'], [2, 'FUNDED']]) {
      account.currentPhase = phase;
      await provisionTradingAccount(account, { phase, accountType, connector });
      account = await Account.findById(account._id);
      const trader = await TradingAccount.findById(account.platformAccountId).lean();
      assert.equal(trader.accountType, accountType);
      assert.equal(trader.tradingPermissions.newsTrading, false);
      assert.equal(trader.tradingPermissions.weekendHolding, true);
      assert.equal(trader.tradingPermissionsVersion, 7);
      assert.equal(String(trader.tenantId), String(tenantId));
    }
    assert.equal(account.platformAccounts.length, 3);
    assert.equal(await TradingAccount.countDocuments({ tenantId }), 3);
    const replay = await provisionTradingAccount(account, { phase: 2, accountType: 'FUNDED', connector });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(await TradingAccount.countDocuments({ tenantId }), 3);
    await assert.rejects(connector.syncChallenge({ platformAccountId: account.platformAccountId,
      tradingPermissions: { newsTrading: true, weekendHolding: true }, tradingPermissionsVersion: 6 }), { code: 'TRADING_PERMISSION_VERSION_STALE' });
    assert.equal((await TradingAccount.findById(account.platformAccountId)).tradingPermissions.newsTrading, false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await Promise.all([mongoose.disconnect(), fundedMongoose.disconnect()]);
  }
});
