'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { env } = require('../../config/env');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { nextWeekendCloseTimeMs } = require('../instruments/session-calendar');
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
    fetchImpl = globalThis.fetch,
    logger = null,
    now = () => new Date(),
    config = env.tradingPermissions,
  } = {}) {
    this.accountModel = accountModel;
    this.instrumentModel = instrumentModel;
    this.shadowEventModel = shadowEventModel;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.config = config;
    this.cache = new Map();
  }

  async policyStatus(accountId, symbol, { nowMs = this.now().getTime() } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const [account, instrument] = await Promise.all([
      this.accountModel.findById(String(accountId)).lean(),
      normalizedSymbol ? this.instrumentModel.findOne({ symbol: normalizedSymbol }).lean() : null,
    ]);
    if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

    const permissions = normalizeTradingPermissions(account.tradingPermissions);
    const [news, weekend] = await Promise.all([
      this.#newsStatus(normalizedSymbol, instrument, permissions, nowMs),
      Promise.resolve(weekendStatus(instrument, permissions, nowMs)),
    ]);

    return {
      accountId: String(account._id),
      symbol: normalizedSymbol || null,
      permissions,
      enforcement: {
        shadowEnabled: this.config.shadowEnabled === true,
        newsEnabled: this.config.newsEnforcementEnabled === true,
        weekendEnabled: this.config.weekendEnforcementEnabled === true,
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

  async evaluateExposureIncrease({ accountId, symbol, action = 'OPEN_EXPOSURE', referenceId = null, nowMs = this.now().getTime() } = {}) {
    const status = await this.policyStatus(accountId, symbol, { nowMs });

    if (status.news?.active === true && status.permissions.newsTrading === false) {
      const decision = {
        kind: 'NEWS',
        wouldBlock: true,
        enforced: status.enforcement.newsEnabled,
        allowed: !status.enforcement.newsEnabled,
        status,
      };
      await this.#recordShadow(decision, { accountId, symbol, action, referenceId, nowMs });
      return decision;
    }

    if (status.weekend?.active === true && status.permissions.weekendHolding === false) {
      const decision = {
        kind: 'WEEKEND',
        wouldBlock: true,
        enforced: status.enforcement.weekendEnabled,
        allowed: !status.enforcement.weekendEnabled,
        status,
      };
      await this.#recordShadow(decision, { accountId, symbol, action, referenceId, nowMs });
      return decision;
    }

    return { kind: null, wouldBlock: false, enforced: false, allowed: true, status };
  }

  async assertExposureIncreaseAllowed(input = {}) {
    const decision = await this.evaluateExposureIncrease(input);
    if (decision.allowed) return decision;

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

  async recordWeekendCandidate({ account, symbol, action, referenceId, weekend, nowMs = this.now().getTime(), type = 'WEEKEND_WOULD_CLOSE' }) {
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
      enforcementEnabled: this.config.weekendEnforcementEnabled === true,
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
    if (permissions.newsTrading !== false || !symbol) {
      return { dataStatus: 'NOT_APPLICABLE', active: false, next: null, event: null, blockedFrom: null, blockedUntil: null };
    }

    const calendar = await this.#highImpactEvents(nowMs);
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
      if (calendar.dataStatus === 'LIVE' && nowMs >= eventMs - beforeMs && nowMs <= eventMs + afterMs) {
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
      authoritative: calendar.dataStatus === 'LIVE',
      event: current,
      next,
      blockedFrom: current?.blockedFrom || null,
      blockedUntil: current?.blockedUntil || null,
      fetchedAt: calendar.fetchedAt,
    };
  }

  async #highImpactEvents(nowMs) {
    const from = dateKey(nowMs - 24 * 60 * 60 * 1000);
    const to = dateKey(nowMs + 24 * 60 * 60 * 1000);
    const key = `${from}:${to}`;
    const cached = this.cache.get(key);
    if (cached && nowMs - cached.fetchedAtMs <= this.config.newsCalendarCacheTtlMs) {
      return { ...cached, dataStatus: 'LIVE' };
    }

    try {
      if (typeof this.fetch !== 'function') throw new Error('Fetch implementation unavailable');
      const url = new URL(`${this.config.financeCalendarBaseUrl}/calendar`);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('impact', 'high');
      url.searchParams.set('limit', '500');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.newsCalendarHttpTimeoutMs);
      let response;
      try {
        response = await this.fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'ACG-Trader/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`FinanceCalendar request failed (${response.status})`);
      const payload = await response.json();
      const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
      const value = {
        events: raw.map(normalizeCalendarEvent).filter(Boolean),
        fetchedAtMs: nowMs,
        fetchedAt: new Date(nowMs).toISOString(),
      };
      this.cache.set(key, value);
      return { ...value, dataStatus: 'LIVE' };
    } catch (error) {
      if (cached && nowMs - cached.fetchedAtMs <= this.config.newsCalendarStaleMaxMs) {
        this.logger?.warn?.({ err: error?.message }, 'Trading news calendar stale; enforcement fails open');
        return { ...cached, dataStatus: 'STALE' };
      }
      this.logger?.warn?.({ err: error?.message }, 'Trading news calendar unavailable; enforcement fails open');
      return { events: [], fetchedAtMs: null, fetchedAt: null, dataStatus: 'UNAVAILABLE' };
    }
  }

  async #recordShadow(decision, { accountId, symbol, action, referenceId, nowMs }) {
    if (this.config.shadowEnabled !== true) return;
    const account = await this.accountModel.findById(String(accountId)).select('_id tenantId').lean();
    if (!account) return;
    if (decision.kind === 'NEWS') {
      const news = decision.status.news;
      await this.#insertShadow({
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

function weekendStatus(instrument, permissions, nowMs = Date.now()) {
  if (permissions.weekendHolding !== false || !instrument) {
    return { active: false, warning: false, marketCloseAt: null, autoCloseAt: null, minutesUntilAutoClose: null };
  }
  const closeMs = nextWeekendCloseTimeMs(instrument, nowMs);
  if (!Number.isFinite(closeMs)) {
    return { active: false, warning: false, marketCloseAt: null, autoCloseAt: null, minutesUntilAutoClose: null };
  }
  const autoCloseMs = closeMs - permissions.weekendCloseBufferMinutes * 60_000;
  const delta = autoCloseMs - nowMs;
  return {
    active: nowMs >= autoCloseMs && nowMs < closeMs,
    warning: delta > 0 && delta <= 2 * 60 * 60 * 1000,
    marketCloseAt: new Date(closeMs).toISOString(),
    autoCloseAt: new Date(autoCloseMs).toISOString(),
    minutesUntilAutoClose: Math.max(0, Math.ceil(delta / 60_000)),
  };
}

function symbolAffectedByEvent(symbol, instrument, event) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;

  const title = String(event?.title || '').toLowerCase();
  if (/crude|petroleum|oil inventories|eia/.test(title) && ['USOIL', 'UKOIL'].includes(normalized)) return true;

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
  if (impact && impact !== 'HIGH') return null;

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
  ].join('|')).digest('hex');
}

module.exports = {
  TradingPermissionPolicyService,
  normalizeTradingPermissions,
  normalizeCalendarEvent,
  symbolAffectedByEvent,
  weekendStatus,
};
