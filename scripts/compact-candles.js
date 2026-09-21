'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { Candle } = require('../src/modules/market-data/candle.model');
const { candleExpiresAt, CANDLE_RETENTION_MS } = require('../src/modules/market-data/candle-retention');

const DEFAULT_PERSIST = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const DURABLE_PERSIST = new Set(DEFAULT_PERSIST);
const BATCH_SIZE = 5000;
const SYNTHETIC_HIGHER_TIMEFRAMES = ['1h', '4h', '1d', '1w'];
const LEGACY_NATIVE_UTC_MISMATCH_TIMEFRAMES = ['1d', '1w'];
const PROVIDER_BACKFILL_SOURCES = ['BACKFILL', 'CANONICAL_BACKFILL'];
const REQUIRED_VOLUME_FALLBACK_PERSIST = ['1m', '5m', '15m', '30m'];

function persistedTimeframes() {
  const raw = String(process.env.MARKET_PERSIST_TIMEFRAMES || DEFAULT_PERSIST.join(','));
  const configured = raw.split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => DURABLE_PERSIST.has(value));
  // Match runtime env resolution: these short intraday timeframes are always
  // persisted because tick-volume recovery depends on recent local history.
  return [...new Set([...configured, ...REQUIRED_VOLUME_FALLBACK_PERSIST])];
}

async function deleteInBatches(filter, label = 'non-retained') {
  let deleted = 0;
  while (true) {
    const rows = await Candle.find(filter).select('_id').sort({ _id: 1 }).limit(BATCH_SIZE).lean();
    if (!rows.length) break;
    const ids = rows.map(row => row._id);
    const result = await Candle.deleteMany({ _id: { $in: ids } });
    deleted += result.deletedCount || 0;
    process.stdout.write(`Deleted ${deleted} ${label} candles\r`);
  }
  if (deleted) process.stdout.write('\n');
  return deleted;
}

async function groupCounts(pipelineMatch = {}) {
  return Candle.aggregate([
    { $match: pipelineMatch },
    {
      $group: {
        _id: { source: '$source', timeframe: '$timeframe' },
        count: { $sum: 1 },
        earliestOpenTime: { $min: '$openTime' },
        latestOpenTime: { $max: '$openTime' },
      },
    },
    { $sort: { '_id.source': 1, '_id.timeframe': 1 } },
  ]);
}

async function backfillExpiry(timeframe) {
  if (!Number.isFinite(CANDLE_RETENTION_MS[timeframe])) return 0;
  let updated = 0;
  while (true) {
    const rows = await Candle.find({
      timeframe,
      source: 'LIVE',
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }],
    })
      .select('_id openTime timeframe')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    if (!rows.length) break;

    const operations = rows.map(row => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { expiresAt: candleExpiresAt(timeframe, new Date(row.openTime).getTime()) } },
      },
    }));
    const result = await Candle.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount || result.matchedCount || 0;
    process.stdout.write(`Backfilled ${updated} ${timeframe} expiry values\r`);
  }
  if (updated) process.stdout.write('\n');
  return updated;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const retained = persistedTimeframes();
    const nonRetainedFilter = { timeframe: { $nin: retained } };
    const syntheticFilter = { synthetic: true };
    const syntheticHigherFilter = { synthetic: true, timeframe: { $in: SYNTHETIC_HIGHER_TIMEFRAMES } };
    const legacyNativeHigherFilter = {
      source: 'BACKFILL',
      timeframe: { $in: LEGACY_NATIVE_UTC_MISMATCH_TIMEFRAMES },
    };
    const providerBackfillFilter = { source: { $in: PROVIDER_BACKFILL_SOURCES } };
    const expiredFilter = { expiresAt: { $ne: null, $lte: new Date() } };

    const [
      nonRetained,
      syntheticCandles,
      syntheticHigherTimeframeCandles,
      legacyNativeHigherTimeframeCandles,
      providerBackfillCandles,
      expiredCandles,
      total,
      bySourceAndTimeframe,
    ] = await Promise.all([
      Candle.countDocuments(nonRetainedFilter),
      Candle.countDocuments(syntheticFilter),
      Candle.countDocuments(syntheticHigherFilter),
      Candle.countDocuments(legacyNativeHigherFilter),
      Candle.countDocuments(providerBackfillFilter),
      Candle.countDocuments(expiredFilter),
      Candle.estimatedDocumentCount(),
      groupCounts(),
    ]);

    console.log(JSON.stringify({
      mode: apply ? 'APPLY' : 'DRY_RUN',
      totalCandles: total,
      retainedTimeframes: retained,
      nonRetainedCandles: nonRetained,
      syntheticCandles,
      syntheticHigherTimeframeCandles,
      legacyNativeHigherTimeframeCandles,
      providerBackfillCandles,
      expiredCandles,
      bySourceAndTimeframe: bySourceAndTimeframe.map(row => ({
        source: row._id.source || null,
        timeframe: row._id.timeframe || null,
        count: row.count,
        earliestOpenTime: row.earliestOpenTime || null,
        latestOpenTime: row.latestOpenTime || null,
      })),
      retentionDays: Object.fromEntries(
        retained.map(timeframe => [
          timeframe,
          Number.isFinite(CANDLE_RETENTION_MS[timeframe])
            ? Math.round(CANDLE_RETENTION_MS[timeframe] / 86_400_000)
            : null,
        ]),
      ),
    }, null, 2));

    if (!apply) {
      console.log('Dry run only. Re-run with --apply to delete all provider backfills, all synthetic candles, expired candles, delete non-retained candles, and backfill TTL expiry for retained LIVE rows.');
      return;
    }

    // Historical provider OHLC now lives in the bounded RAM cache / provider
    // path and must not consume MongoDB. Delete these first because they were
    // the dominant source of collection growth.
    const deletedProviderBackfills = await deleteInBatches(providerBackfillFilter, 'provider backfill');

    // Synthetic rows are no longer durable market history at any timeframe.
    const deletedSynthetic = await deleteInBatches(syntheticFilter, 'synthetic');

    // Remove any unsupported/legacy timeframe rows.
    const deletedNonRetained = await deleteInBatches(nonRetainedFilter, 'non-retained');

    // Add expiry metadata to retained LIVE rows first. Some legacy rows predate
    // expiresAt, so deleting expired rows before this step would miss them.
    const expiry = {};
    for (const timeframe of retained) {
      expiry[timeframe] = await backfillExpiry(timeframe);
    }

    // Remove rows that are now known to be outside retention immediately rather
    // than waiting for MongoDB's asynchronous TTL monitor.
    const deletedExpired = await deleteInBatches(
      { expiresAt: { $ne: null, $lte: new Date() } },
      'expired',
    );

    await Candle.createIndexes();
    console.log(JSON.stringify({
      deletedProviderBackfills,
      deletedSynthetic,
      deletedExpired,
      deletedNonRetained,
      expiryBackfilled: expiry,
    }, null, 2));
    console.log('MongoDB TTL cleanup is asynchronous; expired retained candles may take a short time to disappear.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
