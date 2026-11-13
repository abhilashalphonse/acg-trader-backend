'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { NewsCalendarSnapshot, NewsCalendarState } = require('./news-calendar-snapshot.model');
const { normalizeShowMyTrades, parseBlsIcs, combineVerifiedCalendar } = require('./free-calendar-sources');
const DAY = 86400000;
const KEY = 'financecalendar-high-impact';

class NewsCalendarSnapshotService {
  constructor({ config, normalizeEvent, snapshotModel = NewsCalendarSnapshot, stateModel = NewsCalendarState,
    fetchImpl = globalThis.fetch, now = Date.now, logger = null }) {
    Object.assign(this, { config, normalizeEvent, snapshotModel, stateModel, fetch: fetchImpl, now, logger });
    this.owner = crypto.randomUUID();
    // Separate immutable snapshot pointers prevent old commercial-feed data from
    // being mistaken for new free-feed evidence.
    this.key = config.calendarProvider === 'showmytrades' ? 'showmytrades-high-impact' : KEY;
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
    const ttl = this.config.calendarProvider === 'showmytrades'
      ? Math.max(900000, this.config.newsCalendarCacheTtlMs) : this.config.newsCalendarCacheTtlMs;
    let dataStatus = !covered ? 'EXPIRED' : age <= ttl ? 'FRESH'
      : age <= this.config.newsCalendarStaleMaxMs ? 'VALID_GRACE' : 'EXPIRED';
    // A candidate free feed cannot become authoritative simply by being enabled.
    if (this.config.calendarProvider === 'showmytrades' && !this.config.freeCalendarValidated &&
      ['FRESH', 'VALID_GRACE'].includes(dataStatus)) dataStatus = 'PENDING_VALIDATION';
    return { events: snapshot.events, dataStatus, snapshotVersion: snapshot._id,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(), lastRefreshError: this.lastError,
      provider: snapshot.provider, verification: snapshot.verification || null };
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
    await this.stateModel.updateOne({ _id: this.key }, { $setOnInsert: { generation: 0, leaseUntil: new Date(0), nextRefreshAt: new Date(0) } }, { upsert: true });
    await this.#load(await this.stateModel.findById(this.key).lean());
    const nowMs = this.now();
    const state = await this.stateModel.findOneAndUpdate({ _id: this.key,
      leaseUntil: mongoose.trusted({ $lte: new Date(nowMs) }),
      nextRefreshAt: mongoose.trusted({ $lte: new Date(nowMs) }),
    }, { $set: { leaseOwner: this.owner, leaseUntil: new Date(nowMs + this.config.newsCalendarHttpTimeoutMs + 30000) }, $inc: { generation: 1 } }, { new: true }).lean();
    if (!state) return;
    const claim = { _id: this.key, leaseOwner: this.owner, generation: state.generation };
    try {
      const snapshot = await this.#fetchSnapshot(nowMs);
      await this.snapshotModel.create(snapshot);
      const published = await this.stateModel.findOneAndUpdate({ ...claim,
        leaseUntil: mongoose.trusted({ $gt: new Date(this.now()) }),
      }, { $set: { activeVersion: snapshot._id, leaseUntil: new Date(0), lastError: null,
        nextRefreshAt: new Date(this.now() + (this.config.calendarProvider === 'showmytrades'
          ? Math.max(900000, this.config.newsCalendarCacheTtlMs) : this.config.newsCalendarCacheTtlMs)) } }, { new: true }).lean();
      if (published) {
        this.snapshot = Object.freeze(snapshot);
        this.lastError = null;
        this.logger?.info?.({
          provider: snapshot.provider,
          eventCount: snapshot.events.length,
          verification: snapshot.verification || null,
          snapshotVersion: snapshot._id,
        }, 'Calendar snapshot published');
      }
    } catch (error) {
      await this.stateModel.updateOne(claim, { $set: { leaseUntil: new Date(0), lastError: error.message,
        nextRefreshAt: new Date(this.now() + 30000) } });
      throw error;
    }
  }

  async #fetchSnapshot(nowMs) {
    if (this.config.calendarProvider === 'showmytrades') return this.#fetchFreeSnapshot(nowMs);
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

  async #fetchWithTimeout(url, accept = 'application/json') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.newsCalendarHttpTimeoutMs);
    try {
      const response = await this.fetch(url, { signal: controller.signal, headers: { Accept: accept } });
      if (!response.ok) throw new Error('Calendar upstream HTTP ' + response.status);
      return await (accept === 'text/calendar' ? response.text() : response.json());
    } finally { clearTimeout(timer); }
  }

  async #fetchFreeSnapshot(nowMs) {
    const start = nowMs - 5 * 3600000;
    const end = nowMs + 2 * DAY;
    const url = new URL(this.config.showMyTradesCalendarUrl);
    url.searchParams.set('impact', 'high');
    url.searchParams.set('days', '3');
    const data = await this.#fetchWithTimeout(url);
    const primary = normalizeShowMyTrades(data, nowMs).filter(event => {
      const at = Date.parse(event.timestamp);
      return at >= start && at < end;
    });
    let official = [];
    let blsStatus = 'UNAVAILABLE';
    try {
      const ics = await this.#fetchWithTimeout(this.config.blsReleaseCalendarUrl, 'text/calendar');
      official = parseBlsIcs(ics, { fromMs: start, toMs: end });
      blsStatus = 'AVAILABLE';
    } catch (error) {
      // Never claim independent confirmation if the official calendar is offline.
      this.logger?.warn?.({ err: error.message }, 'Official BLS calendar cross-check unavailable');
    }
    const merged = combineVerifiedCalendar(primary, official);
    const events = merged.events.map(this.normalizeEvent);
    if (events.some(event => !event) || events.length >= 500) {
      throw new Error('Free calendar returned invalid or excessive high-impact events');
    }
    const remaining = new Set(events.map(event => event.id));
    if (this.snapshot?.events.some(event => Date.parse(event.timestamp) > nowMs &&
      Date.parse(event.timestamp) < end && !remaining.has(event.id))) {
      throw new Error('Free calendar removed a previously scheduled upcoming event');
    }
    return {
      _id: crypto.randomUUID(), provider: 'showmytrades+bls',
      coverageFrom: new Date(start), coverageTo: new Date(end),
      fetchedAt: new Date(this.now()),
      checksum: crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      events,
      verification: { primary: 'AVAILABLE', officialBls: blsStatus, ...merged.verification },
    };
  }
}
module.exports = { NewsCalendarSnapshotService };
