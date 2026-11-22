'use strict';
const SCHEMA_VERSION = 1;
function streamIdFor(feedId, symbol) {
  const feed = String(feedId || '').trim().toLowerCase();
  const normalized = String(symbol || '').replace('/', '').trim().toUpperCase();
  if (!/^[a-z0-9-]+$/.test(feed) || !/^[A-Z0-9._-]+$/.test(normalized)) {
    throw new Error('A canonical feed and instrument are required');
  }
  return feed + ':' + normalized;
}
function position(streamId, generation, sequence) {
  return streamId + '#' + generation + ':' + sequence;
}
function parsePosition(eventId) {
  const matched = /^(.+)#(\d+):(\d+)$/.exec(String(eventId || ''));
  if (!matched) throw new Error('Invalid durable event position');
  return { streamId: matched[1], generation: Number(matched[2]), sequence: Number(matched[3]) };
}
function comparePositions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const first = typeof a === 'string' ? parsePosition(a) : a;
  const second = typeof b === 'string' ? parsePosition(b) : b;
  if (first.streamId !== second.streamId) throw new Error('Cannot compare different streams');
  return Math.sign(first.generation - second.generation) || Math.sign(first.sequence - second.sequence);
}
function quotePayload(tick, feedId) {
  const streamId = streamIdFor(feedId, tick.symbol);
  const asText = value => value == null || value === '' ? null : String(value);
  return {
    schemaVersion: SCHEMA_VERSION, kind: 'quote', streamId, symbol: String(tick.symbol).toUpperCase(),
    feedId, marketTimeMs: Number(tick.timeMs), receivedAtMs: Number(tick.receivedAtMs),
    source: tick.source || feedId, providerTimestampMs: tick.providerTimestampMs ?? null,
    prices: { bid: asText(tick.bid), ask: asText(tick.ask), last: asText(tick.last) },
    quality: tick.source?.includes('rest') ? 'RECOVERED_SNAPSHOT' : 'LIVE',
    qualityMetadata: { syntheticBidAsk: tick.isSyntheticSpread === true, quoteOnly: false },
  };
}
function candlePayload(candle, feedId) {
  return {
    schemaVersion: SCHEMA_VERSION, kind: 'candle_closed',
    streamId: streamIdFor(feedId, candle.symbol),
    symbol: String(candle.symbol).toUpperCase(), feedId, timeframe: candle.timeframe,
    marketTimeMs: Number(candle.closeTimeMs), receivedAtMs: Date.now(),
    close: String(candle.close), open: String(candle.open), high: String(candle.high),
    low: String(candle.low), complete: candle.complete === true, synthetic: candle.synthetic === true,
    source: candle.source || 'ACG_CANDLE_ENGINE', quality: 'ACG_FINALISED',
  };
}
function gapPayload(streamId, reason, at = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION, kind: 'coverage_gap', streamId,
    marketTimeMs: at, receivedAtMs: at, quality: 'GAP', reason: String(reason || 'UNKNOWN'),
  };
}
module.exports = { SCHEMA_VERSION, streamIdFor, position, parsePosition, comparePositions, quotePayload, candlePayload, gapPayload };
