'use strict';

// Stage 6 mixed-market acceptance. Use ONLY while NSE is closed and EURUSD
// is live, with a pre-existing RELIANCE position in a dedicated staging account.
// Does not close/reprice RELIANCE or enable India execution.
const crypto = require('crypto');
const { compareDecimal } = require('../src/shared/decimal/decimal');
const {
  assertStagingAcceptanceEnvironment,
} = require('../src/modules/operations/global-markets-acceptance-contract');

const baseUrl = String(process.env.ACCEPTANCE_TRADER_BASE_URL || '').replace(/\/+$/, '');
const bearer = String(process.env.ACCEPTANCE_TRADER_BEARER || '');
const accountId = String(process.env.ACCEPTANCE_ACCOUNT_ID || '');
const volume = String(process.env.ACCEPTANCE_EURUSD_VOLUME || '0.01');
const nonce = crypto.randomUUID();

function expect(value, message, evidence = null) {
  if (value) return;
  const error = new Error(message);
  error.evidence = evidence;
  throw error;
}
async function request(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
  expect(response.ok, `Request failed: ${path}`, {
    status: response.status,
    code: payload?.error?.code || payload?.code || null,
  });
  return payload;
}
async function run() {
  assertStagingAcceptanceEnvironment({
    baseUrl, bearer, accountId, requireStopLoss: false,
    deploymentEnvironment: process.env.ACCEPTANCE_TARGET_ENVIRONMENT,
    mutationAcknowledgement: process.env.ACCEPTANCE_ALLOW_MUTATIONS,
  });
  expect(compareDecimal(volume, '0') > 0, 'Positive EURUSD lot size required');
  const report = {
    acceptance: 'GLOBAL-MARKETS-M1-STAGE6-CLOSED-NSE-MIXED-MARKET',
    environment: 'STAGING', accountId,
    startedAt: new Date().toISOString(), checks: [],
  };
  let eurusdPositionId = null;
  let closedEurusd = false;
  try {
    const reliance = (await request('/v1/instruments/RELIANCE')).instrument;
    const eurusd = (await request('/v1/instruments/EURUSD')).instrument;
    expect(reliance?.symbol === 'RELIANCE'
      && reliance.sessionOpen === false
      && eurusd?.symbol === 'EURUSD' && eurusd.sessionOpen === true
      && eurusd.executionEnabled === true,
    'Requires CLOSED NSE while EURUSD is open and tradable', {
      nseSessionOpen: reliance?.sessionOpen,
      eurusdSessionOpen: eurusd?.sessionOpen,
      eurusdExecutionEnabled: eurusd?.executionEnabled,
    });
    report.checks.push({ name: 'independent-session-availability', status: 'PASS' });

    const positions = await request(
      `/v1/trading/accounts/${accountId}/history/positions?symbol=RELIANCE&status=OPEN&limit=100`);
    const held = (positions.items || []).filter(x =>
      x.symbol === 'RELIANCE' && x.status === 'OPEN'
      && compareDecimal(x.openVolume, '0') > 0);
    expect(held.length > 0, 'Account must already hold an open RELIANCE position before NSE closes');
    const originals = held.map(x => ({ id: x.id, volume: x.openVolume }));
    report.heldReliance = originals;
    report.checks.push({ name: 'overnight-reliance-exposure-present', status: 'PASS' });

    const before = await request(`/v1/trading/accounts/${accountId}/valuation`);
    expect(before?.complete === true && Number.isSafeInteger(Number(before.financialRevision)),
      'Account requires a complete approved closing mark for RELIANCE');
    report.before = {
      financialRevision: before.financialRevision,
      valuationStatus: before.valuationStatus,
      valuationCompleteness: before.accountValuationCompleteness || null,
    };
    report.checks.push({ name: 'closed-session-valuation-complete', status: 'PASS' });

    const preview = await request('/v1/trading/orders/market/preview', {
      method: 'POST',
      body: { accountId, symbol: 'EURUSD', side: 'BUY', volume, source: 'API' },
    });
    expect(preview.previewVersion === 'ACG_ORDER_PREVIEW_V1'
      && preview.symbol === 'EURUSD'
      && preview.accountCurrency === 'USD'
      && preview.executionPolicy?.allowed !== false,
    'EURUSD cannot be previewed while NSE stock is held', preview);
    report.checks.push({ name: 'eurusd-preview-while-nse-closed', status: 'PASS' });

    const opened = await request('/v1/trading/orders/market', {
      method: 'POST',
      body: {
        accountId, symbol: 'EURUSD', side: 'BUY', volume,
        clientOrderId: `gm1-mixed-open:${nonce}`, source: 'API',
      },
    });
    expect(opened.position?.status === 'OPEN'
      && opened.position.symbol === 'EURUSD',
    'EURUSD execution blocked while NSE is closed');
    eurusdPositionId = opened.position.id;
    report.open = {
      positionId: eurusdPositionId,
      financialRevision: opened.account?.financialRevision,
    };
    report.checks.push({ name: 'eurusd-execution-with-reliance-held', status: 'PASS' });

    const closed = await request(`/v1/trading/positions/${eurusdPositionId}/close`, {
      method: 'POST', body: {
        accountId, clientOrderId: `gm1-mixed-close:${nonce}`,
        volume: null, source: 'API',
      },
    });
    expect(closed.position?.status === 'CLOSED'
      && compareDecimal(closed.position.openVolume, '0') === 0,
    'EURUSD did not close while RELIANCE is held');
    closedEurusd = true;
    report.checks.push({ name: 'eurusd-close-with-reliance-held', status: 'PASS' });

    const after = await request(`/v1/trading/accounts/${accountId}/valuation`);
    expect(Number(after.financialRevision) === Number(before.financialRevision) + 2,
    'Mixed-market EURUSD round trip must advance financial revision by two');
    const positionsAfter = await request(
      `/v1/trading/accounts/${accountId}/history/positions?symbol=RELIANCE&status=OPEN&limit=100`);
    const current = positionsAfter.items || [];
    for (const original of originals) {
      expect(current.some(x => x.id === original.id
        && x.status === 'OPEN'
        && compareDecimal(x.openVolume, original.volume) === 0),
      'EURUSD operation unexpectedly changed the held RELIANCE position', original);
    }
    report.after = {
      financialRevision: after.financialRevision,
      valuationStatus: after.valuationStatus,
      heldReliancePositionCount: current.length,
    };
    report.checks.push({ name: 'no-nse-position-mutation', status: 'PASS' });
    report.status = 'PASS';
    report.completedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.status = 'FAIL';
    report.message = error.message;
    report.details = error.evidence || null;
    report.failedAt = new Date().toISOString();
    if (eurusdPositionId && !closedEurusd) {
      try {
        const cleanup = await request(`/v1/trading/positions/${eurusdPositionId}/close`, {
          method: 'POST', body: {
            accountId, clientOrderId: `gm1-mixed-cleanup:${nonce}`,
            volume: null, source: 'API',
          },
        });
        report.cleanup = { attempted: true, success: cleanup.position?.status === 'CLOSED' };
      } catch (cleanupError) {
        report.cleanup = { attempted: true, success: false, message: cleanupError.message };
      }
    }
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

run().catch(error => {
  process.stderr.write(`${JSON.stringify({
    acceptance: 'GLOBAL-MARKETS-M1-STAGE6-CLOSED-NSE-MIXED-MARKET',
    status: 'BLOCKED', reason: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
