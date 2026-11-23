'use strict';
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Candle } = require('../market-data/candle.model');
const { candleExpiresAt } = require('../market-data/candle-retention');
const { MarketBatch, StreamCoverage } = require('./alert-models');
const { position, gapPayload } = require('./alert-event-contract');

const CAPTURE_LEASE_MS = 15000;
const CAPTURE_RENEW_MS = 4000;
const MAX_PENDING = 4096;
const BATCH_SIZE = 128;
const FLUSH_MS = 500;
// Shadow default. Revisit only after measuring Railway write and retention costs.
const requestedRetention = Number(process.env.ACG_ALERTS_REPLAY_HOURS || 12);
const REPLAY_RETENTION_HOURS = Number.isFinite(requestedRetention)
  ? Math.min(48, Math.max(2, requestedRetention)) : 12;

function candleUpdate(event, session) {
  const openTime = new Date(event.openTimeMs);
  return Candle.updateOne(
    { symbol: event.symbol, timeframe: event.timeframe, openTime },
    {
      $set: {
        closeTime: new Date(event.marketTimeMs), open: event.open, high: event.high,
        low: event.low, close: event.close, complete: true, synthetic: false,
        source: event.source || 'LIVE', provider: event.feedId,
        expiresAt: candleExpiresAt(event.timeframe, event.openTimeMs),
      },
      $setOnInsert: { symbol: event.symbol, timeframe: event.timeframe, openTime, tickCount: 0 },
    },
    { upsert: true, session },
  );
}

class DurableAlertStream {
  constructor({ streamId, logger = null, maxPending = MAX_PENDING, batchSize = BATCH_SIZE,
    ownerId = crypto.randomUUID(), leaseTtlMs = CAPTURE_LEASE_MS,
    coverageModel = StreamCoverage }) {
    this.streamId = streamId;
    this.logger = logger;
    this.ownerId = ownerId;
    this.coverageModel = coverageModel;
    this.leaseTtlMs = leaseTtlMs;
    this.captureToken = null;
    this.superseded = false;
    this.standby = false;
    this.leaseTimer = null;
    this.maxPending = maxPending;
    this.batchSize = batchSize;
    this.buffer = [];
    this.generation = 0;
    this.sequence = 0;
    this.running = false;
    this.flushing = null;
    this.restartPromise = null;
    this.broken = false;
    this.timer = null;
    this.lastError = null;
    this.acceptedEvents = 0;
    this.acceptedBatches = 0;
  }

  async start(reason = 'CAPTURE_STARTED') {
    if (this.running || this.superseded) return this.running;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseTtlMs);
    const previousGeneration = this.generation;
    const previousToken = this.captureToken;
    // Initialize the coverage record independently. Mongo/Mongoose must not
    // turn an $exists predicate from an upsert filter into a Date field value.
    // A unique _id guarantees two new capture instances cannot create two rows.
    if (previousToken == null) {
      await this.coverageModel.updateOne(
        { _id: this.streamId },
        { $setOnInsert: {
          generation: 0, captureToken: 0, captureOwnerId: null,
          captureLeaseUntil: null, status: 'STOPPED', lastSequence: 0,
        } },
        { upsert: true },
      );
    }
    const conditions = previousToken == null
      ? [ { captureLeaseUntil: { $lte: now } }, { captureLeaseUntil: null } ]
      : [ { captureOwnerId: this.ownerId, captureToken: previousToken,
          generation: previousGeneration } ];
    let coverage;
    try {
      coverage = await this.coverageModel.findOneAndUpdate(
        { _id: this.streamId, $or: conditions },
        {
          $inc: { generation: 1, captureToken: 1 },
          $set: {
            captureOwnerId: this.ownerId, captureLeaseUntil: leaseUntil,
            status: 'STARTING', lastReason: reason, lastSequence: 0,
          },
        },
        { new: true, upsert: false },
      ).lean();
    } catch (error) {
      // A concurrent owner/duplicate-id race is a lease miss, not a reason
      // to rotate the generation or crash the capture process.
      if (error.code !== 11000) throw error;
      coverage = null;
    }
    if (!coverage) {
      // A competing capture owns the still-valid lease. Do not rotate its
      // generation; a previously fenced owner must never reclaim it.
      if (previousToken != null) this.standDown('CAPTURE_LEASE_SUPERSEDED');
      else this.standby = true;
      return false;
    }
    this.generation = coverage.generation;
    this.captureToken = coverage.captureToken;
    this.sequence = 0;
    this.running = true;
    this.broken = false;
    this.standby = false;
    this.buffer = [gapPayload(this.streamId, reason)];
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, FLUSH_MS);
    this.timer.unref?.();
    this.leaseTimer = setInterval(() => {
      void this.renewLease().catch(error => {
        this.logger?.error?.({ err: error, streamId: this.streamId }, 'Capture lease renewal failed');
        this.interrupt('CAPTURE_LEASE_RENEWAL_FAILED');
      });
    }, CAPTURE_RENEW_MS);
    this.leaseTimer.unref?.();
    return true;
  }

  standDown(reason = 'CAPTURE_LEASE_SUPERSEDED') {
    this.superseded = true;
    this.standby = false;
    this.running = false;
    this.broken = true;
    this.buffer = [];
    this.lastError = reason;
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.leaseTimer = null;
  }

  async renewLease() {
    if (!this.running || this.superseded || this.captureToken == null) return false;
    const now = new Date();
    const result = await this.coverageModel.updateOne({
      _id: this.streamId, generation: this.generation,
      captureOwnerId: this.ownerId, captureToken: this.captureToken,
      captureLeaseUntil: { $gt: now },
    }, { $set: { captureLeaseUntil: new Date(now.getTime() + this.leaseTtlMs) } });
    if (result.matchedCount !== 1) {
      this.standDown('CAPTURE_LEASE_SUPERSEDED');
      return false;
    }
    return true;
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
    if (this.broken || this.superseded) return;
    this.broken = true;
    this.buffer = [];
    this.lastError = reason;
    void this.coverageModel.updateOne({
      _id: this.streamId, generation: this.generation,
      captureOwnerId: this.ownerId, captureToken: this.captureToken,
    }, { $set: { status: 'INTERRUPTED', lastReason: reason } }).catch(() => {});
  }

  async restart(reason = 'RECOVERED_AFTER_GAP') {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      if (this.superseded) return false;
      if (this.flushing) await this.flushing.catch(() => {});
      if (this.timer) clearInterval(this.timer);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.running = false;
      this.broken = false;
      return this.start(reason);
    })().finally(() => { this.restartPromise = null; });
    return this.restartPromise;
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
      expiresAt: new Date(acceptedAtMs + REPLAY_RETENTION_HOURS * 60 * 60 * 1000),
    };
    const candles = entries.filter(event => event.kind === 'candle_closed' && !event.synthetic && event.complete);
    const hasBaseline = entries.some(event => event.kind === 'quote');
    // Serialised batches are committed with a conditional generation write.
    // A superseded capture process cannot accept old-generation events after takeover.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const ownership = await this.coverageModel.updateOne({
          _id: this.streamId, generation, status: { $in: ['STARTING', 'MONITORING'] },
          captureOwnerId: this.ownerId, captureToken: this.captureToken,
          captureLeaseUntil: { $gt: new Date() },
        }, { $set: {
          lastSequence: batch.lastSequence, lastEventAt: new Date(acceptedAtMs),
          ...(hasBaseline ? { status: 'MONITORING', lastReason: null } : {}),
        } }, { session });
        if (ownership.matchedCount !== 1) throw new Error('ALERT_CAPTURE_FENCED_OR_INTERRUPTED');
        for (const candle of candles) await candleUpdate(candle, session);
        await MarketBatch.create([batch], { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally {
      await session.endSession();
    }
    this.sequence = batch.lastSequence;
    this.acceptedEvents += entries.length;
    this.acceptedBatches += 1;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.leaseTimer = null;
    // Only this process's own capture can flush and release its lease.
    if (this.running && !this.superseded) {
      while (this.buffer.length && !this.broken) {
        if (this.flushing) await this.flushing.catch(() => {});
        else await this.flush().catch(() => {});
      }
      if (this.flushing) await this.flushing.catch(() => {});
      await this.coverageModel.updateOne({
        _id: this.streamId, generation: this.generation,
        captureOwnerId: this.ownerId, captureToken: this.captureToken,
      }, { $set: { status: 'STOPPED', lastReason: 'CAPTURE_STOPPED',
        captureLeaseUntil: new Date(0) } });
    }
    this.running = false;
  }

}

module.exports = { DurableAlertStream, MAX_PENDING, BATCH_SIZE, FLUSH_MS,
  CAPTURE_LEASE_MS, CAPTURE_RENEW_MS };
