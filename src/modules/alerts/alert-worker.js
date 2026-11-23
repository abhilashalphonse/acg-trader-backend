'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { AlertRule, MarketBatch, AlertTrigger, AlertOutbox, AlertLease,
  AlertReplayGap, StreamCoverage } = require('./alert-models');
const { evaluateAlert, emptyState } = require('./alert-evaluator');
const { comparePositions, gapPayload, position } = require('./alert-event-contract');

const LEASE_ID = 'stage2-alert-evaluator';
const LEASE_TTL_MS = 15000;

class AlertShadowWorker {
  constructor({ ownerId = crypto.randomUUID(), logger = null, leaseTtlMs = LEASE_TTL_MS,
    ruleModel = AlertRule } = {}) {
    this.ownerId = ownerId;
    this.logger = logger;
    this.leaseTtlMs = leaseTtlMs;
    this.ruleModel = ruleModel;
    this.token = null;
    this.processedBatches = 0;
    this.committedTriggers = 0;
    this.gapResets = 0;
    // Keyset pagination provides bounded, round-robin coverage for every rule.
    this.scanCursorId = null;
  }

  async acquireLease() {
    const now = new Date();
    try {
      const lease = await AlertLease.findOneAndUpdate(
        { _id: LEASE_ID, $or: [{ expiresAt: { $lte: now } }, { ownerId: this.ownerId }] },
        { $set: { ownerId: this.ownerId, expiresAt: new Date(now.getTime() + this.leaseTtlMs) },
          $inc: { token: 1 } },
        { new: true, upsert: true },
      ).lean();
      this.token = lease.token;
      return this.token;
    } catch (error) {
      if (error.code === 11000) return null; // lease held by another worker
      throw error;
    }
  }

  async renewLease() {
    if (this.token == null) return false;
    const now = new Date();
    const result = await AlertLease.updateOne(
      { _id: LEASE_ID, ownerId: this.ownerId, token: this.token, expiresAt: { $gt: now } },
      { $set: { expiresAt: new Date(now.getTime() + this.leaseTtlMs) } },
    );
    if (result.matchedCount !== 1) this.token = null;
    return result.matchedCount === 1;
  }

  async nextBatch(rule) {
    const cursor = rule.checkpoint;
    const filter = cursor ? {
      streamId: rule.streamId,
      $or: [
        { generation: { $gt: cursor.generation } },
        { generation: cursor.generation, lastSequence: { $gt: cursor.sequence } },
      ],
    } : { streamId: rule.streamId };
    return MarketBatch.findOne(filter).sort({ generation: 1, firstSequence: 1 }).lean();
  }

  // If all pending batches have expired, the durable capture watermark still
  // tells us which stream positions existed. Never pretend those ticks were
  // evaluated: atomically mark an unrecoverable gap and skip to the watermark.
  async handleUnavailableReplay(rule) {
    const coverage = await StreamCoverage.findById(rule.streamId).lean();
    if (!coverage || !Number.isInteger(coverage.generation) ||
      !Number.isInteger(coverage.lastSequence) || coverage.generation < 1 ||
      coverage.lastSequence < 1) return false;
    const cursor = rule.checkpoint || null;
    const watermark = { streamId: rule.streamId,
      generation: coverage.generation, sequence: coverage.lastSequence };
    if (cursor && comparePositions(watermark, cursor) <= 0) return false;
    const evidence = { eventId: position(rule.streamId, watermark.generation, watermark.sequence),
      reason: 'REPLAY_UNAVAILABLE_NO_RETAINED_BATCH', fromCursor: cursor,
      resumedAt: watermark };
    const runtime = { ...emptyState(), ...(rule.runtime || {}),
      baselineTicks: null, armed: true, monitoring: 'INTERRUPTED',
      lastCoverageGap: evidence, lastEventId: evidence.eventId,
      lastObservedMs: coverage.lastEventAt ? new Date(coverage.lastEventAt).getTime() : null };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const fence = await AlertLease.updateOne({
          _id: LEASE_ID, ownerId: this.ownerId, token: this.token,
          expiresAt: { $gt: new Date() },
        }, { $set: { lastFenceAt: new Date() } }, { session });
        if (fence.matchedCount !== 1) throw new Error('ALERT_LEASE_FENCED');
        const update = await this.ruleModel.updateOne({
          _id: rule._id, version: rule.version,
          status: { $in: ['STARTING','MONITORING'] }, checkpoint: cursor,
        }, { $set: { runtime, checkpoint: watermark, status: 'STARTING' } }, { session });
        if (update.matchedCount !== 1) throw new Error('ALERT_RULE_CHANGED_DURING_EVALUATION');
        await AlertReplayGap.create([{
          alertId: rule._id, tenantId: rule.tenantId, ownerId: rule.ownerId,
          streamId: rule.streamId, ruleVersion: rule.version, ...evidence,
        }], { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      this.gapResets += 1;
      return true;
    } finally {
      await session.endSession();
    }
  }

  async processRule(rule) {
    const batch = await this.nextBatch(rule);
    if (!batch) return this.handleUnavailableReplay(rule);
    const cursor = rule.checkpoint || null;
    let runtime = { ...emptyState(), ...(rule.runtime || {}) };
    const processed = [];
    const triggers = [];
    const gaps = [];
    const first = batch.events[0];
    const missingWithinGeneration = cursor
      ? cursor.generation === batch.generation && batch.firstSequence > cursor.sequence + 1
      : batch.firstSequence > 1;
    const unannouncedGeneration = cursor && cursor.generation !== batch.generation
      && first?.kind !== 'coverage_gap';
    if (missingWithinGeneration || unannouncedGeneration) {
      const gap = {
        ...gapPayload(rule.streamId, 'REPLAY_RETENTION_OR_SEQUENCE_GAP', first?.marketTimeMs || Date.now()),
        eventId: position(rule.streamId, batch.generation, Math.max(0, batch.firstSequence - 1)),
      };
      runtime = evaluateAlert(rule, runtime, gap).state;
      const evidence = { eventId: gap.eventId,
        reason: 'REPLAY_RETENTION_OR_SEQUENCE_GAP', fromCursor: cursor,
        resumedAt: { streamId: rule.streamId, generation: batch.generation, sequence: batch.firstSequence } };
      runtime.lastCoverageGap = evidence;
      gaps.push(evidence);
    }
    for (const event of batch.events) {
      const eventPos = { streamId: rule.streamId, generation: batch.generation,
        sequence: Number(event.eventId.split(':').pop()) };
      if (cursor && comparePositions(eventPos, cursor) <= 0) continue;
      // Retained events from older subscribers must never become retroactive alerts.
      const effectiveFromMs = new Date(rule.effectiveFrom || rule.createdAt).getTime();
      if (!Number.isFinite(effectiveFromMs)) throw new Error('ALERT_RULE_EFFECTIVE_FROM_REQUIRED');
      if (Number(event.acceptedAtMs) < effectiveFromMs) {
        processed.push(event); // checkpoint safely, but do not evaluate the old input
        continue;
      }
      const result = evaluateAlert(rule, runtime, event);
      runtime = result.state;
      if (event.kind === 'coverage_gap') {
        const evidence = { eventId: event.eventId, reason: String(event.reason || 'CAPTURE_INTERRUPTED'),
          fromCursor: cursor, resumedAt: eventPos };
        runtime.lastCoverageGap = evidence;
        gaps.push(evidence);
      }
      processed.push(event);
      if (result.trigger) triggers.push(result.trigger);
    }
    if (!processed.length) return false;
    const last = processed[processed.length - 1];
    const nextCursor = { streamId: rule.streamId, generation: batch.generation,
      sequence: Number(last.eventId.split(':').pop()) };
    const nextStatus = runtime.monitoring === 'COMPLETED' ? 'COMPLETED'
      : runtime.monitoring === 'EXPIRED' ? 'EXPIRED'
        : runtime.monitoring === 'MONITORING' ? 'MONITORING' : 'STARTING';

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // This is a WRITING fence inside the same transaction as rule+outbox.
        // A stale worker cannot commit after the new owner changes the token.
        const fenced = await AlertLease.updateOne({
          _id: LEASE_ID, ownerId: this.ownerId, token: this.token,
          expiresAt: { $gt: new Date() },
        }, { $set: { lastFenceAt: new Date() } }, { session });
        if (fenced.matchedCount !== 1) throw new Error('ALERT_LEASE_FENCED');
        const updated = await this.ruleModel.updateOne({
          _id: rule._id, version: rule.version,
          status: { $in: ['STARTING','MONITORING'] },
          checkpoint: cursor,
          // No wall-clock expiry predicate: durable observations received
          // before expiry remain eligible even when replay runs afterwards.
        }, { $set: { runtime, checkpoint: nextCursor, status: nextStatus } }, { session });
        if (updated.matchedCount !== 1) throw new Error('ALERT_RULE_CHANGED_DURING_EVALUATION');
        for (const evidence of gaps) {
          await AlertReplayGap.create([{ alertId: rule._id, tenantId: rule.tenantId,
            ownerId: rule.ownerId, streamId: rule.streamId, ruleVersion: rule.version,
            ...evidence }], { session });
        }
        for (const evidence of triggers) {
          const [trigger] = await AlertTrigger.create([{
            alertId: rule._id, tenantId: rule.tenantId, ownerId: rule.ownerId,
            ruleVersion: rule.version, eventId: evidence.eventId, evidence,
          }], { session });
          // No delivery channel is enabled during Stage 2.
          await AlertOutbox.create([{ triggerId: trigger._id, channel: 'shadow',
            status: 'PENDING', attempt: 0 }], { session });
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      this.processedBatches += 1;
      this.committedTriggers += triggers.length;
      this.gapResets += gaps.length;
      return true;
    } finally {
      await session.endSession();
    }
  }


  async pumpOnce({ maxRules = 200 } = {}) {
    if (!Number.isInteger(maxRules) || maxRules < 1) throw new Error('maxRules must be positive');
    if (this.token == null && await this.acquireLease() == null) return { ownsLease: false };
    if (!await this.renewLease()) return { ownsLease: false };

    const query = { status: { $in: ['STARTING', 'MONITORING'] } };
    if (this.scanCursorId) query._id = { $gt: this.scanCursorId };
    let rules = await this.ruleModel.find(query).sort({ _id: 1 }).limit(maxRules).lean();
    if (!rules.length && this.scanCursorId) {
      this.scanCursorId = null;
      rules = await this.ruleModel.find({ status: { $in: ['STARTING', 'MONITORING'] } })
        .sort({ _id: 1 }).limit(maxRules).lean();
    }
    let advanced = 0, conflicts = 0;
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      // Update the lease periodically during large scans, not just per batch.
      if (index % 10 === 0 && !await this.renewLease()) {
        return { ownsLease: false, checkedRules: index, advanced, conflicts };
      }
      try {
        if (await this.processRule(rule)) advanced += 1;
      } catch (error) {
        if (/ALERT_RULE_CHANGED_DURING_EVALUATION|ALERT_LEASE_FENCED|WriteConflict|duplicate key/i.test(String(error?.message))) {
          conflicts += 1;
        } else {
          this.logger?.error?.({ err: error, ruleId: String(rule._id) }, 'Shadow alert evaluation failed');
          throw error;
        }
      }
      this.scanCursorId = rule._id;
    }
    return { ownsLease: this.token != null, checkedRules: rules.length,
      advanced, conflicts, triggers: this.committedTriggers, gapResets: this.gapResets,
      scanCursor: String(this.scanCursorId || '') };
  }

}
module.exports = { AlertShadowWorker, LEASE_ID, LEASE_TTL_MS };
