'use strict';

const express = require('express');
const { AppError } = require('../../shared/errors/app-error');
const { requireTraderSession } = require('../auth/auth.middleware');
const { normalizeSymbol, clampInteger, resolveCandleVolume } = require('./market.utils');

function createMarketRouter(runtime, authService = null) {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json(runtime.health());
  });

  router.get('/quotes', (req, res) => {
    requireEnabled(runtime);
    const requested = String(req.query.symbols || '')
      .split(',')
      .map(normalizeSymbol)
      .filter(Boolean);
    const symbols = requested.length ? [...new Set(requested)] : runtime.symbols;
    validateSymbols(runtime, symbols);

    const quotes = runtime.quoteStore.getMany(symbols);
    const available = new Set(quotes.map(item => item.symbol));
    res.json({
      quotes,
      missing: symbols.filter(symbol => !available.has(symbol)),
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/quote/refresh', authService ? requireTraderSession(authService) : (_req, _res, next) => next(), async (req, res) => {
    requireEnabled(runtime);
    const symbol = normalizeSymbol(req.body?.symbol);
    validateSymbols(runtime, [symbol]);
    const quote = await runtime.ensureFreshQuote(symbol, { reason: 'client-selected-refresh' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      symbol,
      quote,
      recovered: Boolean(quote && quote.isStale !== true),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/candles', async (req, res) => {
    requireEnabled(runtime);
    const symbol = normalizeSymbol(req.query.symbol);
    const timeframe = String(req.query.timeframe || '').toLowerCase();
    const limit = clampInteger(req.query.limit, 1, 1000, 160);
    const beforeMs = parseOptionalHistoryCursor(req.query.before);

    validateSymbols(runtime, [symbol]);
    if (!runtime.timeframes.includes(timeframe)) {
      throw new AppError(`Unsupported timeframe: ${timeframe || '(missing)'}`, {
        statusCode: 400,
        code: 'INVALID_TIMEFRAME',
        details: { supported: runtime.timeframes },
      });
    }

    const page = await runtime.historyService.getCandlePage({ symbol, timeframe, limit, beforeMs });
    const history = page.candles;
    let candles = history;
    let hasMore = page.hasMore;

    // Historical pagination is intentionally detached from the live candle.
    // Older pages must be stable, non-overlapping provider history. Only the
    // latest page inherits the active volume mode and merges the live bucket.
    if (beforeMs == null) {
      const historyVolumeMode = history[history.length - 1]?.volumeMode || null;
      if (historyVolumeMode) runtime.candleEngine.setVolumeMode?.(symbol, timeframe, historyVolumeMode);
      let current = runtime.candleEngine.getCurrent(symbol, timeframe);

      if (current) {
        const last = history[history.length - 1];
        if (last?.openTimeMs === current.openTimeMs) {
          runtime.candleEngine.reconcileCurrentVolume?.(symbol, timeframe, last);
          current = runtime.candleEngine.getCurrent(symbol, timeframe) || current;
          candles = [...history.slice(0, -1), mergeCurrentCandle(last, current)];
        } else {
          const inheritedMode = last?.volumeMode || null;
          if (inheritedMode) current = applyVolumeMode(current, inheritedMode);
          candles = [...history, current];
        }
      }

      if (candles.length > limit) {
        hasMore = true;
        candles = candles.slice(candles.length - limit);
      }
    }

    const nextBefore = candles.length ? Number(candles[0].openTimeMs) : page.nextBefore;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      symbol,
      timeframe,
      volumeMode: candles[0]?.volumeMode || null,
      candles,
      pagination: {
        hasMore: Boolean(hasMore && Number.isFinite(nextBefore)),
        nextBefore: Number.isFinite(nextBefore) ? nextBefore : null,
        limit,
      },
    });
  });

  return router;
}

function parseOptionalHistoryCursor(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new AppError('Invalid candle history cursor', {
      statusCode: 400,
      code: 'INVALID_HISTORY_CURSOR',
    });
  }
  return Math.trunc(numeric);
}

function requireEnabled(runtime) {
  if (!runtime.enabled) {
    throw new AppError('Market gateway is disabled', {
      statusCode: 503,
      code: 'MARKET_GATEWAY_DISABLED',
    });
  }
}

function validateSymbols(runtime, symbols) {
  const invalid = symbols.filter(symbol => !symbol || !runtime.symbols.includes(symbol));
  if (invalid.length) {
    throw new AppError('One or more market symbols are not configured', {
      statusCode: 400,
      code: 'INVALID_MARKET_SYMBOL',
      details: { invalid, available: runtime.symbols },
    });
  }
}

function applyVolumeMode(candle, volumeMode) {
  const carriesAuthoritativeDisplay = candle?.volumeMode === volumeMode
    && Object.prototype.hasOwnProperty.call(candle, 'displayVolume')
    && (candle.volumeSource === volumeMode || candle.volumeSource === 'unavailable');

  if (carriesAuthoritativeDisplay) {
    return { ...candle, volumeMode };
  }

  const resolved = resolveCandleVolume({ ...candle, volumeMode }, volumeMode);
  return {
    ...candle,
    volumeMode,
    displayVolume: resolved.displayVolume,
    volumeSource: resolved.volumeSource,
  };
}

function mergeCurrentCandle(historyBar, currentBar) {
  if (!historyBar) return currentBar;
  if (!currentBar) return historyBar;
  if (Number(historyBar.openTimeMs) !== Number(currentBar.openTimeMs)) return currentBar;

  const numeric = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const historyOpen = numeric(historyBar.open);
  const historyHigh = numeric(historyBar.high);
  const historyLow = numeric(historyBar.low);
  const historyClose = numeric(historyBar.close);
  const currentOpen = numeric(currentBar.open);
  const currentHigh = numeric(currentBar.high);
  const currentLow = numeric(currentBar.low);
  const currentClose = numeric(currentBar.close);
  const volumeMode = currentBar.volumeMode || historyBar.volumeMode || null;

  const highs = [historyHigh, historyOpen, historyClose, currentHigh, currentOpen, currentClose].filter(Number.isFinite);
  const lows = [historyLow, historyOpen, historyClose, currentLow, currentOpen, currentClose].filter(Number.isFinite);

  const merged = {
    ...historyBar,
    ...currentBar,
    open: historyOpen ?? currentOpen,
    high: highs.length ? Math.max(...highs) : (currentHigh ?? historyHigh),
    low: lows.length ? Math.min(...lows) : (currentLow ?? historyLow),
    close: currentClose ?? historyClose,
    tickCount: Number(currentBar.tickCount || historyBar.tickCount || 0),
    providerVolume: currentBar.providerVolume ?? historyBar.providerVolume ?? null,
    complete: false,
    synthetic: Boolean(currentBar.synthetic && historyBar.synthetic),
    source: 'LIVE_MERGED',
    provider: currentBar.provider || historyBar.provider || null,
  };
  return applyVolumeMode(merged, volumeMode);
}

module.exports = { createMarketRouter, mergeCurrentCandle, applyVolumeMode, parseOptionalHistoryCursor };
