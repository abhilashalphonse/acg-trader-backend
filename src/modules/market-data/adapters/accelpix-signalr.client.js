'use strict';

const signalR = require('@microsoft/signalr');
const { MessagePackHubProtocol } = require('@microsoft/signalr-protocol-msgpack');

const EPOCH_1980_MS = Date.UTC(1980, 0, 1);

function charCode(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String.fromCharCode(number) : '';
}

function rawProviderDate(secondsSince1980) {
  const seconds = Number(secondsSince1980);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(EPOCH_1980_MS + seconds * 1000);
}

function decodeTradePacket(message, { snapshot = false } = {}) {
  if (!Array.isArray(message)) return null;
  return {
    id: message[0],
    ticker: message[1],
    segmentId: message[2],
    time: rawProviderDate(message[3]),
    rawTimeSeconds: Number(message[3]),
    price: message[4],
    qty: message[5],
    volume: message[6],
    oi: message[7],
    kind: charCode(message[8]),
    snapshot,
  };
}

function decodeBestPacket(message, { snapshot = false } = {}) {
  if (!Array.isArray(message)) return null;
  return {
    ticker: message[0],
    segmentId: message[1],
    kind: charCode(message[2]),
    bidPrice: message[3],
    bidQty: message[4],
    askPrice: message[5],
    askQty: message[6],
    time: rawProviderDate(message[7]),
    rawTimeSeconds: Number(message[7]),
    snapshot,
  };
}

function decodeRefsPacket(message, { snapshot = false } = {}) {
  if (!Array.isArray(message)) return null;
  if (!snapshot) {
    return {
      kind: charCode(message[0]),
      ticker: message[1],
      segmentId: message[2],
      price: message[3],
      snapshot: false,
    };
  }
  return {
    kind: charCode(message[0]),
    ticker: message[1],
    segmentId: message[2],
    open: message[3],
    close: message[4],
    high: message[5],
    low: message[6],
    avg: message[7],
    oi: message[8],
    upperBand: message[9],
    lowerBand: message[10],
    poi: message[11],
    snapshot: true,
  };
}

function createCallbacks() {
  const handlers = {
    connected: null,
    closed: null,
    reconnecting: null,
    reconnected: null,
    subscriptionError: null,
    trade: null,
    tradeSnapshot: null,
    best: null,
    refs: null,
    refsSnapshot: null,
  };

  return {
    handlers,
    api: {
      onConnected(callback) { handlers.connected = callback; },
      onClosed(callback) { handlers.closed = callback; },
      onReconnecting(callback) { handlers.reconnecting = callback; },
      onReconnected(callback) { handlers.reconnected = callback; },
      onSubscriptionError(callback) { handlers.subscriptionError = callback; },
      onTrade(callback) { handlers.trade = callback; },
      onTradeSnapshot(callback) { handlers.tradeSnapshot = callback; },
      onBest(callback) { handlers.best = callback; },
      onRefs(callback) { handlers.refs = callback; },
      onRefsSnapshot(callback) { handlers.refsSnapshot = callback; },
    },
  };
}

class AccelpixSignalRClient {
  constructor({
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    logger = null,
  } = {}) {
    this.reconnectMinMs = Math.max(250, Number(reconnectMinMs) || 1000);
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, Number(reconnectMaxMs) || 30000);
    this.logger = logger;

    const callbacks = createCallbacks();
    this.callbackHandlers = callbacks.handlers;
    this.callbacks = callbacks.api;

    this.connection = null;
    this.subscriptionSymbols = new Set();
    this.initializing = null;

    this.stream = Object.freeze({
      subscribeAll: symbols => this.subscribeAll(symbols),
      unsubscribeAll: symbols => this.unsubscribeAll(symbols),
    });
  }

  async initialize(apiKey, apiHost = 'apidata.accelpix.in', scheme = 'https') {
    if (!apiKey) throw new Error('ACCELPIX_API_KEY is required');

    if (
      this.connection
      && this.connection.state === signalR.HubConnectionState.Connected
    ) {
      return;
    }
    if (this.initializing) return this.initializing;

    this.initializing = this.#initialize(apiKey, apiHost, scheme)
      .finally(() => {
        this.initializing = null;
      });
    return this.initializing;
  }

  async #initialize(apiKey, apiHost, scheme) {
    if (this.connection) {
      try {
        await this.connection.stop();
      } catch {
        // Rebuild from a clean SignalR object below.
      }
    }

    const host = String(apiHost || 'apidata.accelpix.in')
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
    const protocol = String(scheme || 'https').replace(/:$/, '');
    const token = encodeURIComponent(apiKey);
    const rawUrl = `${protocol}://${host}/api/fda/apidata/stream?api_token=${token}`;

    const connection = new signalR.HubConnectionBuilder()
      // SignalR's information-level connect log includes the full WebSocket
      // URL, which contains the Accelpix api_token query parameter. Keep the
      // transport logger at warning-or-higher so credentials never enter
      // application/deployment logs.
      .configureLogging(signalR.LogLevel.Warning)
      .withUrl(encodeURI(rawUrl))
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: context => {
          const attempt = Math.max(0, Number(context?.previousRetryCount) || 0);
          return Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** attempt));
        },
      })
      .withHubProtocol(new MessagePackHubProtocol())
      .build();

    this.connection = connection;
    this.#registerHandlers(connection);

    await connection.start();
    if (connection !== this.connection) {
      await connection.stop().catch(() => undefined);
      return;
    }

    this.callbackHandlers.connected?.();
  }

  #registerHandlers(connection) {
    connection.on('_t', message => {
      const decoded = decodeTradePacket(message, { snapshot: true });
      if (decoded) this.callbackHandlers.tradeSnapshot?.(decoded);
    });
    connection.on('t', message => {
      const decoded = decodeTradePacket(message);
      if (decoded) this.callbackHandlers.trade?.(decoded);
    });
    connection.on('_b', message => {
      const decoded = decodeBestPacket(message, { snapshot: true });
      if (decoded) this.callbackHandlers.best?.(decoded);
    });
    connection.on('b', message => {
      const decoded = decodeBestPacket(message);
      if (decoded) this.callbackHandlers.best?.(decoded);
    });
    connection.on('f', message => {
      const decoded = decodeRefsPacket(message);
      if (decoded) this.callbackHandlers.refs?.(decoded);
    });
    connection.on('_r', message => {
      const decoded = decodeRefsPacket(message, { snapshot: true });
      if (decoded) this.callbackHandlers.refsSnapshot?.(decoded);
    });

    // The vendor SDK handles the server-side Shutdown hub event by closing
    // the connection. Preserve that behavior so the adapter's normal reconnect
    // path can establish a clean session.
    connection.on('Shutdown', async message => {
      this.logger?.warn?.({ message }, 'Accelpix requested SignalR shutdown');
      await connection.stop().catch(() => undefined);
    });

    connection.onreconnecting(error => {
      this.callbackHandlers.reconnecting?.(error || null);
    });

    connection.onreconnected(async () => {
      try {
        if (this.subscriptionSymbols.size) {
          await connection.invoke('SubscribeAll', [...this.subscriptionSymbols]);
        }
        this.callbackHandlers.reconnected?.();
      } catch (error) {
        this.logger?.warn?.({ err: error }, 'Accelpix resubscription failed after SignalR reconnect');
        this.callbackHandlers.subscriptionError?.(error);
        await connection.stop().catch(() => undefined);
      }
    });

    connection.onclose(error => {
      if (connection !== this.connection) return;
      this.callbackHandlers.closed?.(error || null);
    });
  }

  async subscribeAll(symbols) {
    const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(String).filter(Boolean))];
    if (!list.length) return null;
    this.#assertConnected();

    const result = await this.connection.invoke('SubscribeAll', list);
    for (const symbol of list) this.subscriptionSymbols.add(symbol);
    return result;
  }

  async unsubscribeAll(symbols) {
    const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(String).filter(Boolean))];
    if (!list.length) return null;

    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      for (const symbol of list) this.subscriptionSymbols.delete(symbol);
      return null;
    }

    const result = await this.connection.invoke('UnsubscribeAll', list);
    for (const symbol of list) this.subscriptionSymbols.delete(symbol);
    return result;
  }

  async disconnect() {
    const connection = this.connection;
    this.connection = null;
    this.subscriptionSymbols.clear();
    if (!connection) return;
    await connection.stop();
  }

  #assertConnected() {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      const error = new Error('Accelpix SignalR connection is not connected');
      error.code = 'ACCELPIX_NOT_CONNECTED';
      throw error;
    }
  }
}

function createAccelpixSignalRClient(options) {
  return new AccelpixSignalRClient(options);
}

module.exports = {
  AccelpixSignalRClient,
  createAccelpixSignalRClient,
  decodeTradePacket,
  decodeBestPacket,
  decodeRefsPacket,
  rawProviderDate,
};
