'use strict';

// Reuse the existing Funded lifecycle acceptance identity and federation.
// Credentials remain in process memory; neither token nor ticket is logged.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_TRADER = 'https://discerning-presence-staging.up.railway.app';
const DEFAULT_FUNDED = 'https://zealous-benevolence-staging.up.railway.app';
const MUTATION_ACK = 'GLOBAL_MARKETS_RELIANCE_STAGING_ONLY';

function stagingOrigin(value, name) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(name + ' must be a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !url.hostname.includes('staging') || url.hostname.includes('production')) {
    throw new Error(name + ' must be a staging-only HTTPS origin');
  }
  return url.origin;
}

function required(value, name) {
  if (!String(value || '').trim()) throw new Error(name + ' is required');
  return String(value).trim();
}

function deriveStopFromPreview(preview, tickSize, distancePercent = '2', nowMs = Date.now()) {
  const fillPrice = Number(preview?.fillPrice);
  const tick = Number(tickSize);
  const distance = Number(distancePercent);
  const receivedAtMs = Number(preview?.quote?.receivedAtMs);
  if (preview?.previewVersion !== 'ACG_ORDER_PREVIEW_V1' ||
      preview.symbol !== 'RELIANCE' || preview.accountCurrency !== 'USD' ||
      !Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(tick) || tick <= 0 ||
      !Number.isFinite(distance) || distance <= 0 || distance >= 20 ||
      !Number.isFinite(receivedAtMs) || receivedAtMs <= 0 ||
      receivedAtMs > nowMs + 2000 || nowMs - receivedAtMs > 12000 ||
      !String(preview?.quote?.source || '').toLowerCase().startsWith('accelpix')) {
    throw new Error('RELIANCE quote is missing, stale, or not an authoritative USD-account preview');
  }
  // The stop is derived from the actual executable BUY preview, never from an invented ticker price.
  const steps = Math.floor((fillPrice * (1 - distance / 100)) / tick + 1e-8);
  const stop = steps * tick;
  if (steps < 1 || !(stop < fillPrice)) throw new Error('Cannot derive a valid tick-aligned RELIANCE stop');
  const decimals = String(tickSize).split('.')[1]?.length || 0;
  return {
    stopLoss: stop.toFixed(decimals),
    buyPrice: String(preview.fillPrice),
    quoteSource: preview.quote.source,
    quoteReceivedAtMs: receivedAtMs,
    distancePercent: String(distance),
  };
}

function verifyFixture({customer, challenge, customerId, challengeId}) {
  if (!customer?.primaryEmail || !/acceptance/i.test(customer.primaryEmail)) {
    throw new Error('Refusing a non-acceptance Funded customer identity');
  }
  if (!challenge || String(challenge.accountId) !== String(challengeId) ||
      String(challenge.customerId) !== String(customerId) ||
      String(challenge.platform).toLowerCase() !== 'acg-trader' ||
      String(challenge.status).toUpperCase() !== 'ACTIVE' ||
      challenge.enabled !== true ||
      !/^[0-9a-f]{24}$/i.test(String(challenge.platformAccountId || ''))) {
    throw new Error('Selected Funded fixture is not the active acceptance customer Trader account');
  }
  return String(challenge.platformAccountId);
}

async function httpJson(origin, pathname, {bearer, method='GET', body, timeoutMs=12000}={}) {
  const headers = { accept: 'application/json' };
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + pathname, {
    method, headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(method + ' ' + pathname.split('?')[0] + ' failed: HTTP ' + response.status);
  const data = await response.json();
  return data;
}

function prepareEnvironment(input = process.env) {
  const trader = stagingOrigin(input.ACCEPTANCE_TRADER_BASE_URL || DEFAULT_TRADER, 'ACCEPTANCE_TRADER_BASE_URL');
  const funded = stagingOrigin(input.ACCEPTANCE_FUNDED_BASE_URL || DEFAULT_FUNDED, 'ACCEPTANCE_FUNDED_BASE_URL');
  if (trader !== DEFAULT_TRADER || funded !== DEFAULT_FUNDED) {
    throw new Error('Unexpected staging host');
  }
  if (String(input.ACCEPTANCE_TARGET_ENVIRONMENT || '') !== 'staging') {
    throw new Error('ACCEPTANCE_TARGET_ENVIRONMENT=staging is required');
  }
  return {
    trader, funded,
    runId: String(input.ACCEPTANCE_RUN_ID || '').trim(),
    adminBearer: required(input.ACCEPTANCE_ADMIN_BEARER, 'ACCEPTANCE_ADMIN_BEARER'),
  };
}

async function bootstrap(input=process.env, {execute=false, createFixture=false}={}) {
  const config=prepareEnvironment(input);
  if (execute && input.ACCEPTANCE_ALLOW_MUTATIONS !== MUTATION_ACK) {
    throw new Error('Explicit Stage 6 staging mutation acknowledgement required');
  }
  const [fundedHealth, traderReady] = await Promise.all([
    httpJson(config.funded, '/health'),
    httpJson(config.trader, '/health/ready'),
  ]);
  if (traderReady?.status === 'not_ready' || traderReady?.ready === false) {
    throw new Error('Trader staging  if (createFixture) {
    if (execute) throw new Error('Fixture creation and trading must be separate commands');
    const result=await httpJson(config.funded, '/api/admin/launch-readiness/fixtures', {
      bearer:config.adminBearer,method:'POST',body:{symbol:'RELIANCE',volume:'0.001'},
      timeoutMs:90000,
    });
    const run=result?.data;
    if (run?.status !== 'READY' || !run?.runId ||
        !/^[0-9a-f]{24}$/i.test(String(run?.fixture?.challengeAPlatformAccountId||''))) {
      throw new Error('Staging acceptance fixture creation did not return a ready funded account');
    }
    return {
      status:'FIXTURE_CREATED',stage:'GLOBAL-MARKETS-M1-STAGE6',environment:'STAGING',
      runId:run.runId,customerId:run.fixture.customerId,
      challengeId:run.fixture.challengeAId,accountId:run.fixture.challengeAPlatformAccountId,
      next:'Set ACCEPTANCE_RUN_ID to runId, then run bootstrap preflight (without --execute).',
    };
  }
  if (!config.runId) {
    throw new Error('ACCEPTANCE_RUN_ID is required. Run bootstrap -- --create-fixture first.');
  }
  const result=await httpJson(config.funded, '/api/admin/launch-readiness/'+encodeURIComponent(config.runId), {
    bearer:config.adminBearer,
  });
  const run=result?.data;
  const fixture=run?.fixture||{};
  if (run?.status !== 'READY' || run?.symbol !== 'RELIANCE' ||
      !/^acceptance\+.*@acgfunded\.test$/i.test(String(fixture.email||'')) ||
      !/^ACG-ACC-/.test(String(fixture.challengeAId||'')) ||
      !/^[0-9a-f]{24}$/i.test(String(fixture.challengeAPlatformAccountId||''))) {
    throw new Error('Stage 6 requires a fresh READY RELIANCE fixture created by staging admin');
  }
  const accountId=String(fixture.challengeAPlatformAccountId);
  const access=await httpJson(config.funded,
    '/api/admin/launch-readiness/'+encodeURIComponent(config.runId)+'/stage6-ticket', {
      bearer:config.adminBearer,method:'POST',
      body:{confirmation:'RELIANCE-STAGING-ONLY'},
    });
  const ticket=required(access?.data?.ticket,'single-use Stage 6 federation ticket');
  if (String(access?.data?.accountId||'') !== accountId ||
      String(access?.data?.challengeId||'') !== String(fixture.challengeAId)) {
    throw new Error('Staging federation ticket account did not match the dedicated acceptance fixture');
  }
t return a ticket');
  const exchange=await httpJson(config.trader, '/v1/auth/federated/exchange', {method:'POST',body:{ticket}});
  const token=required(exchange.accessToken,'federated Trader access token');
  const granted=await httpJson(config.trader,'/v1/auth/accounts',{bearer:token});
  const grantedIds=(granted.accounts||[]).map(row=>String(row?.id||row?._id||row?.accountId||''));
  if (!grantedIds.includes(accountId)) throw new Error('Federated Trader token does not grant the selected test account');
  const valuation=await httpJson(config.trader, '/v1/trading/accounts/'+accountId+'/valuation', {bearer:token});
  if (valuation.complete !== true || Number(valuation.positionCount) !== 0 ||
      Number(valuation.usedMargin||0) !== 0 ||
      !Number.isSafeInteger(Number(valuation.financialRevision))) {
    throw new Error('Dedicated acceptance account must be flat with complete valuation');
  }
  const instrument=(await httpJson(config.trader,'/v1/instruments/RELIANCE',{bearer:token})).instrument;
  if (instrument?.executionEnabled !== true) {
    throw new Error('RELIANCE remains chart-only: staging pilot must be explicitly enabled by the authorized Railway STAGING operator first');
  }
  if (instrument.sessionOpen !== true || instrument.quoteCurrency !== 'INR' ||
      Number(instrument.defaultLeverage)!==10 || Number(instrument.leveragePolicyVersion)!==2 ||
      instrument.corporateActionPolicy !== 'UNSUPPORTED') {
    throw new Error('RELIANCE NSE session / staging pilot policy is not ready');
  }
  const preview=await httpJson(config.trader,'/v1/trading/orders/market/preview',{
    bearer:token,method:'POST',
    body:{accountId,symbol:'RELIANCE',side:'BUY',volume:instrument.minVolume||'0.001',source:'API'},
  });
  const quote=deriveStopFromPreview(preview,instrument.tickSize||'0.01',input.ACCEPTANCE_RELIANCE_STOP_DISTANCE_PERCENT||'2');
  const evidence={
    status:'PREFLIGHT_PASS',stage:'GLOBAL-MARKETS-M1-STAGE6',environment:'STAGING',
    accountId,symbol:'RELIANCE',quoteSource:quote.quoteSource,
    quoteReceivedAt:new Date(quote.quoteReceivedAtMs).toISOString(),
    buyPreviewPriceInr:quote.buyPrice,stopLossInr:quote.stopLoss,
    financialRevision:valuation.financialRevision,
    ready:Boolean(traderReady),fundedHealthy:Boolean(fundedHealth),
  };
  // No bearer, federation ticket, API key, or refresh token in the report.
  if (!execute) return evidence;
  const env={
    ...input,ACCEPTANCE_TARGET_ENVIRONMENT:'staging',
    ACCEPTANCE_TRADER_BASE_URL:config.trader,
    ACCEPTANCE_ACCOUNT_ID:accountId,
    ACCEPTANCE_TRADER_BEARER:token,
    ACCEPTANCE_RELIANCE_STOP_LOSS:quote.stopLoss,
  };
  const child=spawnSync(process.execPath,[path.join(__dirname,'acceptance-global-markets-final.js')],{
    env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error('Stage 6 live financial acceptance failed (inspect runner evidence and any cleanup result)');
  return {...evidence,status:'PASS',liveAcceptance:'PASS'};
}

if (require.main===module){
  bootstrap(process.env,{execute:process.argv.includes('--execute'),createFixture:process.argv.includes('--create-fixture')})
    .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
    .catch(error=>{
      process.stderr.write(JSON.stringify({status:'BLOCKED_OR_FAILED',message:error.message})+'\n');
      process.exitCode=1;
    });
}

module.exports={stagingOrigin,deriveStopFromPreview,verifyFixture,prepareEnvironment,bootstrap};
