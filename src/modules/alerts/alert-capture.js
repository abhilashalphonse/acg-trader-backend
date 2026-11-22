'use strict';
const { AlertRule } = require('./alert-models');
const { DurableAlertStream } = require('./alert-journal');
const { streamIdFor, quotePayload, candlePayload } = require('./alert-event-contract');

function createAlertCapture({ marketRuntime, logger, refreshMs = 5000 }) {
  const streams = new Map();
  const bus = marketRuntime.eventBus;
  let started = false;
  let timer = null;
  let refreshing = false;

  function feedFor(symbol) {
    const instrument = marketRuntime.instrumentRegistry.get(symbol);
    return instrument?.provider || 'twelve-data';
  }

  function onQuote(tick) {
    // Only accepted in-session market ticks: never feed REST snapshots into crossings.
    let streamId, event;
    try {
      streamId = streamIdFor(feedFor(tick.symbol), tick.symbol);
      event = quotePayload(tick, feedFor(tick.symbol));
    } catch (error) {
      logger?.warn?.({ err: error }, 'Rejected malformed alert input');
      return;
    }
    const stream = streams.get(streamId);
    if (!stream) return;
    if (stream.broken) { void stream.restart('RECOVERY_AFTER_INTERRUPTION').catch(() => {}); return; }
    stream.accept(event);
  }

  function onCandle(candle) {
    if (candle.synthetic || candle.complete !== true) return;
    try {
      const streamId = streamIdFor(feedFor(candle.symbol), candle.symbol);
      streams.get(streamId)?.accept(candlePayload(candle, feedFor(candle.symbol)));
    } catch (error) {
      logger?.warn?.({ err: error }, 'Rejected malformed alert candle');
    }
  }

  function onCorrection(candle) {
    try {
      const streamId = streamIdFor(feedFor(candle.symbol), candle.symbol);
      streams.get(streamId)?.accept({
        kind: 'candle_corrected', schemaVersion: 1, streamId,
        marketTimeMs: Number(candle.closeTimeMs), receivedAtMs: Date.now(),
        timeframe: candle.timeframe, close: String(candle.close), quality: 'CORRECTED',
        reason: candle.reason || 'PROVIDER_CORRECTION',
      });
    } catch (error) {
      logger?.warn?.({ err: error }, 'Rejected malformed alert candle correction');
    }
  }

  function onStatus(status) {
    const state = String(status?.state || '').toUpperCase();
    if (!['DISCONNECTED','STALE','UNAVAILABLE','SUBSCRIPTION_ERROR','STOPPED','ERROR','DISABLED','CONNECTING'].includes(state)) return;
    if (status.scope === 'symbol' && status.symbol) {
      try { streams.get(streamIdFor(feedFor(status.symbol), status.symbol))?.interrupt('FEED_' + state); }
      catch { /* ignore unknown symbol */ }
      return;
    }
    if (status.scope === 'gateway' || status.scope === 'provider') {
      for (const stream of streams.values()) stream.interrupt('FEED_' + state);
    }
  }

  async function refreshActive() {
    if (refreshing) return;
    refreshing = true;
    try {
      const desired = new Set(await AlertRule.distinct('streamId', {
        status: { $in: ['STARTING','MONITORING'] },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }));
      for (const streamId of desired) {
        if (streams.has(streamId)) continue;
        const stream = new DurableAlertStream({ streamId, logger });
        await stream.start('CAPTURE_ACTIVATED_NO_PRIOR_COVERAGE');
        streams.set(streamId, stream);
      }
      for (const [streamId, stream] of streams) {
        if (desired.has(streamId)) continue;
        streams.delete(streamId);
        await stream.stop();
      }
    } catch (error) {
      logger?.error?.({ err: error }, 'Alert capture rule refresh failed');
      for (const stream of streams.values()) stream.interrupt('CAPTURE_RULE_REFRESH_FAILED');
    } finally {
      refreshing = false;
    }
  }

  return {
    async start() {
      if (started) return;
      // Register before market gateway starts; only shadow-flagged instances call here.
      bus.on('market.tick', onQuote);
      bus.on('market.candle.closed', onCandle);
      bus.on('market.candle.corrected', onCorrection);
      bus.on('market.status', onStatus);
      started = true;
      await refreshActive();
      timer = setInterval(() => { void refreshActive(); }, refreshMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      bus.off('market.tick', onQuote);
      bus.off('market.candle.closed', onCandle);
      bus.off('market.candle.corrected', onCorrection);
      bus.off('market.status', onStatus);
      for (const stream of streams.values()) await stream.stop();
      streams.clear();
    },
    refreshActive,
    health() {
      return { enabled: started, streams: [...streams].map(([id, stream]) => ({
        id, generation: stream.generation, buffered: stream.buffer.length, broken: stream.broken,
        acceptedEvents: stream.acceptedEvents, acceptedBatches: stream.acceptedBatches,
      })) };
    },
  };
}
module.exports = { createAlertCapture };
