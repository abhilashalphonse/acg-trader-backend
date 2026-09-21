'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// Keep enough intraday history for a stable local tick-volume fallback without
// allowing MongoDB growth to become unbounded. Provider OHLC remains the source
// for chart price history; these local rows primarily preserve tickCount and
// recent live-volume metadata.
const CANDLE_RETENTION_MS = Object.freeze({
  '1m': 2 * DAY_MS,
  '5m': 7 * DAY_MS,
  '15m': 14 * DAY_MS,
  '30m': 30 * DAY_MS,
  '1h': 30 * DAY_MS,
  '4h': 90 * DAY_MS,
  '1d': 730 * DAY_MS,
  '1w': null,
});

function candleExpiresAt(timeframe, openTimeMs) {
  const retentionMs = CANDLE_RETENTION_MS[String(timeframe || '').toLowerCase()];
  if (!Number.isFinite(retentionMs)) return null;
  const base = Number(openTimeMs);
  if (!Number.isFinite(base)) return null;
  return new Date(base + retentionMs);
}

module.exports = { CANDLE_RETENTION_MS, candleExpiresAt };
