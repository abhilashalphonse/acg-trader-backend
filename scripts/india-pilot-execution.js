'use strict';

// Explicit operational gate for Stage 2 only.
// This script never enables the full India catalog. It can toggle RELIANCE
// after the staging acceptance operator has intentionally set the confirmation
// flag. syncIndiaPilotCatalog() still defaults the symbol back to disabled on
// service restart, so activation is fail-closed during the pilot.

process.env.MARKET_GATEWAY_ENABLED = 'false';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { Instrument } = require('../src/modules/instruments/instrument.model');
const { LEVERAGE_POLICY_VERSION } = require('../src/modules/instruments/leverage-policy');

const PILOT_SYMBOL = 'RELIANCE';
const PILOT_EXECUTION_VERSION = 1001;

function requestedAction(argv = process.argv.slice(2)) {
  const action = String(argv[0] || '').trim().toLowerCase();
  if (!['enable', 'disable', 'status'].includes(action)) {
    throw new Error('Usage: node scripts/india-pilot-execution.js <enable|disable|status>');
  }
  return action;
}

function assertEnableGuard(env = process.env) {
  if (String(env.INDIA_EXECUTION_PILOT_ALLOWED || '').toLowerCase() !== 'true') {
    throw new Error('INDIA_EXECUTION_PILOT_ALLOWED=true is required to enable RELIANCE execution');
  }
  if (String(env.INDIA_EXECUTION_PILOT_CONFIRM || '') !== 'RELIANCE-STAGING-ONLY') {
    throw new Error('INDIA_EXECUTION_PILOT_CONFIRM=RELIANCE-STAGING-ONLY is required');
  }
  if (String(env.INDIA_EXECUTION_PILOT_ENVIRONMENT || '').toLowerCase() !== 'staging') {
    throw new Error('INDIA_EXECUTION_PILOT_ENVIRONMENT=staging is required');
  }

  const railwayEnvironment = String(
    env.RAILWAY_ENVIRONMENT_NAME
    || env.RAILWAY_ENVIRONMENT
    || '',
  ).trim().toLowerCase();
  if (railwayEnvironment === 'production') {
    throw new Error('Stage 2 RELIANCE pilot activation is blocked in the Railway production environment');
  }
}

function assertPilotInstrument(instrument) {
  if (!instrument) throw new Error('RELIANCE is not present in the instrument catalog');
  if (instrument.symbol !== PILOT_SYMBOL) throw new Error('Unexpected pilot symbol');
  if (String(instrument.assetClass || '').toUpperCase() !== 'EQUITY') throw new Error('RELIANCE must be an EQUITY instrument');
  if (String(instrument.quoteCurrency || '').toUpperCase() !== 'INR') throw new Error('RELIANCE must settle PnL in INR');
  if (Number(instrument.defaultLeverage) !== 10) throw new Error('RELIANCE must use 1:10 stock leverage');
  if (Number(instrument.leveragePolicyVersion || 0) !== LEVERAGE_POLICY_VERSION) {
    throw new Error(`RELIANCE leverage policy must be version ${LEVERAGE_POLICY_VERSION}`);
  }
  if (instrument.chartEnabled !== true) throw new Error('RELIANCE chart feed must be enabled before execution');
  if (String(instrument.status || '').toUpperCase() !== 'ACTIVE') throw new Error('RELIANCE instrument status must be ACTIVE');
  if (String(instrument.corporateActionPolicy || '').toUpperCase() !== 'UNSUPPORTED') {
    throw new Error('RELIANCE pilot must explicitly declare corporate actions UNSUPPORTED');
  }
}

async function setPilotExecution(action) {
  const instrument = await Instrument.findOne({ symbol: PILOT_SYMBOL });
  assertPilotInstrument(instrument);

  if (action === 'status') {
    return {
      symbol: PILOT_SYMBOL,
      executionEnabled: instrument.executionEnabled === true,
      executionProvisionVersion: Number(instrument.executionProvisionVersion || 0),
      leverage: Number(instrument.defaultLeverage),
      leveragePolicyVersion: Number(instrument.leveragePolicyVersion || 0),
      quoteCurrency: instrument.quoteCurrency,
    };
  }

  if (action === 'enable') assertEnableGuard();

  instrument.executionEnabled = action === 'enable';
  instrument.executionProvisionVersion = action === 'enable' ? PILOT_EXECUTION_VERSION : 0;
  await instrument.save();

  return {
    symbol: PILOT_SYMBOL,
    executionEnabled: instrument.executionEnabled === true,
    executionProvisionVersion: Number(instrument.executionProvisionVersion || 0),
    leverage: Number(instrument.defaultLeverage),
    leveragePolicyVersion: Number(instrument.leveragePolicyVersion || 0),
    quoteCurrency: instrument.quoteCurrency,
  };
}

async function run() {
  const action = requestedAction();
  await connectDatabase();
  try {
    const result = await setPilotExecution(action);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await disconnectDatabase();
  }
}

if (require.main === module) {
  run().catch(async error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    try { await disconnectDatabase(); } catch {}
    process.exit(1);
  });
}

module.exports = {
  PILOT_SYMBOL,
  PILOT_EXECUTION_VERSION,
  requestedAction,
  assertEnableGuard,
  assertPilotInstrument,
  setPilotExecution,
};
