'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestedAction,
  assertEnableGuard,
  assertPilotInstrument,
  PILOT_SYMBOL,
  PILOT_EXECUTION_VERSION,
} = require('../../scripts/india-pilot-execution');

function reliance(overrides = {}) {
  return {
    symbol: 'RELIANCE',
    assetClass: 'EQUITY',
    quoteCurrency: 'INR',
    defaultLeverage: 10,
    leveragePolicyVersion: 2,
    chartEnabled: true,
    executionEnabled: false,
    executionProvisionVersion: 0,
    status: 'ACTIVE',
    ...overrides,
  };
}

test('India pilot targets RELIANCE only with a separate execution provision version', () => {
  assert.equal(PILOT_SYMBOL, 'RELIANCE');
  assert.equal(PILOT_EXECUTION_VERSION, 1001);
  assert.equal(requestedAction(['status']), 'status');
  assert.equal(requestedAction(['disable']), 'disable');
  assert.throws(() => requestedAction(['TCS']), /Usage/);
});

test('RELIANCE pilot enable is fail-closed without both explicit staging flags', () => {
  assert.throws(
    () => assertEnableGuard({ NODE_ENV: 'staging' }),
    /INDIA_EXECUTION_PILOT_ALLOWED=true/,
  );
  assert.throws(
    () => assertEnableGuard({
      NODE_ENV: 'staging',
      INDIA_EXECUTION_PILOT_ALLOWED: 'true',
    }),
    /INDIA_EXECUTION_PILOT_CONFIRM=RELIANCE-STAGING-ONLY/,
  );
});

test('RELIANCE pilot enable accepts the exact non-production confirmation', () => {
  assert.doesNotThrow(() => assertEnableGuard({
    NODE_ENV: 'staging',
    INDIA_EXECUTION_PILOT_ALLOWED: 'true',
    INDIA_EXECUTION_PILOT_CONFIRM: 'RELIANCE-STAGING-ONLY',
  }));
});

test('RELIANCE pilot activation is blocked in production even with confirmation', () => {
  assert.throws(
    () => assertEnableGuard({
      NODE_ENV: 'production',
      INDIA_EXECUTION_PILOT_ALLOWED: 'true',
      INDIA_EXECUTION_PILOT_CONFIRM: 'RELIANCE-STAGING-ONLY',
    }),
    /blocked in production/,
  );
});

test('pilot instrument validator requires INR equity terms at leverage policy v2', () => {
  assert.doesNotThrow(() => assertPilotInstrument(reliance()));
  assert.throws(() => assertPilotInstrument(reliance({ defaultLeverage: 100 })), /1:10/);
  assert.throws(() => assertPilotInstrument(reliance({ quoteCurrency: 'USD' })), /INR/);
  assert.throws(() => assertPilotInstrument(reliance({ leveragePolicyVersion: 1 })), /version 2/);
  assert.throws(() => assertPilotInstrument(reliance({ chartEnabled: false })), /chart feed/);
  assert.throws(() => assertPilotInstrument(reliance({ status: 'HALTED' })), /ACTIVE/);
});
