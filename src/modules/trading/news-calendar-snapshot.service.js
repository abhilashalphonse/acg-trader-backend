'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { NewsCalendarSnapshot, NewsCalendarState } = require('./news-calendar-snapshot.model');
const DAY = 86400000;
const KEY = 'financecalendar-high-impact';

class NewsCalendarSnapshotService {
  constructor({ config, normalizeEvent, snapshotModel = NewsCalendarSnapshot, stateModel = NewsCalendarState,
    fetchImpl = globalThis.fetch, now = Date.now, logger = null }) {
    Object.assign(this, { config, normalizeEvent, snapshotModel, stateModel, fetch: fetchImpl, now, logger });
    this.owner = crypto.randomUUID();
    this.snapshot = null;
    this.inFlight = null;
    this.timer = null;
    this.lastError = null;
  }

  read(nowMs = this.now()) {
    const snapshot = this.snapshot;
    if (!snapshot) return { events: [], dataStatus: 'UNAVAILABLE', snapshotVersion: null, fetchedAt: null };
    const age = Math.max(0, nowMs - Date.parse(snapshot.fetchedAt));
    const covered = nowMs >= Date.parse(snapshot.coverageFrom) && nowMs < Date.parse(snapshot.coverageTo);
    const dataStatus = !covered ? 'EXPIRED' : age <= this.config.newsCalendarCacheTtlMs ? 'FRESH'
      : age <= this.config.newsCalendarStaleMaxMs ? 'VALID_GRACE' : 'EXPIRED';
    return { events: snapshot.events, dataStatus, snapshotVersion: snapshot._id,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(), lastRefreshError: this.lastError };
  }

  async start() {
    await this.tick();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, 15000);
      this.timer.unref?.();
    }
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  tick() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#tick().catch(error => {
      this.lastError = error.message;
      this.logger?.warn?.({ err: error.message }, 'Calendar snapshot refresh failed');
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #load(state) {
    if (!state?.activeVersion || state.activeVersion === this.snapshot?._id) return;
    const snapshot = await this.snapshotModel.findById(state.activeVersion).lean();
    if (snapshot) this.snapshot = Object.freeze({ ...snapshot, events: Object.freeze(snapshot.events) });
  }

  async #tick() {
    // The database pointer is also polled: a dropped process notification cannot strand an instance.
    await this.stateModel.updateOne({ _id: KEY }, { $setOnInsert: { generation: 0, leaseUntil: new Date(0), nextRefreshAt: new Date(0) } }, { upsert: true });
    await this.#load(await this.stateModel.findById(KEY).lean());
    const nowMs = this.now();
    const state = await this.stateModel.findOneAndUpdate({ _id: KEY,
      leaseUntil: mongoose.trusted({ $lte: new Date(nowMs) }),
      nextRefreshAt: mongoose.trusted({ $lte: new Date(nowMs) }),
    }, { $set: { leaseOwner: this.owner, leaseUntil: new Date(nowMs + this.config.newsCalendarHttpTimeoutMs + 30000) }, $inc: { generation: 1 } }, { new: true }).lean();
    if (!state) return;
    const claim = { _id: KEY, leaseOwner: this.owner, generation: state.generation };
    try {
      const snapshot = await this.#fetchSnapshot(nowMs);
      await this.snapshotModel.create(snapshot);
      const published = await this.stateModel.findOneAndUpdate({ ...claim,
        leaseUntil: mongoose.trusted({ $gt: new Date(this.now()) }),
      }, { $set: { activeVersion: snapshot._id, leaseUntil: new Date(0), lastError: null,
        nextRefreshAt: new Date(this.now() + this.config.newsCalendarCacheTtlMs) } }, { new: true }).lean();
      if (published) { this.snapshot = Object.freeze(snapshot); this.lastError = null; }
    } catch (error) {
      await this.stateModel.updateOne(claim, { $set: { leaseUntil: new Date(0), lastError: error.message,
        nextRefreshAt: new Date(this.now() + 30000) } });
      throw error;
    }
  }

  async #fetchSnapshot(nowMs) {
    const from = new Date(nowMs - DAY).toISOString().slice(0, 10);
    const to = new Date(nowMs + DAY).toISOString().slice(0, 10);
    const url = new URL(`${this.config.financeCalendarBaseUrl}/calendar`);
    for (const [key, value] of Object.entries({ from, to, impact: 'high', limit: '500' })) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Calendar operation timed out')); }, this.config.newsCalendarHttpTimeoutMs);
    });
    let payload;
    try {
      payload = await Promise.race([timeout, (async () => {
        const headers = { Accept: 'application/json' };
        if (this.config.financeCalendarApiKey) headers['X-API-Key'] = this.config.financeCalendarApiKey;
        const response = await this.fetch(url, { signal: controller.signal, headers });
        if (!response.ok) throw new Error(`Calendar HTTP ${response.status}`);
        return response.json();
      })()]);
    } finally { clearTimeout(timer); }
    const raw = Array.isArray(payload) ? payload : payload?.events;
    if (!Array.isArray(raw) || raw.length >= 500) throw new Error('Calendar payload invalid or potentially truncated');
    const events = raw.map(this.normalizeEvent);
    if (events.some(event => !event)) throw new Error('Calendar contains invalid or unverified high-impact events');
    const coverageFrom = new Date(`${from}T00:00:00.000Z`);
    const coverageTo = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY);
    if (events.some(event => {
      const at = Date.parse(event.timestamp || event.date);
      return at < coverageFrom.getTime() || at >= coverageTo.getTime();
    })) throw new Error('Calendar events fall outside requested coverage');
    // Unexpected removal must be reviewed instead of silently lifting a known upcoming restriction.
    const remaining = new Set(events.map(event => event.id));
    if (this.snapshot?.events.some(event => Date.parse(event.timestamp) > nowMs
      && Date.parse(event.timestamp) < coverageTo.getTime() && !remaining.has(event.id))) {
      throw new Error('Calendar removed a previously scheduled upcoming event');
    }
    return { _id: crypto.randomUUID(), provider: KEY, coverageFrom, coverageTo,
      fetchedAt: new Date(this.now()), checksum: crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex'), events };
  }
}
module.exports = { NewsCalendarSnapshotService };
