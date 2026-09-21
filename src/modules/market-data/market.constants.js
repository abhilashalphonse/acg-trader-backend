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

const WEEK_MS = TIMEFRAME_MS['1w'];
const WEEK_ANCHOR_UTC_MS = Date.UTC(1970, 0, 5); // Monday 00:00:00 UTC.

function candleBucketOpenTimeMs(timeMs, timeframe) {
  const numericTime = Number(timeMs);
  const stepMs = TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(numericTime) || !stepMs) return null;
  if (timeframe === '1w') {
    return WEEK_ANCHOR_UTC_MS + Math.floor((numericTime - WEEK_ANCHOR_UTC_MS) / WEEK_MS) * WEEK_MS;
  }
  return Math.floor(numericTime / stepMs) * stepMs;
}

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

// Twelve Data ignores timezone for native daily/weekly bars. Build those ACG
// timeframes from UTC 4h provider bars so history and live aggregation share
// the exact same UTC boundaries (including a real partial Sunday D1 bar).
const CANONICAL_UTC_HISTORY_SOURCE = Object.freeze({
  '1d': '4h',
  '1w': '4h',
});

// Server-observed tick counts are only comparable across short intraday bars.
// Higher timeframes must use trustworthy provider volume or show unavailable.
const TICK_VOLUME_FALLBACK_TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m']);

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
  candleBucketOpenTimeMs,
  TWELVE_DATA_HISTORY_INTERVALS,
  CANONICAL_UTC_HISTORY_SOURCE,
  TICK_VOLUME_FALLBACK_TIMEFRAMES,
  MARKET_CONNECTION_STATES,
};
