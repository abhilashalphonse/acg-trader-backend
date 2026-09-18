'use strict';

const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { serializeAccount } = require('./trading.serializer');

class RiskDayEngine {
  constructor({
    eventBus,
    logger = null,
    accountModel = TradingAccount,
    commandQueue = new AccountCommandQueue(),
    now = () => new Date(),
  } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.accountModel = accountModel;
    this.commandQueue = commandQueue;
    this.now = now;
    this.started = false;
    this.inFlight = new Map();
    this.dayCache = new Map();
    this.onValuation = valuation => this.#schedule(valuation);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.started = false;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.dayCache.clear();
  }

  health() {
    return { started: this.started, inFlight: this.inFlight.size, cachedAccounts: this.dayCache.size };
  }

  #schedule(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') return;

    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId || this.inFlight.has(accountId)) return;

    const cached = this.dayCache.get(accountId);
    if (cached) {
      const currentDay = dayKeyInTimezone(this.now(), cached.timezone);
      if (cached.dayKey === currentDay) return;
    }

    const work = this.#handleValuation(valuation)
      .catch(error => {
        this.logger?.error({ err: error, accountId }, 'Risk day rollover failed');
      })
      .finally(() => {
        if (this.inFlight.get(accountId) === work) this.inFlight.delete(accountId);
      });
    this.inFlight.set(accountId, work);
  }

  async #handleValuation(valuation) {
    const accountId = String(valuation.accountId || valuation.id || '').trim();
    const equity = Number(valuation.equity);
    if (!Number.isFinite(equity)) return;

    const result = await this.commandQueue.run(accountId, async () => {
      const account = await this.accountModel.findById(accountId);
      if (!account) return null;

      const timezone = String(account.riskTimezone || 'UTC');
      const dayKey = dayKeyInTimezone(this.now(), timezone);
      if (account.riskDayKey === dayKey) return { account, dayKey, timezone, changed: false };

      account.riskDayKey = dayKey;
      account.state.dailyStartEquity = String(equity);
      account.state.realizedPnlToday = '0';
      await account.save();
      return { account, dayKey, timezone, changed: true };
    });

    if (!result) return;
    this.dayCache.set(accountId, { dayKey: result.dayKey, timezone: result.timezone });

    if (result.changed) {
      try {
        this.eventBus?.emit('trading.account.updated', serializeAccount(result.account));
      } catch (error) {
        this.logger?.error({ err: error, accountId }, 'Risk day account update event failed');
      }
    }
  }
}

function dayKeyInTimezone(date, timeZone = 'UTC') {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { RiskDayEngine, dayKeyInTimezone };
