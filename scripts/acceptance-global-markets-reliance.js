'use strict';

const crypto = require('crypto');

const baseUrl = String(process.env.ACCEPTANCE_TRADER_BASE_URL || '').replace(/\/+$/, '');
const bearer = String(process.env.ACCEPTANCE_TRADER_BEARER || '');
const accountId = String(process.env.ACCEPTANCE_ACCOUNT_ID || '');
const volume = String(process.env.ACCEPTANCE_RELIANCE_VOLUME || '1');

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

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
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return {
    ok: response.ok,
    status: response.status,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    payload,
  };
}

function expect(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function run() {
  required('ACCEPTANCE_TRADER_BASE_URL', baseUrl);
  required('ACCEPTANCE_TRADER_BEARER', bearer);
  required('ACCEPTANCE_ACCOUNT_ID', accountId);

  const report = {
    acceptance: 'GLOBAL-MARKETS-M1-RELIANCE',
    symbol: 'RELIANCE',
    accountId,
    volume,
    startedAt: new Date().toISOString(),
    checks: [],
  };

  const instrument = await request('/v1/instruments/RELIANCE');
  expect(instrument.ok, 'RELIANCE instrument lookup failed', instrument);
  const spec = instrument.payload?.instrument;
  expect(spec?.symbol === 'RELIANCE', 'Unexpected instrument payload', spec);
  expect(spec?.quoteCurrency === 'INR', 'RELIANCE quote currency must be INR', spec);
  expect(Number(spec?.defaultLeverage) === 10, 'RELIANCE leverage must be 1:10', spec);
  expect(Number(spec?.leveragePolicyVersion) === 2, 'RELIANCE leverage policy must be v2', spec);
  expect(spec?.executionEnabled === true, 'RELIANCE pilot execution is not explicitly enabled', spec);
  expect(spec?.sessionOpen === true, 'NSE session is closed; run the execution acceptance during an open session', spec);
  report.checks.push({ name: 'instrument', status: 'PASS', elapsedMs: instrument.elapsedMs });

  const before = await request(`/v1/trading/accounts/${accountId}/valuation`);
  expect(before.ok, 'Pre-flight account valuation lookup failed', before);
  const beforeValuation = before.payload;
  expect(beforeValuation?.complete === true, 'Acceptance account valuation must be complete before testing', beforeValuation);
  expect(Number(beforeValuation?.positionCount) === 0, 'Acceptance account must be flat before the RELIANCE lifecycle test', beforeValuation);
  report.before = {
    balance: beforeValuation?.balance,
    equity: beforeValuation?.equity,
    floatingPnl: beforeValuation?.floatingPnl,
    usedMargin: beforeValuation?.usedMargin,
    financialRevision: beforeValuation?.financialRevision,
    valuationEpoch: beforeValuation?.valuationEpoch,
    sequence: beforeValuation?.sequence,
  };
  report.checks.push({ name: 'pre-flight-flat-account', status: 'PASS', elapsedMs: before.elapsedMs });

  const preview = await request('/v1/trading/orders/market/preview', {
    method: 'POST',
    body: {
      accountId,
      symbol: 'RELIANCE',
      side: 'BUY',
      volume,
      source: 'API',
    },
  });
  expect(preview.ok, 'RELIANCE order preview failed', preview);
  const p = preview.payload;
  expect(p?.previewVersion === 'ACG_ORDER_PREVIEW_V1', 'Unexpected preview contract', p);
  expect(p?.accountCurrency === 'USD', 'Acceptance account must be USD-denominated', p);
  expect(p?.leverage?.effective === 10, 'Preview must use stock leverage 1:10', p);
  expect(Number(p?.costs?.requiredMargin) > 0, 'Preview required margin must be positive', p);
  expect(p?.quote?.source, 'Preview must expose quote source evidence', p);
  expect(p?.conversion?.margin?.purpose === 'MARGIN', 'Preview must expose margin FX purpose', p);
  expect(p?.conversion?.margin?.path?.[0]?.symbol === 'USDINR', 'Preview margin must use USDINR conversion evidence', p);
  expect(p?.conversion?.margin?.path?.[0]?.selectedSide === 'ASK', 'Positive INR margin must convert through USDINR ASK', p);
  expect(p?.conversion?.openingPnl?.path?.[0]?.symbol === 'USDINR', 'Preview opening PnL must expose USDINR conversion evidence', p);
  expect(p?.executionPolicy?.allowed !== false, 'Execution policy blocks RELIANCE open', p);
  report.preview = {
    fillPrice: p.fillPrice,
    requiredMargin: p.costs.requiredMargin,
    immediateOpeningPnl: p.costs.immediateOpeningPnl,
    quoteSource: p.quote.source,
    quoteSequence: p.quote.sequence,
    quoteReceivedAtMs: p.quote.receivedAtMs,
    marginConversion: p.conversion.margin,
    openingPnlConversion: p.conversion.openingPnl,
    projectedAccount: p.projectedAccount,
  };
  report.checks.push({ name: 'preview', status: 'PASS', elapsedMs: preview.elapsedMs });

  const afterPreview = await request(`/v1/trading/accounts/${accountId}/valuation`);
  expect(afterPreview.ok, 'Post-preview valuation lookup failed', afterPreview);
  expect(
    Number(afterPreview.payload?.financialRevision) === Number(beforeValuation?.financialRevision),
    'Order preview changed financialRevision',
    { before: beforeValuation, after: afterPreview.payload },
  );
  expect(afterPreview.payload?.balance === beforeValuation?.balance, 'Order preview changed account balance', {
    before: beforeValuation?.balance,
    after: afterPreview.payload?.balance,
  });
  expect(Number(afterPreview.payload?.positionCount) === 0, 'Order preview created exposure', afterPreview.payload);
  report.checks.push({ name: 'preview-side-effect-free', status: 'PASS', elapsedMs: afterPreview.elapsedMs });

  const nonce = crypto.randomUUID();
  const opened = await request('/v1/trading/orders/market', {
    method: 'POST',
    body: {
      accountId,
      clientOrderId: `gm1-reliance-open:${nonce}`,
      symbol: 'RELIANCE',
      side: 'BUY',
      volume,
      source: 'API',
    },
  });
  expect(opened.ok, 'RELIANCE market open failed', opened);
  expect(opened.payload?.position?.status === 'OPEN', 'RELIANCE position did not open', opened.payload);
  expect(opened.payload?.position?.quoteCurrency === 'INR', 'Opened RELIANCE position must preserve INR PnL currency', opened.payload);
  expect(Number(opened.payload?.position?.margin) > 0, 'Opened RELIANCE position must reserve USD account margin', opened.payload);
  const positionId = opened.payload.position.id;
  report.open = {
    positionId,
    fillPrice: opened.payload?.execution?.fillPrice || opened.payload?.position?.entryPrice,
    margin: opened.payload?.position?.margin,
    financialRevision: opened.payload?.account?.financialRevision,
  };
  report.checks.push({ name: 'open', status: 'PASS', elapsedMs: opened.elapsedMs });

  const closed = await request(`/v1/trading/positions/${positionId}/close`, {
    method: 'POST',
    body: {
      accountId,
      clientOrderId: `gm1-reliance-close:${nonce}`,
      volume: null,
      source: 'API',
    },
  });
  expect(closed.ok, 'RELIANCE market close failed', closed);
  expect(closed.payload?.position?.status === 'CLOSED', 'RELIANCE position did not close', closed.payload);
  expect(closed.payload?.position?.openVolume === '0', 'Closed RELIANCE position retained open volume', closed.payload);
  report.close = {
    realizedPnl: closed.payload?.deal?.realizedPnl,
    balance: closed.payload?.account?.state?.balance,
    equity: closed.payload?.account?.state?.equity,
    floatingPnl: closed.payload?.account?.state?.floatingPnl,
    usedMargin: closed.payload?.account?.state?.usedMargin,
    financialRevision: closed.payload?.account?.financialRevision,
  };
  report.checks.push({ name: 'close', status: 'PASS', elapsedMs: closed.elapsedMs });

  const valuation = await request(`/v1/trading/accounts/${accountId}/valuation`);
  expect(valuation.ok, 'Post-close valuation lookup failed', valuation);
  const v = valuation.payload;
  expect(v?.complete === true, 'Post-close account valuation is incomplete', v);
  expect(Number(v?.positionCount) === 0, 'Post-close account still has open positions', v);
  expect(String(v?.floatingPnl) === '0', 'Flat account retained floating PnL after full close', v);
  expect(String(v?.usedMargin) === '0', 'Flat account retained used margin after full close', v);
  expect(String(v?.equity) === String(v?.balance), 'Flat account equity does not equal balance after full close', v);
  expect(
    Number(v?.financialRevision) === Number(beforeValuation?.financialRevision) + 2,
    'RELIANCE open + close did not advance financialRevision exactly twice',
    { before: beforeValuation, after: v },
  );
  report.valuation = {
    status: v?.valuationStatus,
    completeness: v?.accountValuationCompleteness || null,
    equity: v?.equity,
    floatingPnl: v?.floatingPnl,
    usedMargin: v?.usedMargin,
    positionCount: v?.positionCount,
    financialRevision: v?.financialRevision,
    valuationEpoch: v?.valuationEpoch,
    sequence: v?.sequence,
  };
  report.checks.push({ name: 'post-close-valuation', status: 'PASS', elapsedMs: valuation.elapsedMs });

  report.status = 'PASS';
  report.completedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch(error => {
  process.stderr.write(`${JSON.stringify({
    acceptance: 'GLOBAL-MARKETS-M1-RELIANCE',
    status: 'FAIL',
    message: error.message,
    details: error.details || null,
    failedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(1);
});
