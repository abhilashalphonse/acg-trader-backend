'use strict';
const mongoose = require('mongoose');
const { Candle } = require('../market-data/candle.model');
const { MarketBatch, StreamCoverage } = require('./alert-models');
const { position, gapPayload } = require('./alert-event-contract');

const MAX_PENDING = 4096;
const BATCH_SIZE = 64;
const FLUSH_MS = 125;

function candleUpdate(event, session) {
  const openTime = new Date(event.marketTimeMs - require('../market-data/market.constants').TIMEFRAME_MS[event.timeframe]);
  return Candle.updateOne(
    { symbol: event.symbol, timeframe: event.timeframe, openTime },
    {
      $set: {
        closeTime: new Date(event.marketTimeMs), open: event.open, high: event.high,
        low: event.low, close: event.close, complete: true, synthetic: false,
        source: event.source || 'LIVE', provider: event.feedId, 
      },
      $setOnInsert: { symbol: event.symbol, timeframe: event.timeframe, openTime, tickCount: 0 },
    },
    { upsert: true, session },
  );
}

class DurableAlertStream {
  constructor({ streamId, logger = null, maxPending = MAX_PENDING, batchSize = BATCH_SIZE }) {
    this.streamId = streamId;
    this.logger = logger;
    this.maxPending = maxPending;
    this.batchSize = batchSize;
    this.buffer = [];
    this.generation = 0;
    this.sequence = 0;
    this.running = false;
    this.flushing = null;
    this.broken = false;
    this.timer = null;
    this.lastError = null;
    this.acceptedEvents = 0;
    this.acceptedBatches = 0;
  }

  async start(reason = 'CAPTURE_STARTED') {
    if (this.running) return;
    const coverage = await StreamCoverage.findOneAndUpdate(
      { _id: this.streamId },
      {
        $inc: { generation: 1 },
        $set: { status: 'STARTING', lastReason: reason, lastSequence: 0 },
      },
      { new: true, upsert: true },
    ).lean();
    this.generation = coverage.generation;
    this.sequence = 0;
    this.running = true;
    this.broken = false;
    this.buffer = [gapPayload(this.streamId, reason)];
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, FLUSH_MS);
    this.timer.unref?.();
  }

  accept(event) {
    if (!this.running || this.broken) return false;
    if (!event || event.streamId !== this.streamId) return false;
    if (this.buffer.length >= this.maxPending) {
      this.interrupt('CAPTURE_BUFFER_OVERFLOW');
      return false;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize || event.kind === 'candle_closed') {
      void this.flush().catch(() => {});
    }
    return true; // queued, NOT yet durably accepted
  }

  interrupt(reason) {
    if (this.broken) return;
    this.broken = true;
    this.buffer = [];
    this.lastError = reason;
    void StreamCoverage.updateOne(
      { _id: this.streamId, generation: this.generation },
      { $set: { status: 'INTERRUPTED', lastReason: reason } },
    ).catch(() => {});
  }

  async restart(reason = 'RECOVERED_AFTER_GAP') {
    if (this.flushing) await this.flushing.catch(() => {});
    if (this.timer) clearInterval(this.timer);
    this.running = false;
    this.broken = false;
    return this.start(reason);
  }

  async flush() {
    if (!this.running || this.broken || this.flushing || !this.buffer.length) return this.flushing;
    const records = this.buffer.splice(0, this.batchSize);
    this.flushing = this.persist(records)
      .catch(error => {
        this.logger?.error?.({ err: error, streamId: this.streamId }, 'Alert journal persistence failed; monitoring interrupted');
        this.interrupt('DATABASE_WRITE_FAILURE');
        throw error;
      })
      .finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async persist(records) {
    const generation = this.generation;
    const start = this.sequence + 1;
    const acceptedAtMs = Date.now();
    const entries = records.map((event, index) => ({
      ...event,
      eventId: position(this.streamId, generation, start + index),
      acceptedAtMs,
    }));
    const batch = {
      streamId: this.streamId, generation, firstSequence: start,
      lastSequence: start + entries.length - 1, events: entries,
      acceptedAt: new Date(acceptedAtMs),
    };
    const candles = entries.filter(event => event.kind === 'candle_closed' && !event.synthetic && event.complete);
    if (candles.length) {
      // The alert candle and its replay event become visible in the same transaction.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const candle of candles) await candleUpdate(candle, session);
          await MarketBatch.create([batch], { session });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally {
        await session.endSession();
      }
    } else {
      await MarketBatch.collection.insertOne(batch, { writeConcern: { w: 'majority' } });
    }
    this.sequence = batch.lastSequence;
    this.acceptedEvents += entries.length;
    this.acceptedBatches += 1;
    const hasBaseline = entries.some(event => event.kind === 'quote');
    try {
      await StreamCoverage.updateOne(
        { _id: this.streamId, generation },
        { $set: { lastSequence: this.sequence, lastEventAt: new Date(acceptedAtMs),
          ...(hasBaseline ? { status: 'MONITORING', lastReason: null } : {}) } },
      );
    } catch (error) {
      // A coverage status write failure must never make uncommitted events accepted.
      this.logger?.warn?.({ err: error, streamId: this.streamId }, 'Alert coverage status update failed');
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.buffer.length && !this.broken) {
      if (this.flushing) await this.flushing.catch(() => {});
      else await this.flush().catch(() => {});
    }
    if (this.flushing) await this.flushing.catch(() => {});
    this.running = false;
    await StreamCoverage.updateOne(
      { _id: this.streamId, generation: this.generation },
      { $set: { status: 'STOPPED', lastReason: 'NO_MONITORED_RULES' } },
    );
  }
}

module.exports = { DurableAlertStream, MAX_PENDING, BATCH_SIZE, FLUSH_MS };
