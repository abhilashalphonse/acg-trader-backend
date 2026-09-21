'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// Free-tier launch policy: keep durable local history only where it provides
// meaningful resilience. Intraday chart history can be fetched from the market
// provider on demand; live bars continue to be built in memory.
const CANDLE_RETENTION_MS = Object.freeze({
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
