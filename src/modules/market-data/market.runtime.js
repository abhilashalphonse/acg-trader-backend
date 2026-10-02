'use strict';

const EventEmitter = require('events');
const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { InstrumentRegistry } = require('./instrument-registry');
const { QuoteStore } = require('./quote-store');
const { CandleEngine } = require('./candle-engine');
const { ClosedCandleReconciler } = require('./closed-candle-reconciler');
const { TwelveDataAdapter } = require('./adapters/twelve-data.adapter');
const { AccelpixAdapter } = require('./adapters/accelpix.adapter');
const { MultiProviderAdapter } = require('./adapters/multi-provider.adapter');
const { MarketGateway } = require('./market-gateway');
const { MarketHistoryService } = require('./history.service');
const { DayChangeService } = require('./day-change.service');
const { createMarketWebSocketServer } = require('../../realtime/market-ws-server');
const { ACG_INSTRUMENT_CATALOG } = require('../instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../instruments/india-pilot-catalog');

function createMarketRuntime() {
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(0);
  const includeIndiaPilot = env.market.provider === 'multi' && env.instrumentCatalogAutoSeed;
  const catalogUniverse = includeIndiaPilot
    ? [...ACG_INSTRUMENT_CATALOG, ...ACG_INDIA_PILOT_CATALOG]
    : ACG_INSTRUMENT_CATALOG;
  const symbols = env.market.useCatalogUniverse
    ? catalogUniverse.filter(item => item.chartEnabled && item.status === 'ACTIVE').map(item => item.symbol)
    : env.market.symbols;
  const instrumentRegistry = new InstrumentRegistry({ symbols: symbols, defaultMaxQuoteAgeMs: env.market.defaultMaxQuoteAgeMs, logger });
  const quoteStore = new QuoteStore();
  const twelveDataAdapter = new TwelveDataAdapter({ apiKey: env.twelveData.apiKey, wsUrl: env.twelveData.wsUrl, apiBase: env.twelveData.apiBase, heartbeatMs: env.twelveData.heartbeatMs, reconnectMinMs: env.twelveData.reconnectMinMs, reconnectMaxMs: env.twelveData.reconnectMaxMs, httpTimeoutMs: env.twelveData.httpTimeoutMs, subscribeBatchSize: env.twelveData.subscribeBatchSize, logger });
  twelveDataAdapter.providerName = 'twelve-data';

  const accelpixAdapter = new AccelpixAdapter({ apiKey: env.accelpix.apiKey, host: env.accelpix.host, httpTimeoutMs: env.accelpix.httpTimeoutMs, reconnectMinMs: env.accelpix.reconnectMinMs, reconnectMaxMs: env.accelpix.reconnectMaxMs, maxSymbols: env.accelpix.maxSymbols, logger });
  accelpixAdapter.providerName = 'accelpix';

  const adapter = env.market.provider === 'multi'
    ? new MultiProviderAdapter({ adapters: { 'twelve-data': twelveDataAdapter, accelpix: accelpixAdapter }, logger })
    : twelveDataAdapter;
  const candleEngine = new CandleEngine({ eventBus, timeframes: env.market.candleTimeframes, persistTimeframes: env.market.persistTimeframes, flushIntervalMs: env.market.candleFlushIntervalMs, maxSyntheticGapBars: env.market.maxSyntheticGapBars, instrumentRegistry, logger });
  const historyService = new MarketHistoryService({ adapter, instrumentRegistry, persistTimeframes: env.market.persistTimeframes, logger });
  const closedCandleReconciler = new ClosedCandleReconciler({
    eventBus, adapter, instrumentRegistry, candleEngine, logger,
    requestIntervalMs: env.market.closedCandleRequestIntervalMs,
    invalidateHistory: (symbol, timeframe) => historyService.invalidateSeries(symbol, timeframe),
  });
  const dayChangeService = new DayChangeService({ adapter, instrumentRegistry, quoteStore, eventBus, logger });
  const gateway = new MarketGateway({
    adapter,
    instrumentRegistry,
    quoteStore,
    candleEngine,
    eventBus,
    dayChangeService,
    symbols: symbols,
    staleCheckMs: env.market.staleCheckMs,
    logger,
    // Any history cached before/during a provider outage can be incomplete.
    // Clear it before clients receive the recovered gateway status so their
    // forced history reconciliation fetches authoritative missing OHLC.
    onStreamRecovered: () => {
      historyService.clearCache();
      dayChangeService.invalidate?.();
      candleEngine.invalidateHydration?.();
    },
  });
  async function hydrateCandleState(symbol, timeframe) {
    const token = candleEngine.beginHydration?.(symbol, timeframe);
    if (!token || token.skipped) return candleEngine.getCurrent(symbol, timeframe);

    try {
      const page = await historyService.getCandlePage({
        symbol,
        timeframe,
        limit: 2,
        beforeMs: null,
      });
      if (token.owner) {
        candleEngine.completeHydration?.(token, page.candles[page.candles.length - 1] || null, page.candles);
      } else {
        await candleEngine.waitForHydration?.(token);
      }
      return candleEngine.getCurrent(symbol, timeframe);
    } catch (error) {
      if (token.owner) candleEngine.abortHydration?.(token);
      throw error;
    }
  }

  let wsServer = null;
  let started = false;

  return {
    enabled: env.market.enabled,
    symbols: symbols,
    timeframes: env.market.candleTimeframes,
    persistTimeframes: env.market.persistTimeframes,
    quoteStore,
    candleEngine,
    instrumentRegistry,
    eventBus,
    historyService,
    dayChangeService,
    retainPriority(symbol) { return gateway.retainPriority(symbol); },
    releasePriority(symbol) { return gateway.releasePriority(symbol); },
    priorityCount(symbol) { return gateway.priorityCount(symbol); },
    ensureFreshQuote(symbol, options) { return gateway.ensureFreshQuote(symbol, options); },
    hydrateCandle(symbol, timeframe) { return hydrateCandleState(symbol, timeframe); },
    async start() {
      if (started) return;
      if (!env.market.enabled) {
        started = true;
        logger.warn('Market Gateway is disabled by configuration');
        return;
      }
      if (env.market.closedCandleReconciliationEnabled) closedCandleReconciler.start();
      try { await gateway.start(); }
      catch (error) { await closedCandleReconciler.stop(); throw error; }
      started = true;
      logger.info({ symbols: symbols, timeframes: env.market.candleTimeframes }, 'ACG Market Gateway started');
    },
    attachWebSocket(server, authService, tradingRuntime) {
      if (wsServer) return wsServer;
      wsServer = createMarketWebSocketServer({ server, runtime: this, tradingRuntime, authService, path: env.market.wsPath, corsOrigins: env.corsOrigins, pingIntervalMs: env.market.wsPingIntervalMs, maxBufferBytes: env.market.wsMaxBufferBytes, quoteCoalesceMs: env.market.wsQuoteCoalesceMs, valuationCoalesceMs: env.market.wsValuationCoalesceMs, logger });
      return wsServer;
    },
    async stop() {
      await closedCandleReconciler.stop();
      if (wsServer) { await wsServer.close(); wsServer = null; }
      if (env.market.enabled && started) await gateway.stop();
      started = false;
    },
    health() {
      const websocket = wsServer?.health?.() || { clients: 0, accountSubscriptions: 0, path: env.market.wsPath };
      const historyCache = historyService.cacheStats?.() || null;
      if (!env.market.enabled) return { enabled: false, state: 'DISABLED', symbols: symbols, websocket, historyCache };
      return { enabled: true, ...gateway.status(), websocket, historyCache, closedCandleReconciliation: closedCandleReconciler.status() };
    },
  };
}

module.exports = { createMarketRuntime };
