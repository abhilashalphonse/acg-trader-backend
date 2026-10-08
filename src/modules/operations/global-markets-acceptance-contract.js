'use strict';

const {
  compareDecimal, divideDecimal, subtractDecimal, quantizeToStep,
  isStepAligned, normalizeDecimal,
} = require('../../shared/decimal/decimal');

const MUTATION_ACK = 'GLOBAL_MARKETS_RELIANCE_STAGING_ONLY';

function assertStagingAcceptanceEnvironment({
  baseUrl,
  deploymentEnvironment,
  mutationAcknowledgement,
  accountId,
  bearer,
  stopLoss,
} = {}) {
  const url = new URL(String(baseUrl || ''));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !host.includes('staging')
    || host.includes('production') || host === 'acgfunded.com'
    || host === 'acg-trader.web.app') {
    throw new Error('Refusing RELIANCE financial mutations on a non-staging HTTPS host');
  }
  if (deploymentEnvironment !== 'staging' || mutationAcknowledgement !== MUTATION_ACK) {
    throw new Error('Explicit STAGING environment and financial mutation acknowledgement are required');
  }
  if (!/^[0-9a-f]{24}$/i.test(String(accountId || '')) || !String(bearer || '').trim()) {
    throw new Error('Dedicated test account ID and authenticated staging bearer are required');
  }
  if (stopLoss == null || compareDecimal(stopLoss, '0') <= 0) {
    throw new Error('A positive explicit RELIANCE stop loss is required to test $50 risk sizing');
  }
  return url.origin;
}

function assertAuthoritativeSizing(preview, {
  mode, budget, step = '0.001',
} = {}) {
  if (preview?.previewVersion !== 'ACG_ORDER_PREVIEW_V1'
    || preview.accountCurrency !== 'USD'
    || preview.symbol !== 'RELIANCE') throw new Error('Unexpected authoritative sizing preview');
  if (preview?.sizing?.mode !== mode) throw new Error('Sizing mode was not honored by Trader');
  const volume = normalizeDecimal(preview.volume);
  if (compareDecimal(volume, '0') <= 0 || !isStepAligned(volume, step)) {
    throw new Error('Trader returned a nonpositive or unaligned share quantity');
  }
  if (compareDecimal(preview.sizing.actualAmount, budget) > 0
    || compareDecimal(preview.sizing.requestedAmount, budget) !== 0) {
    throw new Error('Authoritative sizing exceeds the requested USD budget');
  }
  if (preview?.exposure?.nativeCurrency !== 'INR'
    || preview?.exposure?.accountCurrency !== 'USD'
    || compareDecimal(preview.exposure.nativeAmount, '0') <= 0
    || compareDecimal(preview.exposure.amount, '0') <= 0) {
    throw new Error('Native INR and USD exposure were not both provided');
  }
  const path = preview?.exposure?.conversion?.path;
  if (!Array.isArray(path) || !path.some(item => item.symbol === 'USDINR')) {
    throw new Error('Account-currency exposure is missing USDINR conversion evidence');
  }
  if (mode === 'RISK' &&
    (preview?.risk?.amount == null || compareDecimal(preview.risk.amount, budget) > 0)) {
    throw new Error('Stop-risk computation breached the accepted USD budget');
  }
  return volume;
}

function partialCloseVolume(volume, {
  step = '0.001',
  minimum = '0.001',
} = {}) {
  const partial = quantizeToStep(divideDecimal(volume, '2'), step);
  if (compareDecimal(partial, minimum) < 0
    || compareDecimal(subtractDecimal(volume, partial), minimum) < 0) {
    throw new Error('Quantity is too small for a supported partial close');
  }
  return partial;
}

function assertNativeCloseEvidence(deal) {
  if (!deal || deal.nativeRealizedPnl == null
    || deal.nativePnlCurrency !== 'INR'
    || deal.accountPnlCurrency !== 'USD'
    || deal.realizedPnl == null) {
    throw new Error('Close deal lacks paired immutable native INR and account USD PnL');
  }
  const evidence = deal.pnlConversionEvidence;
  if (evidence?.fromCurrency !== 'INR' || evidence?.toCurrency !== 'USD'
    || !Array.isArray(evidence.path)
    || !evidence.path.some(item => item.symbol === 'USDINR')) {
    throw new Error('Close deal does not preserve USDINR conversion direction and path');
  }
}

function assertFlatAccountAfterThreeMutations(before, after) {
  if (Number(after?.financialRevision) !== Number(before?.financialRevision) + 3) {
    throw new Error('Open + partial close + final close must advance financial revision exactly three times');
  }
  if (Number(after?.positionCount) !== 0
    || compareDecimal(after.floatingPnl, '0') !== 0
    || compareDecimal(after.usedMargin, '0') !== 0
    || compareDecimal(after.equity, after.balance) !== 0
    || after.complete !== true) {
    throw new Error('Final USD account state is not financially flat and complete');
  }
}

module.exports = {
  MUTATION_ACK,
  assertStagingAcceptanceEnvironment,
  assertAuthoritativeSizing,
  partialCloseVolume,
  assertNativeCloseEvidence,
  assertFlatAccountAfterThreeMutations,
};
