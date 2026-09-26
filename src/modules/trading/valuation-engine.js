'use strict';

const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { addDecimal, subtractDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Position } = require('./position.model');
const {
  calculatePositionValuation,
  aggregateAccountValuation,
  normalizePosition,
} = require('./valuation-calculator');

class ValuationEngine {
  constructor({
    eventBus,
    quoteStore,
    currencyConverter = null,
    marketPriority = null,
    logger,
    accountModel = TradingAccount,
    positionModel = Position,
  }) {
    this.eventBus = eventBus;
    this.quoteStore = quoteStore;
    this.currencyConverter = currencyConverter;
    this.marketPriority = marketPriority;
    this.logger = logger;
    this.accountModel = accountModel;
    this.positionModel = positionModel;

    this.positions = new Map();
    this.positionValuations = new Map();
    this.accountBases = new Map();
    this.accountValuations = new Map();
    this.positionsBySymbol = new Map();
    this.positionsByAccount = new Map();
    this.accountsByConversionSymbol = new Map();
    this.conversionSymbolsByAccount = new Map();
    this.sequence = 0;
    this.started = false;
    this.pendingAccountRevalues = new Set();
    this.accountRevalueScheduled = false;

    this.onTick = quote => this.#safeEvent('market.tick', () => this.#handleQuote(quote));
    this.onStaleQuote = quote => { if (quote?.isStale) this.#safeEvent('market.quote', () => this.#handleQuote(quote)); };
    this.onPositionOpened = position => this.#safeEvent('trading.position.opened', () => this.#upsertPosition(position));
    this.onPositionUpdated = position => this.#safeEvent('trading.position.updated', () => this.#upsertPosition(position));
    this.onPositionClosed = position => this.#safeEvent('trading.position.closed', () => this.#removePosition(position));
    this.onAccountUpdated = account => this.#safeEvent('trading.account.updated', () => this.#upsertAccount(account));
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.#attachListeners();
    try {
      const openPositions = await this.positionModel.find({ status: 'OPEN' }).lean();
      const accountIds = [...new Set(openPositions.map(position => String(position.accountId)))];
      const accounts = accountIds.length ? await this.accountModel.find({ _id: mongoose.trusted({ $in: accountIds }) }).lean() : [];
      for (const account of accounts) this.#storeAccountBase(account);
      for (const position of openPositions) this.#storePosition(position);
      for (const position of openPositions) this.#revaluePosition(String(position._id), this.quoteStore.get(position.symbol), false);
      for (const accountId of accountIds) this.#recalculateAccount(accountId, false);
      this.logger?.info({ openPositions: this.positions.size, accounts: this.accountBases.size }, 'Realtime valuation engine recovered');
    } catch (error) {
      this.#detachListeners();
      this.started = false;
      throw error;
    }
  }

  async stop() {
    if (!this.started) return;
    this.#detachListeners();
    this.started = false;
    for (const position of this.positions.values()) this.marketPriority?.release?.(position.symbol);
    this.positions.clear();
    this.positionValuations.clear();
    this.accountBases.clear();
    this.accountValuations.clear();
    this.positionsBySymbol.clear();
    this.positionsByAccount.clear();
    this.accountsByConversionSymbol.clear();
    this.conversionSymbolsByAccount.clear();
    this.pendingAccountRevalues.clear();
    this.accountRevalueScheduled = false;
  }

  scheduleAccountRevalue(accountId) {
    const key = String(accountId || '');
    if (!key || !this.started) return;
    this.pendingAccountRevalues.add(key);
    if (this.accountRevalueScheduled) return;
    this.accountRevalueScheduled = true;
    queueMicrotask(() => {
      this.accountRevalueScheduled = false;
      const pending = [...this.pendingAccountRevalues];
      this.pendingAccountRevalues.clear();
      for (const id of pending) {
        this.#safeEvent('valuation.account.revalue', () => this.#recalculateAccount(id, true));
      }
    });
  }

  health() {
    const statuses = { LIVE: 0, STALE: 0, WAITING: 0 };
    for (const valuation of this.accountValuations.values()) statuses[valuation.valuationStatus] = (statuses[valuation.valuationStatus] || 0) + 1;
    return { started: this.started, openPositions: this.positions.size, accounts: this.accountValuations.size, statuses };
  }

  getPositionSnapshot(positionId) {
    const snapshot = this.positionValuations.get(String(positionId));
    return snapshot ? clone(snapshot) : null;
  }

  getAccountSnapshot(accountId) {
    const snapshot = this.accountValuations.get(String(accountId));
    return snapshot ? clone(snapshot) : null;
  }

  async getOrLoadAccountSnapshot(accountId) {
    const key = String(accountId || '');
    const existing = this.getAccountSnapshot(key);
    if (existing) return existing;
    const account = await this.accountModel.findById(key).lean();
    if (!account) return null;
    this.#storeAccountBase(account);
    this.#recalculateAccount(key, false);
    return this.getAccountSnapshot(key);
  }

  projectAccountDocument(account) {
    if (!account) return null;
    const accountId = String(account._id || account.id || '');
    const base = this.accountBases.get(accountId);
    const documentRevision = Number(account.financialRevision || 0);
    const valuationRevision = Number(base?.financialRevision || 0);
    if (base && valuationRevision !== documentRevision) {
      return {
        accountId,
        complete: false,
        valuationStatus: 'WAITING',
        staleFinancialRevision: true,
        financialRevision: valuationRevision,
        currentFinancialRevision: documentRevision,
      };
    }
    return {
      ...aggregateAccountValuation({
        account,
        positionValuations: this.#valuationsForAccount(accountId),
        currencyConverter: this.currencyConverter,
        nowMs: Date.now(),
      }),
      financialRevision: documentRevision,
    };
  }

  overlayAccountDocument(account, { requireLive = false } = {}) {
    const projection = this.projectAccountDocument(account);
    if (!projection) return null;
    if (projection.staleFinancialRevision) {
      throw new AppError('Account valuation was calculated from an older financial revision', {
        statusCode: 409,
        code: 'STALE_VALUATION_REVISION',
        details: {
          valuationRevision: projection.financialRevision,
          currentFinancialRevision: projection.currentFinancialRevision,
        },
      });
    }
    if (requireLive && projection.valuationStatus !== 'LIVE') {
      throw new AppError('Account valuation is not live; new exposure is paused until all open positions and currency conversions have executable quotes', {
        statusCode: 409,
        code: 'ACCOUNT_VALUATION_NOT_LIVE',
        details: { valuationStatus: projection.valuationStatus, staleSymbols: projection.staleSymbols },
      });
    }
    if (!projection.complete) return projection;
    const balance = account.state.balance.toString();
    account.state.floatingPnl = projection.floatingPnl;
    account.state.equity = addDecimal(balance, projection.floatingPnl);
    account.state.usedMargin = projection.usedMargin;
    account.state.freeMargin = subtractDecimal(account.state.equity, projection.usedMargin);
    account.state.marginLevel = projection.marginLevel;
    return { ...projection, balance, equity: account.state.equity.toString(), freeMargin: account.state.freeMargin.toString(), marginLevel: projection.marginLevel };
  }

  #safeEvent(event, callback) {
    try { callback(); } catch (error) { this.logger?.error({ err: error, event }, 'Realtime valuation event failed'); }
  }
  #attachListeners() {
    this.eventBus.on('market.tick', this.onTick);
    this.eventBus.on('market.quote', this.onStaleQuote);
    this.eventBus.on('trading.position.opened', this.onPositionOpened);
    this.eventBus.on('trading.position.updated', this.onPositionUpdated);
    this.eventBus.on('trading.position.closed', this.onPositionClosed);
    this.eventBus.on('trading.account.updated', this.onAccountUpdated);
  }
  #detachListeners() {
    this.eventBus.off('market.tick', this.onTick);
    this.eventBus.off('market.quote', this.onStaleQuote);
    this.eventBus.off('trading.position.opened', this.onPositionOpened);
    this.eventBus.off('trading.position.updated', this.onPositionUpdated);
    this.eventBus.off('trading.position.closed', this.onPositionClosed);
    this.eventBus.off('trading.account.updated', this.onAccountUpdated);
  }
  #handleQuote(quote) {
    if (!quote?.symbol) return;
    const symbol = String(quote.symbol).toUpperCase();
    const ids = [...(this.positionsBySymbol.get(symbol) || [])];
    const touchedAccounts = new Set(this.accountsByConversionSymbol.get(symbol) || []);
    for (const id of ids) {
      const position = this.positions.get(id);
      if (!position) continue;
      touchedAccounts.add(position.accountId);
      this.#revaluePosition(id, quote, true);
    }
    // Recalculate accounts whose position price changed and accounts whose
    // account-currency conversion path depends on this quote. This keeps
    // challenge equity/current free margin live without an O(all accounts)
    // fan-out on every market tick.
    for (const accountId of touchedAccounts) this.#recalculateAccount(accountId, true);
  }
  #upsertPosition(position) {
    const normalized = normalizePosition(position);
    if (!normalized.id || normalized.status !== 'OPEN') { this.#removePosition(position); return; }
    this.#storePosition(position);
    this.#revaluePosition(normalized.id, this.quoteStore.get(normalized.symbol), true);
    this.scheduleAccountRevalue(normalized.accountId);
  }
  #removePosition(position) {
    const id = String(position?.id || position?._id || '');
    const existing = this.positions.get(id);
    const accountId = existing?.accountId || String(position?.accountId || '');
    if (!id) return;
    if (existing) this.#unindexPosition(existing);
    this.positions.delete(id);
    this.positionValuations.delete(id);
    if (accountId) {
      this.#refreshConversionIndex(accountId);
      this.scheduleAccountRevalue(accountId);
    }
  }
  #upsertAccount(account) {
    const accountId = this.#storeAccountBase(account);
    if (!accountId) return;
    this.#refreshConversionIndex(accountId);
    this.pendingAccountRevalues.delete(accountId);
    this.#recalculateAccount(accountId, true);
  }
  #storeAccountBase(account) {
    const id = String(account?.id || account?._id || account?.accountId || '');
    if (!id) return null;
    this.accountBases.set(id, normalizeAccount(account));
    return id;
  }
  #storePosition(position) {
    const normalized = normalizePosition(position);
    if (!normalized.id) return null;
    const previous = this.positions.get(normalized.id);
    if (previous) this.#unindexPosition(previous);
    this.positions.set(normalized.id, normalized);
    this.marketPriority?.retain?.(normalized.symbol);
    addIndex(this.positionsBySymbol, normalized.symbol, normalized.id);
    addIndex(this.positionsByAccount, normalized.accountId, normalized.id);
    this.#refreshConversionIndex(normalized.accountId);
    if (previous && previous.accountId !== normalized.accountId) this.#refreshConversionIndex(previous.accountId);
    return normalized.id;
  }
  #unindexPosition(position) {
    this.marketPriority?.release?.(position.symbol);
    removeIndex(this.positionsBySymbol, position.symbol, position.id);
    removeIndex(this.positionsByAccount, position.accountId, position.id);
  }
  #refreshConversionIndex(accountId) {
    const key = String(accountId || '');
    if (!key) return;

    const previous = this.conversionSymbolsByAccount.get(key) || new Set();
    for (const symbol of previous) removeIndex(this.accountsByConversionSymbol, symbol, key);

    const next = new Set();
    const accountCurrency = String(this.accountBases.get(key)?.currency || '').toUpperCase();
    const positionIds = this.positionsByAccount.get(key) || new Set();
    for (const id of positionIds) {
      const pnlCurrency = String(this.positions.get(id)?.quoteCurrency || '').toUpperCase();
      for (const symbol of conversionSymbols(pnlCurrency, accountCurrency)) next.add(symbol);
    }

    if (next.size) this.conversionSymbolsByAccount.set(key, next);
    else this.conversionSymbolsByAccount.delete(key);
    for (const symbol of next) addIndex(this.accountsByConversionSymbol, symbol, key);
  }

  #revaluePosition(id, quote, emit) {
    const position = this.positions.get(id);
    if (!position) return null;
    const valuation = { ...calculatePositionValuation({ position, quote }), sequence: ++this.sequence, valuedAtMs: Date.now() };
    this.positionValuations.set(id, valuation);
    if (emit) this.eventBus.emit('valuation.position.updated', clone(valuation));
    return valuation;
  }
  #recalculateAccount(accountId, emit) {
    const base = this.accountBases.get(String(accountId));
    if (!base) return null;
    const valuation = {
      ...aggregateAccountValuation({
        account: base,
        positionValuations: this.#valuationsForAccount(accountId),
        currencyConverter: this.currencyConverter,
        nowMs: Date.now(),
      }),
      financialRevision: Number(base.financialRevision || 0),
      sequence: ++this.sequence,
      valuedAtMs: Date.now(),
    };
    this.accountValuations.set(String(accountId), valuation);
    if (emit) this.eventBus.emit('valuation.account.updated', clone(valuation));
    return valuation;
  }
  #valuationsForAccount(accountId) {
    const ids = this.positionsByAccount.get(String(accountId)) || new Set();
    return [...ids].map(id => this.positionValuations.get(id)).filter(Boolean);
  }
}

function normalizeAccount(account) {
  const state = account?.state || {};
  return {
    id: String(account?.id || account?._id || account?.accountId || ''),
    _id: account?._id,
    accountCode: account?.accountCode || null,
    currency: account?.currency || null,
    financialRevision: Number(account?.financialRevision || 0),
    state: {
      balance: valueString(state.balance, '0'),
      realizedPnlToday: valueString(state.realizedPnlToday, '0'),
      dailyStartEquity: valueString(state.dailyStartEquity, '0'),
    },
  };
}
function conversionSymbols(fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').trim().toUpperCase();
  const to = String(toCurrency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) return [];

  const symbols = new Set([`${from}${to}`, `${to}${from}`]);
  if (from !== 'USD' && to !== 'USD') {
    symbols.add(`${from}USD`);
    symbols.add(`USD${from}`);
    symbols.add(`USD${to}`);
    symbols.add(`${to}USD`);
  }
  return [...symbols];
}

function valueString(value, fallback = null) { if (value === null || value === undefined) return fallback; return value.toString(); }
function addIndex(map, key, value) { if (!key) return; let set = map.get(key); if (!set) { set = new Set(); map.set(key, set); } set.add(value); }
function removeIndex(map, key, value) { const set = map.get(key); if (!set) return; set.delete(value); if (!set.size) map.delete(key); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

module.exports = { ValuationEngine, conversionSymbols };
