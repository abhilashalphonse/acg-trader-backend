'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const HOUR_MS = 3600000;
const COUNTERS = ['evaluations', 'allowed', 'blocked', 'wouldBlock', 'newsWouldBlock', 'weekendWouldBlock', 'calendarUnavailable', 'calendarGrace', 'evaluationErrors'];
const LATENCY_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, null];
const LATENCY_KEYS = LATENCY_BOUNDS_MS.map((_, i) => `latency${i}`);
const SUM_FIELDS = [...COUNTERS, ...LATENCY_KEYS];
const ACTIONS = new Set(['OPEN_EXPOSURE', 'MARKET_OPEN', 'PENDING_CREATE', 'STOP_LIMIT_ACTIVATE', 'PENDING_TRIGGER', 'PENDING_AMEND_INCREASE', 'POSITION_REVERSE']);
const schema = new mongoose.Schema({
  _id: String,
  tenantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  bucketStart: { type: Date, required: true },
  stage: { type: String, enum: ['PREVIEW', 'EXECUTION'], required: true },
  action: { type: String, required: true },
  ...Object.fromEntries(SUM_FIELDS.map(key => [key, { type: Number, default: 0, min: 0 }])),
  updatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ tenantId: 1, bucketStart: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const PolicyMetricBucket = mongoose.models.PolicyMetricBucket || mongoose.model('PolicyMetricBucket', schema);

// Absolute counters per process/hour make retries after uncertain Mongo acknowledgements
// idempotent. No database I/O runs on the policy evaluation path.
class PolicyMetricsService {
  constructor({ model = PolicyMetricBucket, now = Date.now, logger, maxGroups = 1000, flushIntervalMs = 5000 } = {}) {
    Object.assign(this, { model, now, logger, maxGroups, flushIntervalMs });
    this.instanceId = crypto.randomUUID();
    this.groups = new Map();
    this.work = null;
    this.timer = null;
    this.dropped = 0;
    this.lastError = null;
    this.lastFlushedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.timer.unref?.();
  }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    await this.work;
    await this.flush();
  }
  health() {
    return { bufferedGroups: this.groups.size, dropped: this.dropped, lastError: this.lastError, lastFlushedAt: this.lastFlushedAt };
  }

  observe({ tenantId, stage = 'PREVIEW', action = 'OPEN_EXPOSURE', decision, error = false, latencyMs }) {
    const tenant = String(tenantId || '');
    if (!/^[a-fA-F0-9]{24}$/.test(tenant)) { this.dropped++; return; }
    const bucketStart = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
    action = ACTIONS.has(action) ? action : 'OTHER';
    stage = stage === 'EXECUTION' ? stage : 'PREVIEW';
    const id = `${this.instanceId}:${tenant}:${bucketStart}:${stage}:${action}`;
    let group = this.groups.get(id);
    if (!group) {
      if (this.groups.size >= this.maxGroups) { this.dropped++; return; }
      group = { _id: id, tenantId: tenant, bucketStart: new Date(bucketStart), stage, action,
        ...Object.fromEntries(SUM_FIELDS.map(key => [key, 0])), revision: 0, persistedRevision: 0,
        expiresAt: new Date(bucketStart + 180 * 86400000) };
      this.groups.set(id, group);
    }
    group.evaluations++;
    group.evaluationErrors += Number(error);
    if (!error) {
      group.allowed += Number(decision.allowed === true);
      group.blocked += Number(decision.allowed === false);
      group.wouldBlock += Number(decision.wouldBlock === true);
      group.newsWouldBlock += Number(decision.decisions?.some(item => item.kind === 'NEWS') === true);
      group.weekendWouldBlock += Number(decision.decisions?.some(item => item.kind === 'WEEKEND') === true);
      group.calendarUnavailable += Number(['UNAVAILABLE', 'EXPIRED'].includes(decision.status?.news?.dataStatus));
      group.calendarGrace += Number(decision.status?.news?.dataStatus === 'VALID_GRACE');
    }
    const duration = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : Infinity;
    const index = LATENCY_BOUNDS_MS.findIndex(bound => bound === null || duration <= bound);
    group[LATENCY_KEYS[index]]++;
    group.updatedAt = new Date(this.now());
    group.revision++;
  }

  flush() {
    if (this.work) return this.work;
    this.work = this.#flush().finally(() => { this.work = null; });
    return this.work;
  }
  async #flush() {
    try {
      const pending = [...this.groups.values()].filter(group => group.revision !== group.persistedRevision);
      for (let offset = 0; offset < pending.length; offset += 100) {
        const snapshots = pending.slice(offset, offset + 100).map(group => ({ ...group }));
        await this.model.bulkWrite(snapshots.map(({ _id, revision, persistedRevision, ...data }) => ({
          updateOne: { filter: { _id }, update: { $set: data }, upsert: true },
        })), { ordered: false, maxTimeMS: 5000 });
        for (const snapshot of snapshots) {
          const group = this.groups.get(snapshot._id);
          group.persistedRevision = snapshot.revision;
        }
      }
      const currentHour = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
      for (const [id, group] of this.groups) {
        if (group.bucketStart.getTime() < currentHour && group.revision === group.persistedRevision) this.groups.delete(id);
      }
      this.lastError = null;
      this.lastFlushedAt = new Date(this.now()).toISOString();
      return true;
    } catch (error) {
      this.lastError = String(error.code || error.message);
      this.logger?.warn?.({ err: error }, 'Policy metrics flush failed');
      return false;
    }
  }

  async summary(tenantId, { hours = 24 } = {}) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new RangeError('hours must be between 1 and 168');
    const nowMs = this.now();
    const from = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS);
    const rows = await this.model.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(String(tenantId)), bucketStart: { $gte: from, $lte: new Date(nowMs) } } },
      { $group: { _id: { stage: '$stage', action: '$action' },
        ...Object.fromEntries(SUM_FIELDS.map(key => [key, { $sum: `$${key}` }])), updatedAt: { $max: '$updatedAt' } } },
      { $sort: { '_id.stage': 1, '_id.action': 1 } },
    ]).option({ maxTimeMS: 5000 });
    return { from: from.toISOString(), to: new Date(nowMs).toISOString(), retentionDays: 180, flushIntervalMs: this.flushIntervalMs,
      scope: 'Policy evaluations, including retries; PREVIEW and EXECUTION are separate. Allowed does not mean a committed fill. Buffered observations can be lost on process termination.',
      groups: rows.map(row => ({ stage: row._id.stage, action: row._id.action,
        ...Object.fromEntries(COUNTERS.map(key => [key, row[key] || 0])), updatedAt: row.updatedAt,
        latency: latencySummary(row) })) };
  }
}

function latencySummary(row) {
  const counts = LATENCY_KEYS.map(key => row[key] || 0);
  const samples = counts.reduce((sum, count) => sum + count, 0);
  const percentile = ratio => {
    if (!samples) return null;
    const rank = Math.ceil(samples * ratio);
    let cumulative = 0;
    for (let i = 0; i < counts.length; i++) {
      cumulative += counts[i];
      if (cumulative >= rank) return LATENCY_BOUNDS_MS[i] === null ? { greaterThanMs: 1000 } : { upperBoundMs: LATENCY_BOUNDS_MS[i] };
    }
    return null;
  };
  return { samples, p95: percentile(0.95), p99: percentile(0.99), buckets: counts.map((count, i) => ({ upperBoundMs: LATENCY_BOUNDS_MS[i], count })) };
}
module.exports = { PolicyMetricsService, PolicyMetricBucket, latencySummary };
