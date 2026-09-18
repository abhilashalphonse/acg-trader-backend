'use strict';

const EventEmitter = require('events');
const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { InstrumentRegistry } = require('./instrument-registry');
const { QuoteStore } = require('./quote-store');
const { CandleEngine } = require('./candle-engine');
const { TwelveDataAdapter } = require('./adapters/twelve-data.adapter');
const { MarketGateway } = require('./market-gateway');
const { MarketHistoryService } = require('./history.service');
const { createMarketWebSocketServer } = require('../../realtime/market-ws-server');
const { ACG_INSTRUMENT_CATALOG } = require('../instruments/instrument-catalog');

function createMarketRuntime() {
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(0);
  const symbols = env.market.useCatalogUniverse
    ? ACG_INSTRUMENT_CATALOG.filter(item => item.chartEnabled && item.status === 'ACTIVE').map(item => item.symbol)
    : env.market.symbols;
  const instrumentRegistry = new InstrumentRegistry({ symbols: symbols, defaultMaxQuoteAgeMs: env.market.defaultMaxQuoteAgeMs, logger });
  const quoteStore = new QuoteStore();
  const adapter = new TwelveDataAdapter({ apiKey: env.twelveData.apiKey, wsUrl: env.twelveData.wsUrl, apiBase: env.twelveData.apiBase, heartbeatMs: env.twelveData.heartbeatMs, reconnectMinMs: env.twelveData.reconnectMinMs, reconnectMaxMs: env.twelveData.reconnectMaxMs, httpTimeoutMs: env.twelveData.httpTimeoutMs, subscribeBatchSize: env.twelveData.subscribeBatchSize, logger });
  const candleEngine = new CandleEngine({ eventBus, timeframes: env.market.candleTimeframes, persistTimeframes: env.market.persistTimeframes, flushIntervalMs: env.market.candleFlushIntervalMs, maxSyntheticGapBars: env.market.maxSyntheticGapBars, logger });
  const gateway = new MarketGateway({ adapter, instrumentRegistry, quoteStore, candleEngine, eventBus, symbols: symbols, staleCheckMs: env.market.staleCheckMs, logger });
  const historyService = new MarketHistoryService({ adapter, instrumentRegistry, logger });
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
    async start() {
      if (started) return;
      if (!env.market.enabled) {
        started = true;
        logger.warn('Market Gateway is disabled by configuration');
        return;
      }
      await gateway.start();
      started = true;
      logger.info({ symbols: symbols, timeframes: env.market.candleTimeframes }, 'ACG Market Gateway started');
    },
    attachWebSocket(server, authService, tradingRuntime) {
      if (wsServer) return wsServer;
      wsServer = createMarketWebSocketServer({ server, runtime: this, tradingRuntime, authService, path: env.market.wsPath, corsOrigins: env.corsOrigins, pingIntervalMs: env.market.wsPingIntervalMs, maxBufferBytes: env.market.wsMaxBufferBytes, logger });
      return wsServer;
    },
    async stop() {
      if (wsServer) { await wsServer.close(); wsServer = null; }
      if (env.market.enabled && started) await gateway.stop();
      started = false;
    },
    health() {
      const websocket = wsServer?.health?.() || { clients: 0, accountSubscriptions: 0, path: env.market.wsPath };
      if (!env.market.enabled) return { enabled: false, state: 'DISABLED', symbols: symbols, websocket };
      return { enabled: true, ...gateway.status(), websocket };
    },
  };
}

module.exports = { createMarketRuntime };
