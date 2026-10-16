'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { normalizeSymbol } = require('../modules/market-data/market.utils');
const { TraderStateService } = require('./trader-state.service');

const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
const MAX_SYNC_BUFFER_EVENTS = 1000;
const AUTH_REVALIDATE_MS = 60_000;
// Poll global-user grants on every replica; MongoDB is authoritative. Existing
// ACG Funded sessions continue using their original revalidation cadence.
const SUPABASE_GRANT_POLL_MS = 2_000;

function createMarketWebSocketServer({ server, runtime, tradingRuntime, authService, path, corsOrigins, pingIntervalMs, maxBufferBytes, quoteCoalesceMs = 250, valuationCoalesceMs = 250, logger, traderStateService: suppliedStateService = null }) {
  if (!tradingRuntime?.valuationEngine) throw new Error('tradingRuntime with valuationEngine is required');
  const traderStateService = suppliedStateService || new TraderStateService({ valuationEngine: tradingRuntime.valuationEngine });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: true,
    handleProtocols(protocols) { return protocols.has('acg-trader') ? 'acg-trader' : false; },
  });
  const subscriptions = new WeakMap();
  let outboundSequence = 0;
  let closed = false;
  const pendingResyncSockets = new Set();
  const resyncWork = new Set();
  let resyncTimer = null;
  const egress = {
    messages: 0,
    bytes: 0,
    droppedLossy: 0,
    closedSlowClients: 0,
    byType: new Map(),
  };

  const envelope = (type, data) => ({ type, sequence: ++outboundSequence, timestamp: new Date().toISOString(), data });
  const send = (socket, type, data, { lossy = false } = {}) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (lossy && socket.bufferedAmount > maxBufferBytes) {
      egress.droppedLossy += 1;
      return false;
    }
    if (!lossy && socket.bufferedAmount > maxBufferBytes * 4) {
      egress.closedSlowClients += 1;
      socket.close(1013, 'Client is too slow');
      return false;
    }

    const serialized = JSON.stringify(envelope(type, data));
    const bytes = Buffer.byteLength(serialized);
    socket.send(serialized);
    egress.messages += 1;
    egress.bytes += bytes;
    const current = egress.byType.get(type) || { messages: 0, bytes: 0 };
    current.messages += 1;
    current.bytes += bytes;
    egress.byType.set(type, current);
    return true;
  };

  const upgradeHandler = async (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== path) { socket.destroy(); return; }
    const origin = request.headers.origin;
    if (origin && !corsOrigins.includes('*') && !corsOrigins.includes(origin)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    try {
      const token = websocketAccessToken(request);
      if (!token) { rejectUpgrade(socket, 401, 'Unauthorized'); return; }
      request.traderAccessToken = token;
      request.traderPrincipal = await authService.authenticateSessionToken(token);
    } catch {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
  };
  server.on('upgrade', upgradeHandler);

  wss.on('connection', (socket, request) => {
    socket.isAlive = true;
    socket.traderPrincipal = request.traderPrincipal;
    socket.traderAccessToken = request.traderAccessToken;
    socket.lastAuthCheckAt = Date.now();
    const grantedAccounts = new Set(socket.traderPrincipal.accountIds.map(String));
    subscriptions.set(socket, {
      quotes: new Set(),
      ticks: new Set(),
      candles: new Set(),
      accounts: new Set(grantedAccounts),
      syncingAccounts: new Set(grantedAccounts),
      pendingAccountEvents: [],
      quotePending: new Map(),
      quoteTimers: new Map(),
      valuationPending: new Map(),
      valuationTimers: new Map(),
      resyncAccounts: new Set(),
      resyncInFlight: false,
    });
    socket.on('pong', () => { socket.isAlive = true; });
    send(socket, 'connection.ready', {
      service: 'acg-trader-backend',
      tenantId: socket.traderPrincipal.tenantId,
      accounts: socket.traderPrincipal.accountIds,
      sessionExpiresAt: socket.traderPrincipal.expiresAt,
      marketGateway: runtime.health(),
      capabilities: {
        symbols: runtime.symbols,
        timeframes: runtime.timeframes,
        marketChannels: ['quote', 'tick', 'candle'],
        tradingChannels: ['account', 'valuation', 'order', 'fill', 'position', 'control'],
        actions: ['subscribe', 'unsubscribe', 'snapshot', 'status', 'ping'],
      },
    });

    void syncAccounts(socket, [...grantedAccounts], 'initial').catch(error => {
      logger.error({ err: error, sessionId: socket.traderPrincipal?.sessionId }, 'Initial trader WebSocket state sync failed');
      send(socket, 'error', { code: error?.code || 'STATE_SYNC_FAILED', message: 'Unable to synchronize trading state' });
      socket.close(1011, 'State synchronization failed');
    });

    socket.on('message', buffer => {
      if (buffer.length > MAX_CLIENT_MESSAGE_BYTES) { socket.close(1009, 'Message too large'); return; }
      let message;
      try { message = JSON.parse(buffer.toString()); } catch { send(socket, 'error', { code: 'INVALID_JSON', message: 'WebSocket message must be valid JSON' }); return; }
      void handleClientMessage(socket, message).catch(error => {
        logger.debug({ err: error }, 'Trader WebSocket client command failed');
        send(socket, 'error', { code: error?.code || 'WEBSOCKET_COMMAND_FAILED', message: error?.message || 'WebSocket command failed' });
      });
    });
    socket.on('error', error => logger.debug({ err: error }, 'Trader WebSocket client error'));
    socket.on('close', () => {
      const state = subscriptions.get(socket);
      if (!state) return;
      for (const symbol of state.quotes) runtime.releasePriority?.(symbol);
      state.quotes.clear();
      clearCoalescedTimers(state);
    });

  });

  async function handleClientMessage(socket, message) {
    // Do not authorize new account subscriptions against stale grants.
    if (socket.traderPrincipal?.authMethod === 'SUPABASE') {
      await refreshSupabaseSocketPrincipal(socket);
      if (socket.readyState !== WebSocket.OPEN) return;
    }
    const action = String(message?.action || '').toLowerCase();
    if (action === 'ping') { send(socket, 'pong', { clientTimestamp: message?.timestamp ?? null }); return; }
    if (action === 'status') {
      const state = subscriptions.get(socket);
      send(socket, 'connection.status', {
        market: runtime.health(),
        accounts: [...state.accounts],
        quotes: [...state.quotes],
        ticks: [...state.ticks],
        candles: [...state.candles],
      });
      return;
    }
    if (action === 'snapshot') {
      const requested = normalizeAccountIds(message?.params?.accounts, socket.traderPrincipal.accountIds);
      const accepted = validateAccountGrants(socket, requested);
      await syncAccounts(socket, accepted, 'requested');
      return;
    }
    if (!['subscribe', 'unsubscribe'].includes(action)) {
      send(socket, 'error', { code: 'INVALID_ACTION', message: 'Supported actions: subscribe, unsubscribe, snapshot, status, ping' });
      return;
    }

    const state = subscriptions.get(socket);
    const requested = normalizeSubscriptionParams(message.params || {});
    const accepted = { quotes: [], ticks: [], candles: [], accounts: [] };
    const rejected = [];

    for (const accountId of requested.accounts) {
      if (!socket.traderPrincipal.accountIds.includes(accountId)) rejected.push({ channel: 'account', accountId, reason: 'ACCOUNT_ACCESS_FORBIDDEN' });
      else {
        state.accounts[action === 'subscribe' ? 'add' : 'delete'](accountId);
        accepted.accounts.push(accountId);
      }
    }
    for (const symbol of requested.quotes) {
      if (!runtime.symbols.includes(symbol)) {
        rejected.push({ channel: 'quote', symbol, reason: 'SYMBOL_NOT_CONFIGURED' });
      } else if (action === 'subscribe') {
        if (!state.quotes.has(symbol)) {
          state.quotes.add(symbol);
          runtime.retainPriority?.(symbol);
        }
        accepted.quotes.push(symbol);
      } else {
        if (state.quotes.delete(symbol)) runtime.releasePriority?.(symbol);
        cancelScheduled(state.quotePending, state.quoteTimers, symbol);
        accepted.quotes.push(symbol);
      }
    }
    for (const symbol of requested.ticks) {
      if (!runtime.symbols.includes(symbol)) rejected.push({ channel: 'tick', symbol, reason: 'SYMBOL_NOT_CONFIGURED' });
      else {
        state.ticks[action === 'subscribe' ? 'add' : 'delete'](symbol);
        if (action === 'subscribe') cancelScheduled(state.quotePending, state.quoteTimers, symbol);
        accepted.ticks.push(symbol);
      }
    }
    for (const item of requested.candles) {
      if (!runtime.symbols.includes(item.symbol)) rejected.push({ channel: 'candle', ...item, reason: 'SYMBOL_NOT_CONFIGURED' });
      else if (!runtime.timeframes.includes(item.timeframe)) rejected.push({ channel: 'candle', ...item, reason: 'TIMEFRAME_NOT_CONFIGURED' });
      else { const key = `${item.symbol}:${item.timeframe}`; state.candles[action === 'subscribe' ? 'add' : 'delete'](key); accepted.candles.push(item); }
    }
    send(socket, 'subscription.status', { action, accepted, rejected });

    if (action === 'subscribe') {
      for (const symbol of accepted.quotes) { const quote = runtime.quoteStore.get(symbol); if (quote) send(socket, 'market.quote', quote, { lossy: true }); }
      for (const item of accepted.candles) {
        try {
          await runtime.hydrateCandle?.(item.symbol, item.timeframe);
        } catch (error) {
          logger?.warn?.({ err: error, symbol: item.symbol, timeframe: item.timeframe }, 'Candle hydration failed during subscription');
        }
        const candle = runtime.candleEngine.getCurrent(item.symbol, item.timeframe);
        if (candle) send(socket, 'market.candle.update', candle, { lossy: true });
      }
      if (accepted.accounts.length) await syncAccounts(socket, accepted.accounts, 'subscription');
    } else {
      for (const accountId of accepted.accounts) {
        state.syncingAccounts.delete(accountId);
        state.pendingAccountEvents = state.pendingAccountEvents.filter(item => item.accountId !== accountId);
        cancelScheduled(state.valuationPending, state.valuationTimers, accountId);
        for (const key of [...state.valuationTimers.keys()]) {
          if (String(key).startsWith(`position:${accountId}:`)) {
            cancelScheduled(state.valuationPending, state.valuationTimers, key);
          }
        }
      }
    }
  }

  async function refreshSupabaseSocketPrincipal(socket) {
    if (socket.traderPrincipal?.authMethod !== 'SUPABASE') return;
    if (socket.globalGrantRefresh) return socket.globalGrantRefresh;
    const pending = (async () => {
      const principal = await authService.authenticateSessionToken(socket.traderAccessToken);
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.traderPrincipal = principal;
      await reconcileSocketAccountGrants(socket, principal);
    })();
    socket.globalGrantRefresh = pending;
    try {
      await pending;
    } catch (error) {
      logger?.warn?.({ err: error, sessionId: socket.traderPrincipal?.sessionId },
        'Supabase trader WebSocket grants unavailable, closing to fail closed');
      socket.close(4003, 'Trading access expired or revoked');
      throw error;
    } finally {
      if (socket.globalGrantRefresh === pending) socket.globalGrantRefresh = null;
    }
  }

  async function syncAccounts(socket, accountIds, reason) {
    const state = subscriptions.get(socket);
    if (!state) return;
    const ids = validateAccountGrants(socket, accountIds).filter(id => state.accounts.has(id));
    if (!ids.length) {
      send(socket, 'trading.state.snapshot', { reason, accounts: [] });
      return;
    }
    for (const id of ids) state.syncingAccounts.add(id);
    try {
      const snapshots = await traderStateService.snapshotAccounts({
        tenantId: socket.traderPrincipal.tenantId,
        accountIds: ids,
      });
      // Grants can change while the database snapshot is being read.
      send(socket, 'trading.state.snapshot', { reason, accounts: snapshots.filter(snapshot => state.accounts.has(String(snapshot.account.id))) });
    } finally {
      for (const id of ids) state.syncingAccounts.delete(id);
      flushPendingAccountEvents(socket, new Set(ids));
    }
  }

  async function reconcileSocketAccountGrants(socket, principal) {
    const state = subscriptions.get(socket);
    if (!state) return;

    const desired = new Set((principal?.accountIds || []).map(String));
    const current = new Set([...state.accounts].map(String));
    const { added, removed } = accountGrantDiff(current, desired);

    for (const accountId of removed) {
      state.accounts.delete(accountId);
      state.syncingAccounts.delete(accountId);
      state.pendingAccountEvents = state.pendingAccountEvents.filter(item => item.accountId !== accountId);
      cancelScheduled(state.valuationPending, state.valuationTimers, accountId);
      for (const key of [...state.valuationTimers.keys()]) {
        if (String(key).startsWith(`position:${accountId}:`)) {
          cancelScheduled(state.valuationPending, state.valuationTimers, key);
        }
      }
    }

    for (const accountId of added) state.accounts.add(accountId);

    if (added.length) await syncAccounts(socket, added, 'grant-refresh');
    if (added.length || removed.length) {
      send(socket, 'trading.account.grants', {
        accounts: [...desired],
        selectedAccountId: principal?.selectedAccountId || null,
        added,
        removed,
      });
    }
  }

  function validateAccountGrants(socket, accountIds) {
    const grants = new Set(socket.traderPrincipal.accountIds.map(String));
    const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
    const forbidden = ids.find(id => !grants.has(id));
    if (forbidden) {
      const error = new Error('Trading session does not grant access to this account');
      error.code = 'ACCOUNT_ACCESS_FORBIDDEN';
      throw error;
    }
    return ids;
  }

  function normalizeSubscriptionParams(params) {
    const quotes = Array.isArray(params.quotes) ? params.quotes.map(normalizeSymbol).filter(Boolean) : [];
    const ticks = Array.isArray(params.ticks) ? params.ticks.map(normalizeSymbol).filter(Boolean) : [];
    const accounts = normalizeAccountIds(params.accounts, []);
    const candles = Array.isArray(params.candles) ? params.candles.flatMap(item => {
      const symbol = normalizeSymbol(item?.symbol);
      const timeframe = String(item?.timeframe || '').toLowerCase();
      return symbol && timeframe ? [{ symbol, timeframe }] : [];
    }) : [];
    return { quotes: [...new Set(quotes)], ticks: [...new Set(ticks)], candles, accounts };
  }

  function normalizeAccountIds(value, fallback) {
    if (value == null) return [...new Set((fallback || []).map(String).filter(Boolean))];
    return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
  }

  function clearCoalescedTimers(state) {
    for (const timer of state.quoteTimers.values()) clearTimeout(timer);
    for (const timer of state.valuationTimers.values()) clearTimeout(timer);
    state.quoteTimers.clear();
    state.valuationTimers.clear();
    state.quotePending.clear();
    state.valuationPending.clear();
    state.resyncAccounts.clear();
  }

  function scheduleResyncPump(delay = 250) {
    if (closed || resyncTimer || !pendingResyncSockets.size) return;
    resyncTimer = setTimeout(() => { resyncTimer = null; pumpResyncs(); }, delay);
    resyncTimer.unref?.();
  }

  function pumpResyncs() {
    if (closed) return;
    // Bound the additional database work when many accounts change on another replica.
    for (const socket of pendingResyncSockets) {
      if (resyncWork.size >= 4) break;
      const state = subscriptions.get(socket);
      if (!state || socket.readyState !== WebSocket.OPEN) { pendingResyncSockets.delete(socket); continue; }
      if (state.resyncInFlight || state.syncingAccounts.size) continue;
      pendingResyncSockets.delete(socket);
      const ids = [...state.resyncAccounts].filter(id => state.accounts.has(id));
      state.resyncAccounts.clear();
      if (!ids.length) continue;
      state.resyncInFlight = true;
      const work = syncAccounts(socket, ids, 'remote-reconciliation').catch(error => {
        logger?.error?.({ err: error }, 'Remote trader state synchronization failed');
        socket.close(1011, 'State synchronization failed');
      }).finally(() => {
        state.resyncInFlight = false;
        resyncWork.delete(work);
        clearTimeout(resyncTimer); resyncTimer = null;
        scheduleResyncPump(1);
      });
      resyncWork.add(work);
    }
    scheduleResyncPump();
  }

  const onAccountReconciled = ({ accountId, tenantId }) => {
    if (closed) return;
    for (const socket of wss.clients) {
      const state = subscriptions.get(socket);
      if (!state?.accounts.has(String(accountId)) || String(socket.traderPrincipal.tenantId) !== String(tenantId)) continue;
      state.resyncAccounts.add(String(accountId));
      pendingResyncSockets.add(socket);
    }
    scheduleResyncPump();
  };
  runtime.eventBus.on('trading.account.reconciled', onAccountReconciled);

  function cancelScheduled(pendingMap, timerMap, key) {
    const timer = timerMap.get(key);
    if (timer) clearTimeout(timer);
    timerMap.delete(key);
    pendingMap.delete(key);
  }

  function scheduleLatest(state, pendingMap, timerMap, key, delayMs, callback) {
    pendingMap.set(key, callback);
    if (timerMap.has(key)) return;
    const timer = setTimeout(() => {
      timerMap.delete(key);
      const latest = pendingMap.get(key);
      pendingMap.delete(key);
      latest?.();
    }, Math.max(1, delayMs));
    timer.unref?.();
    timerMap.set(key, timer);
  }

  function routeAccountEvent(type, payload, { coalesceMs = 0, coalesceKey = null } = {}) {
    const accountId = accountIdFromPayload(payload);
    if (!accountId) return;
    for (const socket of wss.clients) {
      const state = subscriptions.get(socket);
      if (!state?.accounts.has(accountId)) continue;
      if (state.syncingAccounts.has(accountId)) {
        if (state.pendingAccountEvents.length >= MAX_SYNC_BUFFER_EVENTS) { socket.close(1013, 'State synchronization overflow'); continue; }
        state.pendingAccountEvents.push({ accountId, type, data: payload });
        continue;
      }
      if (coalesceMs > 0) {
        scheduleLatest(
          state,
          state.valuationPending,
          state.valuationTimers,
          typeof coalesceKey === 'function' ? coalesceKey(payload, accountId) : accountId,
          coalesceMs,
          () => state.accounts.has(accountId) && send(socket, type, payload, { lossy: true }),
        );
        continue;
      }
      send(socket, type, payload);
    }
  }

  function flushPendingAccountEvents(socket, accountIds) {
    const state = subscriptions.get(socket);
    if (!state?.pendingAccountEvents.length) return;
    const remaining = [];
    for (const item of state.pendingAccountEvents) {
      if (accountIds.has(item.accountId) && state.accounts.has(item.accountId)) send(socket, item.type, item.data);
      else remaining.push(item);
    }
    state.pendingAccountEvents = remaining;
  }

  const broadcastQuote = quote => {
    for (const socket of wss.clients) {
      const state = subscriptions.get(socket);
      if (!state?.quotes.has(quote.symbol)) continue;

      // If the client already receives full-frequency ticks for this symbol,
      // the tick contains the same bid/ask/last fields. Suppress the duplicate
      // quote stream and let the frontend mirror the tick into quote state.
      if (state.ticks.has(quote.symbol) && quote.referenceUpdate !== true) continue;

      scheduleLatest(
        state,
        state.quotePending,
        state.quoteTimers,
        quote.symbol,
        quoteCoalesceMs,
        () => send(socket, 'market.quote', quote, { lossy: true }),
      );
    }
  };
  const broadcastTick = tick => { for (const socket of wss.clients) if (subscriptions.get(socket)?.ticks.has(tick.symbol)) send(socket, 'market.tick', tick, { lossy: true }); };
  const broadcastCandleUpdate = candle => { const key = `${candle.symbol}:${candle.timeframe}`; for (const socket of wss.clients) if (subscriptions.get(socket)?.candles.has(key)) send(socket, 'market.candle.update', candle, { lossy: true }); };
  const broadcastCandleClosed = candle => { const key = `${candle.symbol}:${candle.timeframe}`; for (const socket of wss.clients) if (subscriptions.get(socket)?.candles.has(key)) send(socket, 'market.candle.closed', candle); };
  const broadcastCandleCorrected = candle => { const key = `${candle.symbol}:${candle.timeframe}`; for (const socket of wss.clients) if (subscriptions.get(socket)?.candles.has(key)) send(socket, 'market.candle.corrected', candle); };
  const broadcastStatus = status => { for (const socket of wss.clients) send(socket, 'market.status', status); };

  const eventRoutes = new Map([
    ['trading.order.accepted', ['trading.order', payload => ({ event: 'accepted', order: payload })]],
    ['trading.order.pending', ['trading.order', payload => ({ event: 'pending', order: payload })]],
    ['trading.order.triggered', ['trading.order', payload => ({ event: 'triggered', order: payload })]],
    ['trading.order.filled', ['trading.order', payload => ({ event: 'filled', order: payload })]],
    ['trading.order.cancelled', ['trading.order', payload => ({ event: 'cancelled', order: payload })]],
    ['trading.order.expired', ['trading.order', payload => ({ event: 'expired', order: payload })]],
    ['trading.order.rejected', ['trading.order', payload => ({ event: 'rejected', order: payload })]],
    ['trading.deal.created', ['trading.fill', payload => ({ event: 'created', fill: payload })]],
    ['trading.position.opened', ['trading.position', payload => ({ event: 'opened', position: payload })]],
    ['trading.position.updated', ['trading.position', payload => ({ event: 'updated', position: payload })]],
    ['trading.position.closed', ['trading.position', payload => ({ event: 'closed', position: payload })]],
    ['trading.account.updated', ['trading.account', payload => ({ event: 'updated', account: payload })]],
    ['valuation.account.updated', ['trading.account.valuation', payload => payload, { coalesceMs: valuationCoalesceMs }]],
    ['valuation.position.updated', ['trading.position.valuation', payload => payload, {
      coalesceMs: valuationCoalesceMs,
      coalesceKey: (payload, accountId) => `position:${accountId}:${payload?.id || payload?.positionId || 'unknown'}`,
    }]],
    ['trading.account.balance.updated', ['trading.account.balance', payload => payload]],
    ['trading.account.paused', ['trading.account.control', payload => ({ event: 'paused', account: payload })]],
    ['trading.account.resumed', ['trading.account.control', payload => ({ event: 'resumed', account: payload })]],
    ['trading.account.disabled', ['trading.account.control', payload => ({ event: 'disabled', account: payload })]],
    ['trading.account.breached', ['trading.account.control', payload => ({ event: 'breached', account: payload })]],
    ['trading.account.closing', ['trading.account.control', payload => ({ event: 'closing', account: payload })]],
    ['trading.account.closed', ['trading.account.control', payload => ({ event: 'closed', account: payload })]],
  ]);
  const tradingListeners = [];
  for (const [sourceEvent, [targetType, transform, routeOptions]] of eventRoutes) {
    const listener = payload => routeAccountEvent(targetType, transform(payload), routeOptions);
    runtime.eventBus.on(sourceEvent, listener);
    tradingListeners.push([sourceEvent, listener]);
  }

  runtime.eventBus.on('market.quote', broadcastQuote);
  runtime.eventBus.on('market.tick', broadcastTick);
  runtime.eventBus.on('market.candle.update', broadcastCandleUpdate);
  runtime.eventBus.on('market.candle.closed', broadcastCandleClosed);
  runtime.eventBus.on('market.candle.corrected', broadcastCandleCorrected);
  runtime.eventBus.on('market.status', broadcastStatus);

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      if (new Date(socket.traderPrincipal.expiresAt).getTime() <= Date.now()) { socket.close(4001, 'Trading session expired'); continue; }
      if (socket.traderPrincipal.authMethod !== 'SUPABASE' && Date.now() - socket.lastAuthCheckAt >= AUTH_REVALIDATE_MS) {
        socket.lastAuthCheckAt = Date.now();
        void authService.authenticateSessionToken(socket.traderAccessToken).then(principal => {
          socket.traderPrincipal = principal;
          void reconcileSocketAccountGrants(socket, principal).catch(error => {
            logger.warn({ err: error, sessionId: principal?.sessionId }, 'Trader WebSocket grant reconciliation failed');
            send(socket, 'error', { code: error?.code || 'ACCOUNT_GRANT_SYNC_FAILED', message: 'Unable to synchronize updated account grants' });
          });
        }).catch(() => socket.close(4001, 'Trading session invalid'));
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, pingIntervalMs);
  heartbeatTimer.unref?.();

  // The connected socket may outlive a partner's decision to revoke access.
  // Resolve the current persisted grant set on EVERY replica, not just the
  // replica that processed the administrative change. Do not infer grants from
  // cached subscription state. Bounded by polling interval + database latency.
  const supabaseGrantTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== WebSocket.OPEN || socket.traderPrincipal?.authMethod !== 'SUPABASE') continue;
      void refreshSupabaseSocketPrincipal(socket).catch(() => {});
    }
  }, SUPABASE_GRANT_POLL_MS);
  supabaseGrantTimer.unref?.();

  return {
    health() {
      let accountSubscriptions = 0;
      let quoteSubscriptions = 0;
      let tickSubscriptions = 0;
      let candleSubscriptions = 0;
      for (const socket of wss.clients) {
        const state = subscriptions.get(socket);
        accountSubscriptions += state?.accounts.size || 0;
        quoteSubscriptions += state?.quotes.size || 0;
        tickSubscriptions += state?.ticks.size || 0;
        candleSubscriptions += state?.candles.size || 0;
      }
      return {
        clients: wss.clients.size,
        accountSubscriptions,
        quoteSubscriptions,
        tickSubscriptions,
        candleSubscriptions,
        reconciliation: { queuedSockets: pendingResyncSockets.size, inFlight: resyncWork.size },
        path,
        coalescing: {
          quoteMs: quoteCoalesceMs,
          valuationMs: valuationCoalesceMs,
        },
        egress: {
          messages: egress.messages,
          bytes: egress.bytes,
          megabytes: Number((egress.bytes / (1024 * 1024)).toFixed(3)),
          droppedLossy: egress.droppedLossy,
          closedSlowClients: egress.closedSlowClients,
          byType: Object.fromEntries(
            [...egress.byType.entries()].map(([type, value]) => [
              type,
              {
                messages: value.messages,
                bytes: value.bytes,
                megabytes: Number((value.bytes / (1024 * 1024)).toFixed(3)),
              },
            ]),
          ),
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(resyncTimer);
      pendingResyncSockets.clear();
      clearInterval(heartbeatTimer);
      clearInterval(supabaseGrantTimer);
      server.off('upgrade', upgradeHandler);
      runtime.eventBus.off('market.quote', broadcastQuote);
      runtime.eventBus.off('market.tick', broadcastTick);
      runtime.eventBus.off('market.candle.update', broadcastCandleUpdate);
      runtime.eventBus.off('market.candle.closed', broadcastCandleClosed);
      runtime.eventBus.off('market.candle.corrected', broadcastCandleCorrected);
      runtime.eventBus.off('market.status', broadcastStatus);
      runtime.eventBus.off('trading.account.reconciled', onAccountReconciled);
      for (const [sourceEvent, listener] of tradingListeners) runtime.eventBus.off(sourceEvent, listener);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
      await Promise.allSettled([...resyncWork]);
    },
  };
}

function accountIdFromPayload(payload) {
  const value = payload?.accountId
    ?? payload?.account?.accountId
    ?? payload?.account?.id
    ?? payload?.order?.accountId
    ?? payload?.fill?.accountId
    ?? payload?.position?.accountId
    ?? payload?.id;
  return value == null ? null : String(value);
}

function websocketAccessToken(request) {
  const header = String(request.headers['sec-websocket-protocol'] || '');
  const protocols = header.split(',').map(value => value.trim()).filter(Boolean);
  const authProtocol = protocols.find(value => value.startsWith('auth.'));
  return authProtocol ? authProtocol.slice(5) : null;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function accountGrantDiff(currentValues, desiredValues) {
  const current = currentValues instanceof Set ? currentValues : new Set((currentValues || []).map(String));
  const desired = desiredValues instanceof Set ? desiredValues : new Set((desiredValues || []).map(String));
  return {
    added: [...desired].filter(id => !current.has(id)),
    removed: [...current].filter(id => !desired.has(id)),
  };
}

module.exports = { createMarketWebSocketServer, accountIdFromPayload, websocketAccessToken, accountGrantDiff };
