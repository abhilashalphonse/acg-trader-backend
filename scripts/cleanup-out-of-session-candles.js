'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { Candle } = require('../src/modules/market-data/candle.model');
const { Instrument } = require('../src/modules/instruments/instrument.model');
const { isInstrumentSessionOpen, candleOverlapsInstrumentSession } = require('../src/modules/instruments/session-calendar');
const { TIMEFRAME_MS } = require('../src/modules/market-data/market.constants');

const BATCH_SIZE = 1000;

function requestedSymbols() {
  const arg = process.argv.find(value => value.startsWith('--symbols=') || value.startsWith('--symbol='));
  if (!arg) return null;
  const value = arg.slice(arg.indexOf('=') + 1);
  const symbols = value.split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  return symbols.length ? new Set(symbols) : null;
}

function summaryKey(row) {
  return `${row.timeframe || 'unknown'}:${row.source || 'unknown'}`;
}

function candleCloseTimeMs(row, openTimeMs) {
  const stored = new Date(row?.closeTime).getTime();
  if (Number.isFinite(stored) && stored > openTimeMs) return stored;
  const stepMs = TIMEFRAME_MS[row?.timeframe];
  if (Number.isFinite(stepMs) && stepMs > 0) return openTimeMs + stepMs;
  return null;
}

async function deleteIds(ids) {
  if (!ids.length) return 0;
  const result = await Candle.deleteMany({ _id: { $in: ids } });
  return Number(result.deletedCount || 0);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const symbols = requestedSymbols();
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  try {
    const docs = await Instrument.find(symbols ? { symbol: { $in: [...symbols] } } : {})
      .select('symbol status timezone tradingSessions tradingHolidays')
      .sort({ symbol: 1 })
      .lean();

    const instruments = docs.filter(item => Array.isArray(item.tradingSessions) && item.tradingSessions.length > 0);
    const summary = {
      mode: apply ? 'APPLY' : 'DRY_RUN',
      instrumentsScanned: instruments.length,
      candlesScanned: 0,
      outOfSessionCandles: 0,
      deletedCandles: 0,
      bySymbol: {},
    };

    for (const instrument of instruments) {
      // Historical cleanup is based on the configured calendar, not the
      // instrument's current operational status. A presently HALTED symbol
      // must not make every historical candle look invalid.
      const calendarInstrument = { ...instrument, status: 'ACTIVE' };
      const byBucket = {};
      let scanned = 0;
      let candidates = 0;
      let deleted = 0;
      let boundaryOverlapsPreserved = 0;
      let pendingDeleteIds = [];
      const sampleCandidates = [];
      const samplePreservedBoundaryCandles = [];

      const cursor = Candle.find({ symbol: instrument.symbol })
        .select('_id openTime closeTime timeframe source synthetic')
        .sort({ _id: 1 })
        .lean()
        .cursor({ batchSize: BATCH_SIZE });

      for await (const row of cursor) {
        scanned += 1;
        summary.candlesScanned += 1;

        const openTimeMs = new Date(row.openTime).getTime();
        if (!Number.isFinite(openTimeMs) || isInstrumentSessionOpen(calendarInstrument, openTimeMs)) continue;

        const closeTimeMs = candleCloseTimeMs(row, openTimeMs);
        if (candleOverlapsInstrumentSession(calendarInstrument, openTimeMs, closeTimeMs)) {
          boundaryOverlapsPreserved += 1;
          if (samplePreservedBoundaryCandles.length < 5) {
            samplePreservedBoundaryCandles.push({
              timeframe: row.timeframe,
              source: row.source || null,
              openTime: new Date(openTimeMs).toISOString(),
              closeTime: Number.isFinite(closeTimeMs) ? new Date(closeTimeMs).toISOString() : null,
            });
          }
          continue;
        }

        candidates += 1;
        summary.outOfSessionCandles += 1;
        const key = summaryKey(row);
        byBucket[key] = (byBucket[key] || 0) + 1;
        if (sampleCandidates.length < 8) {
          sampleCandidates.push({
            timeframe: row.timeframe,
            source: row.source || null,
            openTime: new Date(openTimeMs).toISOString(),
            closeTime: Number.isFinite(closeTimeMs) ? new Date(closeTimeMs).toISOString() : null,
          });
        }

        if (apply) {
          pendingDeleteIds.push(row._id);
          if (pendingDeleteIds.length >= BATCH_SIZE) {
            const removed = await deleteIds(pendingDeleteIds);
            deleted += removed;
            summary.deletedCandles += removed;
            pendingDeleteIds = [];
          }
        }
      }

      if (apply && pendingDeleteIds.length) {
        const removed = await deleteIds(pendingDeleteIds);
        deleted += removed;
        summary.deletedCandles += removed;
      }

      if (candidates > 0) {
        summary.bySymbol[instrument.symbol] = {
          scanned,
          candidates,
          deleted,
          boundaryOverlapsPreserved,
          timezone: instrument.timezone || 'UTC',
          byTimeframeAndSource: byBucket,
          sampleCandidates,
          samplePreservedBoundaryCandles,
        };
      }

      process.stdout.write(
        `${instrument.symbol}: scanned=${scanned} fullyClosed=${candidates} boundaryPreserved=${boundaryOverlapsPreserved}${apply ? ` deleted=${deleted}` : ''}\n`,
      );
    }

    console.log(JSON.stringify(summary, null, 2));
    if (!apply) {
      console.log('Dry run only. Re-run with --apply after reviewing the candidate counts.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { candleCloseTimeMs, candleOverlapsOpenSession: candleOverlapsInstrumentSession };
