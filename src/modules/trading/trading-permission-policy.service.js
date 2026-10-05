'use strict';

const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { AppError } = require('../../shared/errors/app-error');
const { env } = require('../../config/env');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { scheduleHash } = require('../instruments/schedule-identity');
const { nextWeekendCloseTimeMs, nextSessionOpenTimeMs } = require('../instruments/session-calendar');
const { TradingPolicyShadowEvent } = require('./trading-policy-shadow-event.model');

const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']);
const USD_INDEX_SYMBOLS = new Set(['US30', 'DJI', 'DJ30', 'US100', 'NAS100', 'NASDAQ100', 'US500', 'SPX500', 'SP500', 'US2000', 'RUS2000', 'DXY']);
const COUNTRY_TO_CURRENCY = new Map([
  ['united states', 'USD'], ['us', 'USD'], ['usa', 'USD'],
  ['euro area', 'EUR'], ['eurozone', 'EUR'], ['european union', 'EUR'],
  ['united kingdom', 'GBP'], ['uk', 'GBP'], ['great britain', 'GBP'],
  ['japan', 'JPY'], ['canada', 'CAD'], ['australia', 'AUD'],
  ['new zealand', 'NZD'], ['switzerland', 'CHF'],
]);

class TradingPermissionPolicyService {
  constructor({
    accountModel = TradingAccount,
    instrumentModel = Instrument,
    shadowEventModel = TradingPolicyShadowEvent,
    logger = null,
    now = () => new Date(),
    config = env.tradingPermissions,
    calendarSnapshots = null,
    controlService = null,
    metricsService = null,
  } = {}) {
    this.accountModel = accountModel;
    this.instrumentModel = instrumentModel;
    this.shadowEventModel = shadowEventModel;
    this.logger = logger;
    this.now = now;
    this.config = config;
    this.calendarSnapshots = calendarSnapshots;
    this.controlService = controlService;
    this.metricsService = metricsService;
    this.pendingTelemetry = 0;
    this.droppedTelemetry = 0;
  }

  async policyStatus(accountId, symbol, { nowMs = this.now().getTime(), account: suppliedAccount, instrument: suppliedInstrument } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const [account, instrument] = await Promise.all([
      suppliedAccount || this.accountModel.findById(String(accountId)).lean(),
      suppliedInstrument !== undefined ? suppliedInstrument : normalizedSymbol ? this.instrumentModel.findOne({ symbol: normalizedSymbol }).lean() : null,
    ]);
    if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

    const permissions = normalizeTradingPermissions(account.tradingPermissions);
    const [news, weekend] = await Promise.all([
      this.#newsStatus(normalizedSymbol, instrument, permissions, nowMs),
      Promise.resolve(weekendStatus(instrument, permissions, nowMs, this.config.weekendProcessingLeadMinutes || 5)),
    ]);
    const bucket = crypto.createHash('sha256').update(String(account._id)).digest().readUInt32BE(0) % 100;
    const versioned = Number(account.tradingPermissionsVersion || 0) > 0;
    const control = this.controlService && (this.config.newsEnforcementEnabled || this.config.weekendEnforcementEnabled)
      ? await this.controlService.read(account.tenantId) : { revision: 0, newsDisabled: false, weekendDisabled: false };
    const newsEnabled = this.config.newsEnforcementEnabled === true && !control.newsDisabled && versioned && bucket < (this.config.newsRolloutPercent ?? 0);
    const weekendEnabled = this.config.weekendEnforcementEnabled === true && !control.weekendDisabled && versioned && bucket < (this.config.weekendRolloutPercent ?? 0);
    const instrumentScheduleHash = scheduleHash(instrument);
    const activeRestriction = (account.executionRestrictions || []).find(item => item.symbol === normalizedSymbol
      && Number(item.permissionVersion) === Number(account.tradingPermissionsVersion)
      && Number(item.scheduleVersion) === Number(instrument?.scheduleVersion || 1)
      && item.scheduleHash === instrumentScheduleHash
      && nowMs >= new Date(item.startsAt).getTime() && nowMs < new Date(item.expiresAt).getTime());
    if (!permissions.weekendHolding && activeRestriction) {
      weekend.active = true;
      weekend.lockedUntil = new Date(activeRestriction.expiresAt).toISOString();
    }
    const mode = enabled => enabled ? 'ENFORCED' : this.config.shadowEnabled ? 'SHADOW' : 'INFORMATIONAL';

    return {
      accountId: String(account._id),
      tenantId: String(account.tenantId),
      symbol: normalizedSymbol || null,
      permissions,
      permissionVersion: Number(account.tradingPermissionsVersion || 0),
      enforcementControl: { revision: control.revision, newsDisabled: control.newsDisabled, weekendDisabled: control.weekendDisabled },
      scheduleVersion: Number(instrument?.scheduleVersion || 0),
      scheduleHash: instrumentScheduleHash,
      policyEngineVersion: 'ACG_EXECUTION_POLICY_V1',
      effectivePolicies: {
        newsTrading: { permission: permissions.newsTrading, mode: mode(newsEnabled), calendarStatus: news.dataStatus },
        weekendHolding: { permission: permissions.weekendHolding, mode: mode(weekendEnabled) },
      },
      enforcement: {
        shadowEnabled: this.config.shadowEnabled === true,
        newsEnabled,
        weekendEnabled,
      },
      news,
      weekend,
      source: {
        calendar: 'financecalendar.com',
        highImpactOnly: true,
      },
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  async evaluateExposureIncrease({ accountId, symbol, account, instrument, action = 'OPEN_EXPOSURE', referenceId = null, stage = 'PREVIEW', nowMs = this.now().getTime() } = {}) {
    const startedAt = performance.now();
    let status;
    try {
      status = await this.policyStatus(accountId, symbol, { nowMs, account, instrument });
    } catch (error) {
      this.metricsService?.observe({ tenantId: account?.tenantId, stage, action, error: true, latencyMs: performance.now() - startedAt });
      throw error;
    }

    const decisions = [
      { kind: 'NEWS', applicable: status.news?.active === true && !status.permissions.newsTrading, enforced: status.enforcement.newsEnabled },
      { kind: 'NEWS_DATA_UNAVAILABLE', applicable: !status.permissions.newsTrading && ['UNAVAILABLE', 'EXPIRED'].includes(status.news?.dataStatus), enforced: status.enforcement.newsEnabled },
      { kind: 'WEEKEND', applicable: status.weekend?.active === true && !status.permissions.weekendHolding, enforced: status.enforcement.weekendEnabled },
    ].filter(decision => decision.applicable).map(decision => ({ ...decision, wouldBlock: true, allowed: !decision.enforced }));
    for (const decision of decisions) {
      if (decision.kind === 'NEWS_DATA_UNAVAILABLE') continue;
      this.#queueShadow({ ...decision, status }, { accountId, symbol, action, referenceId, nowMs });
    }
    const blocking = decisions.find(decision => decision.enforced);
    const result = { kind: (blocking || decisions[0])?.kind || null, wouldBlock: decisions.length > 0,
      enforced: Boolean(blocking), allowed: !blocking, decisions, status };
    this.metricsService?.observe({ tenantId: status.tenantId, stage, action, decision: result, latencyMs: performance.now() - startedAt });
    return result;
  }

  async assertExposureIncreaseAllowed(input = {}) {
    const decision = await this.evaluateExposureIncrease(input);
    if (decision.allowed) return decision;

    if (decision.kind === 'NEWS_DATA_UNAVAILABLE') {
      throw new AppError('New exposure is paused while the news calendar is unavailable. Existing positions may still be closed or reduced.', {
        statusCode: 409, code: 'NEWS_CALENDAR_UNAVAILABLE', details: { closeReduceAllowed: true, dataStatus: decision.status.news.dataStatus },
      });
    }

    if (decision.kind === 'NEWS') {
      const news = decision.status.news;
      throw new AppError(
        `New ${decision.status.symbol || 'instrument'} exposure is temporarily unavailable because of ${news.event?.currency || ''} high-impact news. Existing positions may still be closed or reduced.`.replace(/\s+/g, ' ').trim(),
        {
          statusCode: 409,
          code: 'NEWS_TRADING_RESTRICTED',
          details: {
            symbol: decision.status.symbol,
            event: news.event,
            blockedFrom: news.blockedFrom,
            blockedUntil: news.blockedUntil,
            closeReduceAllowed: true,
          },
        },
      );
    }

    throw new AppError('New exposure is unavailable because this account is inside its weekend auto-close window.', {
      statusCode: 409,
      code: 'WEEKEND_HOLDING_CUTOFF_ACTIVE',
      details: {
        symbol: decision.status.symbol,
        autoCloseAt: decision.status.weekend?.autoCloseAt || null,
        marketCloseAt: decision.status.weekend?.marketCloseAt || null,
        closeReduceAllowed: true,
      },
    });
  }

  async recordWeekendCandidate({ account, symbol, action, referenceId, weekend, enforcementEnabled = false, nowMs = this.now().getTime(), type = 'WEEKEND_WOULD_CLOSE' }) {
    if (this.config.shadowEnabled !== true || !account || !weekend?.active) return;
    await this.#insertShadow({
      tenantId: account.tenantId,
      accountId: account._id,
      type,
      symbol,
      action,
      referenceId,
      weekendCloseAt: weekend.marketCloseAt,
      weekendAutoCloseAt: weekend.autoCloseAt,
      enforcementEnabled,
      nowMs,
    });
  }

  async listShadowEvents(accountId, { limit = 100 } = {}) {
    return this.shadowEventModel.find({ accountId: String(accountId) })
      .sort({ observedAt: -1, _id: -1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
      .lean();
  }

  async #newsStatus(symbol, instrument, permissions, nowMs) {
    const canBeAffected = [...SUPPORTED_CURRENCIES].some(currency => symbolAffectedByEvent(symbol, instrument, { currency }))
      || symbolAffectedByEvent(symbol, instrument, { title: 'Oil inventories' });
    if (permissions.newsTrading !== false || !symbol || !canBeAffected) {
      return { dataStatus: 'NOT_APPLICABLE', active: false, next: null, event: null, blockedFrom: null, blockedUntil: null };
    }

    const calendar = this.calendarSnapshots?.read(nowMs) || { events: [], dataStatus: 'UNAVAILABLE', fetchedAt: null };
    const relevant = calendar.events
      .filter(event => event.timestamp && !event.allDay && symbolAffectedByEvent(symbol, instrument, event))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const beforeMs = permissions.newsRestrictionBeforeMinutes * 60_000;
    const afterMs = permissions.newsRestrictionAfterMinutes * 60_000;
    let activeEvent = null;
    let nextEvent = null;

    for (const event of relevant) {
      const eventMs = new Date(event.timestamp).getTime();
      if (!Number.isFinite(eventMs)) continue;
      if (['FRESH', 'VALID_GRACE'].includes(calendar.dataStatus) && nowMs >= eventMs - beforeMs && nowMs <= eventMs + afterMs) {
        activeEvent = event;
        break;
      }
      if (eventMs > nowMs && !nextEvent) nextEvent = event;
    }

    const timed = event => {
      if (!event) return null;
      const eventMs = new Date(event.timestamp).getTime();
      return {
        ...event,
        blockedFrom: new Date(eventMs - beforeMs).toISOString(),
        blockedUntil: new Date(eventMs + afterMs).toISOString(),
      };
    };

    const current = timed(activeEvent);
    const next = timed(nextEvent);
    return {
      dataStatus: calendar.dataStatus,
      active: Boolean(current),
      authoritative: ['FRESH', 'VALID_GRACE'].includes(calendar.dataStatus),
      event: current,
      next,
      blockedFrom: current?.blockedFrom || null,
      blockedUntil: current?.blockedUntil || null,
      fetchedAt: calendar.fetchedAt,
      snapshotVersion: calendar.snapshotVersion || null,
    };
  }

  async authorizeExecution({ account, instrument, session, action, referenceId, reject = true }) {
    const input = { accountId: account?._id, account, instrument, symbol: instrument?.symbol, action, referenceId,
      nowMs: this.now().getTime(), stage: 'EXECUTION' };
    const decision = reject ? await this.assertExposureIncreaseAllowed(input) : await this.evaluateExposureIncrease(input);
    // A real write on the shared account fences concurrent permission changes even for pending creation.
    if (decision.allowed && account && (this.config.newsEnforcementEnabled || this.config.weekendEnforcementEnabled)) {
      account.policyExecutionRevision = Number(account.policyExecutionRevision || 0) + 1;
      await account.save({ session });
    }
    return decision;
  }

  #queueShadow(decision, context) {
    if (!this.config.shadowEnabled) return;
    if (this.pendingTelemetry >= 1000) { this.droppedTelemetry++; return; }
    this.pendingTelemetry++;
    void this.#recordShadow(decision, context).catch(error => {
      this.logger?.warn?.({ err: error.message }, 'Policy shadow telemetry failed');
    }).finally(() => { this.pendingTelemetry--; });
  }

  async #recordShadow(decision, { accountId, symbol, action, referenceId, nowMs }) {
    if (this.config.shadowEnabled !== true) return;
    const account = await this.accountModel.findById(String(accountId)).select('_id tenantId').lean();
    if (!account) return;
    const versions = { permissionVersion: decision.status.permissionVersion, calendarSnapshotVersion: decision.status.news?.snapshotVersion,
      scheduleVersion: decision.status.scheduleVersion, policyEngineVersion: decision.status.policyEngineVersion };
    if (decision.kind === 'NEWS') {
      const news = decision.status.news;
      await this.#insertShadow({
        ...versions,
        tenantId: account.tenantId,
        accountId: account._id,
        type: 'NEWS_WOULD_BLOCK',
        symbol,
        action,
        referenceId,
        eventId: news.event?.id || null,
        eventTitle: news.event?.title || null,
        eventCurrency: news.event?.currency || null,
        eventAt: news.event?.timestamp || null,
        windowFrom: news.blockedFrom,
        windowUntil: news.blockedUntil,
        enforcementEnabled: decision.enforced,
        nowMs,
      });
      return;
    }

    const weekend = decision.status.weekend;
    await this.#insertShadow({
      ...versions,
      tenantId: account.tenantId,
      accountId: account._id,
      type: 'WEEKEND_WOULD_BLOCK',
      symbol,
      action,
      referenceId,
      weekendCloseAt: weekend?.marketCloseAt || null,
      weekendAutoCloseAt: weekend?.autoCloseAt || null,
      enforcementEnabled: decision.enforced,
      nowMs,
    });
  }

  async #insertShadow(data) {
    const dedupeKey = shadowDedupeKey(data);
    try {
      await this.shadowEventModel.updateOne(
        { dedupeKey },
        {
          $setOnInsert: {
            ...data,
            symbol: normalizeSymbol(data.symbol),
            dedupeKey,
            observedAt: new Date(data.nowMs || Date.now()),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) this.logger?.warn?.({ err: error?.message, dedupeKey }, 'Unable to record trading policy shadow event');
    }
  }
}

function normalizeTradingPermissions(value = {}) {
  return {
    newsTrading: value?.newsTrading !== false,
    weekendHolding: value?.weekendHolding !== false,
    highImpactOnly: true,
    newsRestrictionBeforeMinutes: 5,
    newsRestrictionAfterMinutes: 5,
    closeReduceAlwaysAllowed: true,
    pendingEntriesBlocked: true,
    weekendCloseBufferMinutes: 5,
    weekendBreach: false,
    carryToMaster: true,
  };
}

function weekendStatus(instrument, permissions, nowMs = Date.now(), processingLeadMinutes = 5) {
  if (permissions.weekendHolding !== false || !instrument) {
    return { active: false, warning: false, marketCloseAt: null, autoCloseAt: null, minutesUntilAutoClose: null };
  }
  const closeMs = nextWeekendCloseTimeMs(instrument, nowMs);
  if (!Number.isFinite(closeMs)) {
    return { active: false, warning: false, marketCloseAt: null, autoCloseAt: null, minutesUntilAutoClose: null };
  }
  const requiredFlatMs = closeMs - permissions.weekendCloseBufferMinutes * 60_000;
  const autoCloseMs = closeMs - Math.max(permissions.weekendCloseBufferMinutes, processingLeadMinutes) * 60_000;
  const reopenMs = nextSessionOpenTimeMs(instrument, closeMs);
  const delta = autoCloseMs - nowMs;
  return {
    active: nowMs >= autoCloseMs && nowMs < closeMs,
    warning: delta > 0 && delta <= 2 * 60 * 60 * 1000,
    marketCloseAt: new Date(closeMs).toISOString(),
    autoCloseAt: new Date(autoCloseMs).toISOString(),
    requiredFlatAt: new Date(requiredFlatMs).toISOString(),
    reopenAt: Number.isFinite(reopenMs) ? new Date(reopenMs).toISOString() : null,
    minutesUntilAutoClose: Math.max(0, Math.ceil(delta / 60_000)),
  };
}

function symbolAffectedByEvent(symbol, instrument, event) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;

  const title = String(event?.title || '').toLowerCase();
  if (/crude|petroleum|oil inventories|eia/.test(title)) return ['USOIL', 'UKOIL'].includes(normalized);

  const currency = String(event?.currency || '').toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) return false;

  const assetClass = String(instrument?.assetClass || '').toUpperCase();
  const base = String(instrument?.baseCurrency || '').toUpperCase();
  const quote = String(instrument?.quoteCurrency || '').toUpperCase();

  if (assetClass === 'FOREX') return base === currency || quote === currency || normalized.includes(currency);
  if (currency === 'USD' && normalized === 'XAUUSD') return true;
  if (currency === 'USD' && USD_INDEX_SYMBOLS.has(normalized)) return true;
  return false;
}

function normalizeCalendarEvent(raw = {}) {
  const timestamp = parseTimestamp(raw.time_utc || raw.timestamp || raw.datetime || raw.date_time || raw.start);
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
    ? raw.date
    : timestamp?.slice(0, 10) || null;
  if (!timestamp && !date) return null;

  const impact = String(raw.impact || raw.importance || '').trim().toUpperCase();
  if (impact !== 'HIGH') return null;

  const title = String(raw.title || raw.name || raw.event || 'Economic event').trim();
  const country = String(raw.country || raw.region || raw.area || '').trim() || null;
  const currency = normalizeCurrency(raw.currency) || inferCurrency(country, title);

  return {
    id: String(raw.id || raw.event_id || raw.slug || stableEventId(timestamp || date, title)),
    timestamp,
    date,
    allDay: Boolean(raw.all_day),
    country,
    currency,
    title,
    impact: 'HIGH',
    category: raw.category ? String(raw.category) : null,
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return SUPPORTED_CURRENCIES.has(currency) ? currency : null;
}
function inferCurrency(country, title) {
  const countryCurrency = COUNTRY_TO_CURRENCY.get(String(country || '').trim().toLowerCase());
  if (countryCurrency) return countryCurrency;
  const text = String(title || '').toUpperCase();
  const rules = [
    [/\b(US|U\.S\.|FED|FOMC|NON[- ]?FARM|NFP)\b/, 'USD'],
    [/\b(EUROZONE|EURO AREA|ECB)\b/, 'EUR'],
    [/\b(UK|BOE|BANK OF ENGLAND)\b/, 'GBP'],
    [/\b(JAPAN|BOJ)\b/, 'JPY'],
    [/\b(CANADA|BOC|BANK OF CANADA)\b/, 'CAD'],
    [/\b(AUSTRALIA|RBA)\b/, 'AUD'],
    [/\b(NEW ZEALAND|RBNZ)\b/, 'NZD'],
    [/\b(SWITZERLAND|SNB)\b/, 'CHF'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || null;
}
function normalizeSymbol(value) { return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function stableEventId(time, title) {
  return crypto.createHash('sha1').update(`${time}|${title}`).digest('hex').slice(0, 24);
}
function shadowDedupeKey(data) {
  return crypto.createHash('sha256').update([
    String(data.accountId || ''),
    String(data.type || ''),
    normalizeSymbol(data.symbol),
    String(data.action || ''),
    String(data.referenceId || ''),
    String(data.eventId || ''),
    String(data.windowFrom || ''),
    String(data.weekendAutoCloseAt || ''),
    String(data.permissionVersion || ''),
    String(data.calendarSnapshotVersion || ''),
    String(data.scheduleVersion || ''),
    String(data.enforcementEnabled === true),
  ].join('|')).digest('hex');
}

module.exports = {
  TradingPermissionPolicyService,
  normalizeTradingPermissions,
  normalizeCalendarEvent,
  symbolAffectedByEvent,
  weekendStatus,
};
