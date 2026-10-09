'use strict';

// Stage 6 is intentionally mutation-capable ONLY on a staging HTTPS hostname
// with explicit acknowledgement. It does not enable instruments or alter
// provider configuration. Run on a dedicated clean USD funded test account.
const crypto = require('crypto');
const { compareDecimal, subtractDecimal } = require('../src/shared/decimal/decimal');
const {
  MUTATION_ACK,
  assertStagingAcceptanceEnvironment,
  assertAuthoritativeSizing,
  partialCloseVolume,
  assertNativeCloseEvidence,
  assertFlatAccountAfterThreeMutations,
} = require('../src/modules/operations/global-markets-acceptance-contract');

const baseUrl = String(process.env.ACCEPTANCE_TRADER_BASE_URL || '').replace(/\/+$/, '');
const bearer = String(process.env.ACCEPTANCE_TRADER_BEARER || '');
const accountId = String(process.env.ACCEPTANCE_ACCOUNT_ID || '');
const stopLoss = String(process.env.ACCEPTANCE_RELIANCE_STOP_LOSS || '');
const riskBudget = String(process.env.ACCEPTANCE_RELIANCE_RISK_USD || '50');
const exposureBudget = String(process.env.ACCEPTANCE_RELIANCE_AMOUNT_USD || '196.90');

async function request(path, { method = 'GET', body = null } = {}) {
  const started = performance.now();
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
  return {
    ok: response.ok, status: response.status, payload,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

function expect(condition, label, evidence) {
  if (condition) return;
  const error = new Error(label);
  error.details = evidence;
  throw error;
}

async function requireOk(path, options, description) {
  const result = await request(path, options);
  expect(result.ok, description, {
    path, status: result.status,
    errorCode: result.payload?.error?.code || result.payload?.code || null,
  });
  return result;
}

async function run() {
  assertStagingAcceptanceEnvironment({
    baseUrl, bearer, accountId, stopLoss,
    deploymentEnvironment: process.env.ACCEPTANCE_TARGET_ENVIRONMENT,
    mutationAcknowledgement: process.env.ACCEPTANCE_ALLOW_MUTATIONS,
  });
  expect(compareDecimal(riskBudget, '0') > 0, 'Risk budget must be positive');
  expect(compareDecimal(exposureBudget, '0') > 0, 'Exposure budget must be positive');

  const report = {
    acceptance: 'GLOBAL-MARKETS-M1-STAGE6-FINANCIAL-LIFECYCLE',
    environment: 'STAGING',
    accountId, symbol: 'RELIANCE',
    riskBudgetUsd: riskBudget, exposureBudgetUsd: exposureBudget,
    startedAt: new Date().toISOString(), checks: [],
    status: 'RUNNING', cleanup: null,
  };
  const nonce = crypto.randomUUID();
  let openPositionId = null;
  let closedCompletely = false;

  try {
    const instrument = (await requireOk(
      '/v1/instruments/RELIANCE', {}, 'Instrument lookup failed')).payload.instrument;
    expect(instrument?.symbol === 'RELIANCE' && instrument.quoteCurrency === 'INR'
      && instrument.assetClass === 'EQUITY'
      && instrument.executionEnabled === true
      && instrument.sessionOpen === true
      && Number(instrument.defaultLeverage) === 10
      && Number(instrument.leveragePolicyVersion) === 2
      && instrument.corporateActionPolicy === 'UNSUPPORTED',
    'RELIANCE staging instrument is not the approved 1:10 NSE pilot', instrument);
    report.checks.push({ name: 'instrument-and-session', status: 'PASS' });

    const before = (await requireOk(
      `/v1/trading/accounts/${accountId}/valuation`, {},
      'Account preflight unavailable')).payload;
    expect(before?.complete === true && Number(before?.positionCount) === 0
      && Number.isSafeInteger(Number(before.financialRevision)),
    'Dedicated staging account must be flat with complete USD valuation and revision', before);
    report.start = {
      financialRevision: before.financialRevision,
      balance: before.balance, equity: before.equity,
    };
    report.checks.push({ name: 'flat-account-preflight', status: 'PASS' });

    const previewRisk = (await requireOk('/v1/trading/orders/market/preview', {
      method: 'POST',
      body: {
        accountId, symbol: 'RELIANCE', side: 'BUY',
        sizingMode: 'RISK', sizingAmount: riskBudget,
        stopLoss, source: 'API',
      },
    }, 'Authoritative USD risk preview failed')).payload;
    const volume = assertAuthoritativeSizing(previewRisk, {
      mode: 'RISK', budget: riskBudget,
      step: instrument.volumeStep || '0.001',
    });
    const partialVolume = partialCloseVolume(volume, {
      step: instrument.volumeStep || '0.001',
      minimum: instrument.minVolume || instrument.volumeStep || '0.001',
    });
    expect(Number(previewRisk?.leverage?.effective) === 10
      && previewRisk?.conversion?.margin?.path?.some(
        item => item.symbol === 'USDINR' && item.selectedSide === 'ASK')
      && compareDecimal(previewRisk.costs.requiredMargin, '0') > 0,
    'RELIANCE risk preview missing proper leverage or executable FX evidence');
    report.riskPreview = {
      quantity: volume, requestedRiskUsd: riskBudget,
      estimatedRiskUsd: previewRisk.risk.amount,
      requiredMarginUsd: previewRisk.costs.requiredMargin,
      nativeExposureInr: previewRisk.exposure.nativeAmount,
      accountExposureUsd: previewRisk.exposure.amount,
      conversionEvidence: previewRisk.exposure.conversion,
    };
    report.checks.push({ name: 'risk-50-and-fractional-quantity', status: 'PASS' });

    const amountPreview = (await requireOk('/v1/trading/orders/market/preview', {
      method: 'POST',
      body: {
        accountId, symbol: 'RELIANCE', side: 'BUY',
        sizingMode: 'AMOUNT', sizingAmount: exposureBudget,
        stopLoss, source: 'API',
      },
    }, 'Authoritative USD amount preview failed')).payload;
    assertAuthoritativeSizing(amountPreview, {
      mode: 'AMOUNT', budget: exposureBudget,
      step: instrument.volumeStep || '0.001',
    });
    report.amountPreview = {
      requestedUsd: exposureBudget,
      filledUsd: amountPreview.sizing.actualAmount,
      quantity: amountPreview.volume,
    };
    report.checks.push({ name: 'account-currency-exposure-sizing', status: 'PASS' });

    const afterPreview = (await requireOk(
      `/v1/trading/accounts/${accountId}/valuation`, {},
      'Post-preview valuation unavailable')).payload;
    expect(afterPreview.balance === before.balance
      && Number(afterPreview.financialRevision) === Number(before.financialRevision)
      && Number(afterPreview.positionCount) === 0,
    'Sizing preview changed financial state or created exposure');
    report.checks.push({ name: 'preview-no-mutation', status: 'PASS' });

    const opened = (await requireOk('/v1/trading/orders/market', {
      method: 'POST',
      body: {
        accountId, symbol: 'RELIANCE', side: 'BUY',
        clientOrderId: `m1-stage6-open:${nonce}`,
        volume, maxRiskAmount: riskBudget,
        stopLoss, source: 'API',
      },
    }, 'Live STAGING RELIANCE order failed')).payload;
    expect(opened.position?.status === 'OPEN'
      && opened.position?.quoteCurrency === 'INR'
      && compareDecimal(opened.position?.openVolume, volume) === 0
      && compareDecimal(opened.position?.margin, '0') > 0,
    'Opened RELIANCE position has unexpected financial terms');
    openPositionId = opened.position.id;
    report.open = {
      positionId: openPositionId,
      volume, financialRevision: opened.account.financialRevision,
      marginUsd: opened.position.margin,
    };
    report.checks.push({ name: 'risk-capped-open', status: 'PASS' });

    const partial = (await requireOk(
      `/v1/trading/positions/${openPositionId}/close`, {
        method: 'POST', body: {
          accountId, clientOrderId: `m1-stage6-partial:${nonce}`,
          volume: partialVolume, source: 'API',
        },
      }, 'RELIANCE partial close failed')).payload;
    expect(partial.position?.status === 'OPEN'
      && compareDecimal(partial.position?.openVolume,
        subtractDecimal(volume, partialVolume)) === 0,
    'Partial close did not retain expected remaining fractional quantity');
    assertNativeCloseEvidence(partial.deal);
    report.partial = {
      volume: partialVolume, remainingVolume: partial.position.openVolume,
      nativePnlInr: partial.deal.nativeRealizedPnl,
      accountPnlUsd: partial.deal.realizedPnl,
      fxEvidence: partial.deal.pnlConversionEvidence,
      financialRevision: partial.account.financialRevision,
    };
    report.checks.push({ name: 'partial-close-and-native-settlement', status: 'PASS' });

    const fullyClosed = (await requireOk(
      `/v1/trading/positions/${openPositionId}/close`, {
        method: 'POST', body: {
          accountId, clientOrderId: `m1-stage6-final:${nonce}`,
          volume: null, source: 'API',
        },
      }, 'RELIANCE full close failed')).payload;
    expect(fullyClosed.position?.status === 'CLOSED'
      && compareDecimal(fullyClosed.position?.openVolume, '0') === 0,
    'Final close did not flatten position');
    closedCompletely = true;
    assertNativeCloseEvidence(fullyClosed.deal);
    report.finalClose = {
      nativePnlInr: fullyClosed.deal.nativeRealizedPnl,
      accountPnlUsd: fullyClosed.deal.realizedPnl,
      fxEvidence: fullyClosed.deal.pnlConversionEvidence,
      financialRevision: fullyClosed.account.financialRevision,
    };
    report.checks.push({ name: 'full-close-and-native-settlement', status: 'PASS' });

    const after = (await requireOk(
      `/v1/trading/accounts/${accountId}/valuation`, {},
      'Final account valuation unavailable')).payload;
    assertFlatAccountAfterThreeMutations(before, after);
    report.end = {
      balance: after.balance, equity: after.equity,
      financialRevision: after.financialRevision, positionCount: after.positionCount,
      floatingPnl: after.floatingPnl, usedMargin: after.usedMargin,
    };
    report.checks.push({ name: 'flat-usd-account-and-three-revisions', status: 'PASS' });

    const history = (await requireOk(
      `/v1/trading/accounts/${accountId}/history/deals?symbol=RELIANCE&limit=100`, {},
      'Immutable deal history unavailable')).payload;
    const closingIds = [partial.deal.id, fullyClosed.deal.id];
    const closingDeals = (history.items || []).filter(item => closingIds.includes(item.id));
    expect(closingDeals.length === 2, 'Recent immutable deal history is missing partial or final settlement');
    closingDeals.forEach(assertNativeCloseEvidence);
    report.checks.push({ name: 'immutable-dual-currency-deal-history', status: 'PASS' });

    report.status = 'PASS';
    report.completedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.status = 'FAIL';
    report.message = error.message;
    report.details = error.details || null;
    report.failedAt = new Date().toISOString();
    if (openPositionId && !closedCompletely) {
      try {
        const cleanup = await request(`/v1/trading/positions/${openPositionId}/close`, {
          method: 'POST',
          body: {
            accountId, clientOrderId: `m1-stage6-cleanup:${nonce}`,
            volume: null, source: 'API',
          },
        });
        report.cleanup = {
          attempted: true, success: cleanup.ok && cleanup.payload?.position?.status === 'CLOSED',
          positionId: openPositionId, httpStatus: cleanup.status,
          errorCode: cleanup.payload?.error?.code || null,
        };
      } catch (cleanupError) {
        report.cleanup = {
          attempted: true, success: false, positionId: openPositionId,
          error: cleanupError.message,
        };
      }
    }
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

run().catch(error => {
  process.stderr.write(`${JSON.stringify({
    acceptance: 'GLOBAL-MARKETS-M1-STAGE6-FINANCIAL-LIFECYCLE',
    status: 'BLOCKED', message: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
