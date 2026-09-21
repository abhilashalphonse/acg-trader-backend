'use strict';

const { Candle } = require('./candle.model');
const { CANDLE_RETENTION_MS, candleExpiresAt } = require('./candle-retention');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runLegacyCandleCleanup({
  collection = Candle.collection,
  logger = null,
  nowMs = Date.now(),
  batchSize = 500,
  delayMs = 100,
  pause = sleep,
} = {}) {
  const safeBatchSize = Math.max(50, Math.min(5000, Number(batchSize) || 500));
  const safeDelayMs = Math.max(0, Math.min(5000, Number(delayMs) || 0));
  const summary = {
    startedAt: new Date(nowMs).toISOString(),
    deletedExpiredLive: {},
    expiryBackfilled: {},
    deletedTotal: 0,
    expiryBackfilledTotal: 0,
  };

  for (const [timeframe, retentionMs] of Object.entries(CANDLE_RETENTION_MS)) {
    if (!Number.isFinite(retentionMs)) continue;

    const cutoff = new Date(nowMs - retentionMs);
    const deleted = await deleteExpiredLive({
      collection, timeframe, cutoff, batchSize: safeBatchSize,
      delayMs: safeDelayMs, pause, logger,
    });
    summary.deletedExpiredLive[timeframe] = deleted;
    summary.deletedTotal += deleted;

    const backfilled = await backfillMissingExpiry({
      collection, timeframe, batchSize: safeBatchSize,
      delayMs: safeDelayMs, pause, logger,
    });
    summary.expiryBackfilled[timeframe] = backfilled;
    summary.expiryBackfilledTotal += backfilled;
  }

  logger?.info?.(summary, 'Legacy candle retention cleanup complete');
  return summary;
}

async function deleteExpiredLive({ collection, timeframe, cutoff, batchSize, delayMs, pause, logger }) {
  let deleted = 0;

  while (true) {
    const rows = await collection
      .find(
        { source: 'LIVE', timeframe, openTime: { $lte: cutoff } },
        { projection: { _id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (!rows.length) break;

    const ids = rows.map(row => row._id);
    const result = await collection.deleteMany({ _id: { $in: ids } });
    deleted += Number(result.deletedCount || 0);

    if (deleted % (batchSize * 10) === 0) {
      logger?.info?.({ timeframe, deleted }, 'Legacy expired candle cleanup progress');
    }
    if (delayMs > 0) await pause(delayMs);
  }

  if (deleted) logger?.info?.({ timeframe, deleted }, 'Legacy expired candles deleted');
  return deleted;
}

async function backfillMissingExpiry({ collection, timeframe, batchSize, delayMs, pause, logger }) {
  let updated = 0;

  while (true) {
    const rows = await collection
      .find(
        {
          source: 'LIVE',
          timeframe,
          $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }],
        },
        { projection: { _id: 1, openTime: 1 } },
      )
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (!rows.length) break;

    const operations = rows
      .map(row => {
        const expiresAt = candleExpiresAt(timeframe, new Date(row.openTime).getTime());
        if (!expiresAt) return null;
        return { updateOne: { filter: { _id: row._id }, update: { $set: { expiresAt } } } };
      })
      .filter(Boolean);

    if (!operations.length) break;

    const result = await collection.bulkWrite(operations, { ordered: false });
    updated += Number(result.modifiedCount || result.matchedCount || 0);

    if (updated % (batchSize * 10) === 0) {
      logger?.info?.({ timeframe, updated }, 'Legacy candle expiry backfill progress');
    }
    if (delayMs > 0) await pause(delayMs);
  }

  if (updated) logger?.info?.({ timeframe, updated }, 'Legacy candle expiry metadata backfilled');
  return updated;
}

module.exports = { runLegacyCandleCleanup, deleteExpiredLive, backfillMissingExpiry };
