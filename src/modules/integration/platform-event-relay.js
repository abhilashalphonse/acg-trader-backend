'use strict';

const crypto = require('crypto');
const { TradingAccount } = require('../accounts/trading-account.model');
const { PlatformEventOutbox } = require('./platform-event-outbox.model');

class PlatformEventRelay {
  constructor({
    eventBus,
    webhookUrl,
    webhookSecret,
    enabled = false,
    fetchImpl = globalThis.fetch,
    accountModel = TradingAccount,
    outboxModel = PlatformEventOutbox,
    logger = null,
    pollIntervalMs = 1000,
    timeoutMs = 5000,
    batchSize = 100,
    maxAttempts = 12,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, { eventBus, webhookUrl, webhookSecret, enabled, fetchImpl, accountModel, outboxModel, logger, pollIntervalMs, timeoutMs, batchSize, maxAttempts, now });
    this.timer = null;
    this.started = false;
    this.running = false;
    this.listeners = [];
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) return;
    if (!this.webhookUrl || !this.webhookSecret) throw new Error('Platform event relay requires webhookUrl and webhookSecret');
    if (typeof this.fetchImpl !== 'function') throw new Error('Platform event relay requires fetch');
    this.#listen('valuation.account.updated', payload => this.#captureSnapshot(payload, 'VALUATION'));
    this.#listen('trading.account.updated', payload => this.#captureSnapshot(payload, 'EXECUTION'));
    this.#listen('trading.account.balance.updated', payload => this.#captureSnapshot(payload?.account || payload, 'LEDGER'));
    this.#listen('trading.deal.created', payload => this.#captureDeal(payload));
    for (const event of ['trading.account.paused', 'trading.account.resumed', 'trading.account.disabled', 'trading.account.breached', 'trading.account.closed']) {
      this.#listen(event, payload => this.#captureControl(payload, event));
    }
    this.timer = setInterval(() => this.flush().catch(error => this.logger?.error({ err: error }, 'Platform event relay flush failed')), this.pollIntervalMs);
    this.timer.unref?.();
    await this.flush();
  }

  async stop() {
    for (const [event, listener] of this.listeners) this.eventBus?.off(event, listener);
    this.listeners = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.started = false;
  }

  health() {
    return { enabled: this.enabled, started: this.started, running: this.running, webhookConfigured: Boolean(this.webhookUrl && this.webhookSecret) };
  }

  async flush() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const due = await this.outboxModel.find({ status: 'PENDING', nextAttemptAt: { $lte: this.now() } })
        .sort({ createdAt: 1, _id: 1 })
        .limit(this.batchSize);
      for (const record of due) await this.#deliver(record);
    } finally {
      this.running = false;
    }
  }

  #listen(event, handler) {
    const listener = payload => Promise.resolve(handler(payload)).catch(error => this.logger?.error({ err: error, event }, 'Failed to capture platform event'));
    this.eventBus?.on(event, listener);
    this.listeners.push([event, listener]);
  }

  async #captureSnapshot(payload, source) {
    const accountId = accountIdOf(payload);
    if (!accountId) return;
    const account = await this.accountModel.findById(accountId).lean();
    if (!account) return;
    const fundedAccountId = metadataValue(account.metadata, 'fundedAccountId');
    if (!fundedAccountId) return;
    const state = payload?.state || account.state || {};
    await this.#enqueue(account, fundedAccountId, 'ACCOUNT_SNAPSHOT', {
      provider: 'acg-trader',
      platformAccountId: accountId,
      accountCode: account.accountCode || payload?.accountCode || null,
      balance: decimal(payload?.balance ?? state.balance),
      equity: decimal(payload?.equity ?? state.equity),
      margin: decimal(payload?.usedMargin ?? state.usedMargin),
      marginFree: decimal(payload?.freeMargin ?? state.freeMargin),
      marginLevel: decimal(payload?.marginLevel),
      floatingProfit: decimal(payload?.floatingPnl ?? state.floatingPnl),
      openPositions: numberOrNull(payload?.positionCount),
      valuationStatus: payload?.valuationStatus || null,
      complete: payload?.complete == null ? null : Boolean(payload.complete),
      source,
    }, { phase: metadataValue(account.metadata, 'phase') });
  }

  async #captureDeal(payload) {
    const accountId = accountIdOf(payload);
    if (!accountId) return;
    const account = await this.accountModel.findById(accountId).lean();
    if (!account) return;
    const fundedAccountId = metadataValue(account.metadata, 'fundedAccountId');
    if (!fundedAccountId) return;
    await this.#enqueue(account, fundedAccountId, 'DEAL_CREATED', {
      provider: 'acg-trader',
      platformAccountId: accountId,
      dealId: payload?.dealId || payload?.id || null,
      positionId: payload?.positionId || null,
      symbol: payload?.symbol || null,
      side: payload?.side || null,
      type: payload?.type || null,
      volume: decimal(payload?.volume),
      price: decimal(payload?.price),
      realizedPnl: decimal(payload?.realizedPnl),
      commission: decimal(payload?.commission),
      executedAt: payload?.executedAt || this.now().toISOString(),
    }, { phase: metadataValue(account.metadata, 'phase') });
  }

  async #captureControl(payload, sourceEvent) {
    const accountId = accountIdOf(payload);
    if (!accountId) return;
    const account = await this.accountModel.findById(accountId).lean();
    if (!account) return;
    const fundedAccountId = metadataValue(account.metadata, 'fundedAccountId');
    if (!fundedAccountId) return;
    await this.#enqueue(account, fundedAccountId, 'ACCOUNT_CONTROLLED', {
      provider: 'acg-trader',
      platformAccountId: accountId,
      status: payload?.status || account.status,
      tradingEnabled: payload?.tradingEnabled ?? account.tradingEnabled,
      sourceEvent,
    }, { phase: metadataValue(account.metadata, 'phase') });
  }

  async #enqueue(account, aggregateId, eventType, payload, metadata = {}) {
    await this.outboxModel.create({
      tenantId: account.tenantId,
      accountId: account._id,
      aggregateId: String(aggregateId),
      eventType,
      occurredAt: this.now(),
      payload,
      metadata: { ...metadata, tenantId: String(account.tenantId), externalRef: account.externalRef || null },
    });
  }

  async #deliver(record) {
    const envelope = {
      eventId: `acg-trader:${record.eventId}`,
      eventType: `ACG_TRADER_${record.eventType}`,
      aggregateId: record.aggregateId,
      timestamp: new Date(record.occurredAt).toISOString(),
      payload: record.payload,
      metadata: record.metadata || {},
    };
    const timestamp = String(Date.now());
    const signature = signEnvelope(this.webhookSecret, timestamp, envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acg-event-timestamp': timestamp,
          'x-acg-event-signature': signature,
          'x-acg-event-id': envelope.eventId,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ACG Funded webhook returned HTTP ${response.status}`);
      record.status = 'DELIVERED';
      record.deliveredAt = this.now();
      record.lastAttemptAt = this.now();
      record.attempts += 1;
      record.lastError = null;
      await record.save();
    } catch (error) {
      record.attempts += 1;
      record.lastAttemptAt = this.now();
      record.lastError = String(error?.message || error).slice(0, 2000);
      if (record.attempts >= this.maxAttempts) record.status = 'DEAD';
      else record.nextAttemptAt = new Date(this.now().getTime() + retryDelayMs(record.attempts));
      await record.save();
      this.logger?.warn({ err: error, eventId: record.eventId, attempts: record.attempts }, 'Platform event delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

function signEnvelope(secret, timestamp, envelope) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(envelope)}`).digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function retryDelayMs(attempt) { return Math.min(60000, 500 * (2 ** Math.max(0, attempt - 1))); }
function accountIdOf(payload) { return String(payload?.accountId || payload?.id || payload?.account?.id || '').trim(); }
function metadataValue(metadata, key) { if (!metadata) return null; if (metadata instanceof Map) return metadata.get(key) ?? null; return metadata[key] ?? null; }
function decimal(value) { if (value === null || value === undefined) return null; return value?.toString ? value.toString() : String(value); }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

module.exports = { PlatformEventRelay, signEnvelope, canonicalJson, retryDelayMs };
