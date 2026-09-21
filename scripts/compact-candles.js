'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { Candle } = require('../src/modules/market-data/candle.model');
const { candleExpiresAt, CANDLE_RETENTION_MS } = require('../src/modules/market-data/candle-retention');

const DEFAULT_PERSIST = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const DURABLE_PERSIST = new Set(DEFAULT_PERSIST);
const BATCH_SIZE = 5000;
const SYNTHETIC_HIGHER_TIMEFRAMES = ['1h', '4h', '1d', '1w'];

function persistedTimeframes() {
  const raw = String(process.env.MARKET_PERSIST_TIMEFRAMES || DEFAULT_PERSIST.join(','));
  return [...new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(value => DURABLE_PERSIST.has(value)))];
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

async function backfillExpiry(timeframe) {
  if (!Number.isFinite(CANDLE_RETENTION_MS[timeframe])) return 0;
  let updated = 0;
  while (true) {
    const rows = await Candle.find({
      timeframe,
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
    const syntheticHigherFilter = { synthetic: true, timeframe: { $in: SYNTHETIC_HIGHER_TIMEFRAMES } };
    const nonRetained = await Candle.countDocuments(nonRetainedFilter);
    const syntheticHigherTimeframeCandles = await Candle.countDocuments(syntheticHigherFilter);
    const total = await Candle.estimatedDocumentCount();

    console.log(JSON.stringify({
      mode: apply ? 'APPLY' : 'DRY_RUN',
      totalCandles: total,
      retainedTimeframes: retained,
      nonRetainedCandles: nonRetained,
      syntheticHigherTimeframeCandles,
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
      console.log('Dry run only. Re-run with --apply to delete synthetic H1/H4/D1/W1 candles, delete non-retained candles, and backfill TTL expiry.');
      return;
    }

    const deletedSyntheticHigherTimeframes = await deleteInBatches(syntheticHigherFilter, 'synthetic higher-timeframe');
    const deleted = await deleteInBatches(nonRetainedFilter, 'non-retained');
    const expiry = {};
    for (const timeframe of retained) {
      expiry[timeframe] = await backfillExpiry(timeframe);
    }

    await Candle.createIndexes();
    console.log(JSON.stringify({ deletedSyntheticHigherTimeframes, deleted, expiryBackfilled: expiry }, null, 2));
    console.log('MongoDB TTL cleanup is asynchronous; expired retained candles may take a short time to disappear.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
