'use strict';
// Synthetic sizing probe, not a Railway cost measurement.
// npm run alerts:stage2:benchmark
const { quotePayload, position } = require('../src/modules/alerts/alert-event-contract');
const { BATCH_SIZE, FLUSH_MS } = require('../src/modules/alerts/alert-journal');

const SAMPLE = 1000;
const streamId = 'twelve-data:XAUUSD';
const events = Array.from({ length: SAMPLE }, (_, i) => ({
  ...quotePayload({
    symbol: 'XAUUSD', timeMs: 1795320000000 + 50 * i,
    receivedAtMs: 1795320000020 + 50 * i, providerTimestampMs: 1795320000000 + 50 * i,
    last: 4075.25 + (i % 17) / 100, bid: 4075.20 + (i % 17) / 100,
    ask: 4075.30 + (i % 17) / 100, source: 'twelve-data', isSyntheticSpread: true,
  }, 'twelve-data'),
  eventId: position(streamId, 1, i + 1),
  acceptedAtMs: 1795320000020 + 50 * i,
}));
const docs = [];
for (let i = 0; i < events.length; i += BATCH_SIZE) {
  const block = events.slice(i, i + BATCH_SIZE);
  docs.push({ streamId, generation: 1, firstSequence: i + 1,
    lastSequence: i + block.length, events: block,
    acceptedAt: '2026-11-22T00:00:00Z', expiresAt: '2026-11-22T12:00:00Z' });
}
const sampleBytes = docs.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
const perEvent = sampleBytes / SAMPLE;
const rates = [1, 5, 20, 100];
const retentionHours = Number(process.env.ACG_ALERTS_REPLAY_HOURS || 12);
const scenarios = rates.map(eventsPerSecond => ({
  eventsPerSecondPerStream: eventsPerSecond,
  streams: 1,
  estimatedUncompressedDataGiBForRetention: Number((perEvent * eventsPerSecond * 3600 * retentionHours / (1024 ** 3)).toFixed(3)),
  estimatedJournalBatchesPerSecond: Number(Math.min(eventsPerSecond / BATCH_SIZE + 1 / (FLUSH_MS / 1000),
    eventsPerSecond).toFixed(2)),
}));
process.stdout.write(JSON.stringify({
  kind: 'synthetic_not_live_measurement', sampleEvents: SAMPLE, sampleBatches: docs.length,
  sampleJsonBytes: sampleBytes, jsonBytesPerEvent: Number(perEvent.toFixed(2)),
  retentionHours, batchSize: BATCH_SIZE, flushMs: FLUSH_MS,
  caveats: ['JSON bytes are not BSON/storage-engine bytes', 'Index and transaction journal overhead excluded',
    'Rates are scenarios, not observations from Railway', 'Must measure live market event rates, Mongo writes, disk and CPU in staging'],
  scenarios,
}, null, 2) + '\n');
