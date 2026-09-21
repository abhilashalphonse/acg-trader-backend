'use strict';

const {
  TIMEFRAME_MS,
  candleBucketOpenTimeMs,
  CANONICAL_UTC_HISTORY_SOURCE,
} = require('./market.constants');

function canonicalSourceBarsPerTarget(timeframe) {
  const sourceTimeframe = CANONICAL_UTC_HISTORY_SOURCE[timeframe];
  const sourceMs = TIMEFRAME_MS[sourceTimeframe];
  const targetMs = TIMEFRAME_MS[timeframe];
  if (!sourceTimeframe || !sourceMs || !targetMs || targetMs < sourceMs) return null;
  return Math.ceil(targetMs / sourceMs);
}

function aggregateCanonicalUtcBars(sourceBars, timeframe) {
  if (!CANONICAL_UTC_HISTORY_SOURCE[timeframe]) return [];
  const stepMs = TIMEFRAME_MS[timeframe];
  if (!stepMs) return [];

  const byTime = new Map();
  for (const raw of Array.isArray(sourceBars) ? sourceBars : []) {
    const openTimeMs = Number(raw?.openTimeMs);
    const open = Number(raw?.open);
    const high = Number(raw?.high);
    const low = Number(raw?.low);
    const close = Number(raw?.close);
    if (![openTimeMs, open, high, low, close].every(Number.isFinite)) continue;
    byTime.set(openTimeMs, {
      openTimeMs,
      open,
      high,
      low,
      close,
      providerVolume: raw?.providerVolume == null ? null : Number(raw.providerVolume),
    });
  }

  const groups = new Map();
  for (const bar of [...byTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs)) {
    const bucket = candleBucketOpenTimeMs(bar.openTimeMs, timeframe);
    if (!Number.isFinite(bucket)) continue;

    let aggregate = groups.get(bucket);
    if (!aggregate) {
      aggregate = {
        openTimeMs: bucket,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        providerVolume: 0,
        providerVolumeComplete: true,
        sourceBarCount: 0,
        canonicalUtc: true,
      };
      groups.set(bucket, aggregate);
    } else {
      aggregate.high = Math.max(aggregate.high, bar.high);
      aggregate.low = Math.min(aggregate.low, bar.low);
      aggregate.close = bar.close;
    }

    aggregate.sourceBarCount += 1;
    if (Number.isFinite(bar.providerVolume) && bar.providerVolume >= 0) {
      aggregate.providerVolume += bar.providerVolume;
    } else {
      aggregate.providerVolumeComplete = false;
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.openTimeMs - b.openTimeMs)
    .map(bar => ({
      openTimeMs: bar.openTimeMs,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      providerVolume: bar.providerVolumeComplete ? bar.providerVolume : null,
      sourceBarCount: bar.sourceBarCount,
      canonicalUtc: true,
      closeTimeMs: bar.openTimeMs + stepMs,
    }));
}

module.exports = {
  aggregateCanonicalUtcBars,
  canonicalSourceBarsPerTarget,
};
