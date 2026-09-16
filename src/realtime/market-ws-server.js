'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { normalizeSymbol } = require('../modules/market-data/market.utils');

function createMarketWebSocketServer({ server, runtime, path, corsOrigins, pingIntervalMs, maxBufferBytes, logger }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: true });
  const subscriptions = new WeakMap();
  let outboundSequence = 0;
  let closed = false;

  const envelope = (type, data) => ({
    type,
    sequence: ++outboundSequence,
    timestamp: new Date().toISOString(),
    data,
  });

  const send = (socket, type, data, { lossy = false } = {}) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (lossy && socket.bufferedAmount > maxBufferBytes) return false;
    if (!lossy && socket.bufferedAmount > maxBufferBytes * 4) {
      socket.close(1013, 'Client is too slow');
      return false;
    }
    socket.send(JSON.stringify(envelope(type, data)));
    return true;
  };

  const upgradeHandler = (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== path) { socket.destroy(); return; }

    const origin = request.headers.origin;
    if (origin && !corsOrigins.includes('*') && !corsOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
  };

  server.on('upgrade', upgradeHandler);

  wss.on('connection', socket => {
    socket.isAlive = true;
    subscriptions.set(socket, { quotes: new Set(), ticks: new Set(), candles: new Set() });
    socket.on('pong', () => { socket.isAlive = true; });

    send(socket, 'connection.ready', {
      service: 'acg-trader-backend',
      marketGateway: runtime.health(),
      capabilities: {
        symbols: runtime.symbols,
        timeframes: runtime.timeframes,
        actions: ['subscribe', 'unsubscribe', 'status', 'ping'],
      },
    });

    socket.on('message', buffer => {
      if (buffer.length > 16 * 1024) {
        socket.close(1009, 'Message too large');
        return;
      }

      let message;
      try { message = JSON.parse(buffer.toString()); } catch {
        send(socket, 'error', { code: 'INVALID_JSON', message: 'WebSocket message must be valid JSON' });
        return;
      }
      handleClientMessage(socket, message);
    });

    socket.on('error', error => logger.debug({ err: error }, 'Market WebSocket client error'));
  });

  function handleClientMessage(socket, message) {
    const action = String(message?.action || '').toLowerCase();
    if (action === 'ping') {
      send(socket, 'pong', { clientTimestamp: message?.timestamp ?? null });
      return;
    }
    if (action === 'status') {
      send(socket, 'market.status.snapshot', runtime.health());
      return;
    }
    if (!['subscribe', 'unsubscribe'].includes(action)) {
      send(socket, 'error', { code: 'INVALID_ACTION', message: 'Supported actions: subscribe, unsubscribe, status, ping' });
      return;
    }

    const state = subscriptions.get(socket);
    const requested = normalizeSubscriptionParams(message.params || {});
    const accepted = { quotes: [], ticks: [], candles: [] };
    const rejected = [];

    for (const symbol of requested.quotes) {
      if (!runtime.symbols.includes(symbol)) rejected.push({ channel: 'quote', symbol, reason: 'SYMBOL_NOT_CONFIGURED' });
      else { state.quotes[action === 'subscribe' ? 'add' : 'delete'](symbol); accepted.quotes.push(symbol); }
    }
    for (const symbol of requested.ticks) {
      if (!runtime.symbols.includes(symbol)) rejected.push({ channel: 'tick', symbol, reason: 'SYMBOL_NOT_CONFIGURED' });
      else { state.ticks[action === 'subscribe' ? 'add' : 'delete'](symbol); accepted.ticks.push(symbol); }
    }
    for (const item of requested.candles) {
      if (!runtime.symbols.includes(item.symbol)) rejected.push({ channel: 'candle', ...item, reason: 'SYMBOL_NOT_CONFIGURED' });
      else if (!runtime.timeframes.includes(item.timeframe)) rejected.push({ channel: 'candle', ...item, reason: 'TIMEFRAME_NOT_CONFIGURED' });
      else {
        const key = `${item.symbol}:${item.timeframe}`;
        state.candles[action === 'subscribe' ? 'add' : 'delete'](key);
        accepted.candles.push(item);
      }
    }

    send(socket, 'subscription.status', { action, accepted, rejected });

    if (action === 'subscribe') {
      for (const symbol of accepted.quotes) {
        const quote = runtime.quoteStore.get(symbol);
        if (quote) send(socket, 'market.quote', quote, { lossy: true });
      }
      for (const item of accepted.candles) {
        const candle = runtime.candleEngine.getCurrent(item.symbol, item.timeframe);
        if (candle) send(socket, 'market.candle.update', candle, { lossy: true });
      }
    }
  }

  function normalizeSubscriptionParams(params) {
    const quotes = Array.isArray(params.quotes) ? params.quotes.map(normalizeSymbol).filter(Boolean) : [];
    const ticks = Array.isArray(params.ticks) ? params.ticks.map(normalizeSymbol).filter(Boolean) : [];
    const candles = Array.isArray(params.candles) ? params.candles.flatMap(item => {
      const symbol = normalizeSymbol(item?.symbol);
      const timeframe = String(item?.timeframe || '').toLowerCase();
      return symbol && timeframe ? [{ symbol, timeframe }] : [];
    }) : [];
    return { quotes: [...new Set(quotes)], ticks: [...new Set(ticks)], candles };
  }

  const broadcastQuote = quote => {
    for (const socket of wss.clients) if (subscriptions.get(socket)?.quotes.has(quote.symbol)) send(socket, 'market.quote', quote, { lossy: true });
  };
  const broadcastTick = tick => {
    for (const socket of wss.clients) if (subscriptions.get(socket)?.ticks.has(tick.symbol)) send(socket, 'market.tick', tick, { lossy: true });
  };
  const broadcastCandleUpdate = candle => {
    const key = `${candle.symbol}:${candle.timeframe}`;
    for (const socket of wss.clients) if (subscriptions.get(socket)?.candles.has(key)) send(socket, 'market.candle.update', candle, { lossy: true });
  };
  const broadcastCandleClosed = candle => {
    const key = `${candle.symbol}:${candle.timeframe}`;
    for (const socket of wss.clients) if (subscriptions.get(socket)?.candles.has(key)) send(socket, 'market.candle.closed', candle);
  };
  const broadcastStatus = status => {
    for (const socket of wss.clients) send(socket, 'market.status', status);
  };

  runtime.eventBus.on('market.quote', broadcastQuote);
  runtime.eventBus.on('market.tick', broadcastTick);
  runtime.eventBus.on('market.candle.update', broadcastCandleUpdate);
  runtime.eventBus.on('market.candle.closed', broadcastCandleClosed);
  runtime.eventBus.on('market.status', broadcastStatus);

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, pingIntervalMs);
  heartbeatTimer.unref?.();

  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      server.off('upgrade', upgradeHandler);
      runtime.eventBus.off('market.quote', broadcastQuote);
      runtime.eventBus.off('market.tick', broadcastTick);
      runtime.eventBus.off('market.candle.update', broadcastCandleUpdate);
      runtime.eventBus.off('market.candle.closed', broadcastCandleClosed);
      runtime.eventBus.off('market.status', broadcastStatus);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
    },
  };
}

module.exports = { createMarketWebSocketServer };
