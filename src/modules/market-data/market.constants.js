'use strict';

const TIMEFRAME_MS = Object.freeze({
  // Internal bucket support retained for deterministic candle-engine tests and
  // legacy stored bars. These are not public/supported ACG Trader timeframes.
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
});

const TWELVE_DATA_HISTORY_INTERVALS = Object.freeze({
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
});

const MARKET_CONNECTION_STATES = Object.freeze({
  DISABLED: 'DISABLED',
  CONNECTING: 'CONNECTING',
  LIVE: 'LIVE',
  DISCONNECTED: 'DISCONNECTED',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
});

module.exports = {
  TIMEFRAME_MS,
  TWELVE_DATA_HISTORY_INTERVALS,
  MARKET_CONNECTION_STATES,
};
