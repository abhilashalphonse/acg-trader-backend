'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stagingOrigin,deriveStopFromPreview,verifyFixture,prepareEnvironment,
} = require('../../scripts/acceptance-global-markets-bootstrap');

test('bootstrap accepts only exact staging HTTPS origins, never production or embedded secrets', () => {
  assert.equal(stagingOrigin('https://discerning-presence-staging.up.railway.app','trader'),
    'https://discerning-presence-staging.up.railway.app');
  for(const invalid of [
    '', 'invalid', 'http://discerning-presence-staging.up.railway.app',
    'https://acg-trader-backend-production.up.railway.app',
    'https://staging.example.com@evil.test',
    'https://staging.example.test/other',
    'https://staging.example.test?run=1',
  ]) assert.throws(()=>stagingOrigin(invalid,'target'));
});

test('bootstrap derives tick-aligned RELIANCE stop only from a fresh execution preview', () => {
  const now=Date.now();
  const preview={
    previewVersion:'ACG_ORDER_PREVIEW_V1',symbol:'RELIANCE',
    accountCurrency:'USD',fillPrice:'1500.47',
    quote:{source:'accelpix',receivedAtMs:now-1500},
  };
  const result=deriveStopFromPreview(preview,'0.01','2',now);
  assert.equal(result.stopLoss,'1470.46');
  assert.equal(result.buyPrice,'1500.47');
  assert.ok(Number(result.stopLoss)<Number(result.buyPrice));
  assert.throws(()=>deriveStopFromPreview({...preview,quote:{...preview.quote,receivedAtMs:now-13000}},'0.01','2',now));
  assert.throws(()=>deriveStopFromPreview({...preview,quote:{...preview.quote,receivedAtMs:now+5000}},'0.01','2',now));
  assert.throws(()=>deriveStopFromPreview({...preview,symbol:'EURUSD'},'0.01','2',now));
  assert.throws(()=>deriveStopFromPreview(preview,'0.01','0',now));
  assert.throws(()=>deriveStopFromPreview(preview,'0.01','20',now));
  assert.throws(()=>deriveStopFromPreview({...preview,quote:{...preview.quote,source:'twelve-data'}},'0.01','2',now));
});

test('bootstrap limits account selection to active acceptance identity and matching customer', () => {
  const customer={primaryEmail:'staging-acceptance@example.test'};
  const challenge={
    accountId:'ACCEPTANCE-01',
    customerId:'c1',platform:'acg-trader',enabled:true,status:'ACTIVE',
    platformAccountId:'507f1f77bcf86cd799439011',
  };
  assert.equal(verifyFixture({customer,challenge,customerId:'c1',challengeId:'ACCEPTANCE-01'}),challenge.platformAccountId);
  assert.throws(()=>verifyFixture({customer:{primaryEmail:'real-customer@example.test'},challenge,customerId:'c1',challengeId:'ACCEPTANCE-01'}));
  assert.throws(()=>verifyFixture({customer,challenge,customerId:'different',challengeId:'ACCEPTANCE-01'}));
  assert.throws(()=>verifyFixture({customer,challenge:{...challenge,status:'CLOSED'},customerId:'c1',challengeId:'ACCEPTANCE-01'}));
});

test('bootstrap requires only staging admin session and optionally existing fixture ID', () => {
  const input={
    ACCEPTANCE_TARGET_ENVIRONMENT:'staging',
    ACCEPTANCE_RUN_ID:'ACC-STAGING-ONE',
    ACCEPTANCE_ADMIN_BEARER:'existing-admin-token',
  };
  const config=prepareEnvironment(input);
  assert.equal(config.runId,'ACC-STAGING-ONE');
  assert.match(config.trader,/staging/);
  assert.match(config.funded,/staging/);
  assert.throws(()=>prepareEnvironment({...input,ACCEPTANCE_TARGET_ENVIRONMENT:'production'}));
  assert.throws(()=>prepareEnvironment({...input,ACCEPTANCE_ADMIN_BEARER:''}));
  assert.throws(()=>prepareEnvironment({...input,ACCEPTANCE_TRADER_BASE_URL:'https://acg-trader-backend-production.up.railway.app'}));
  assert.throws(()=>prepareEnvironment({...input,ACCEPTANCE_TRADER_BASE_URL:'https://unknown-staging.example.net'}));
});
